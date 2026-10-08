import * as z from "zod/v4";
import { DiscordError } from "./discord.mjs";
import { createAccessChecker } from "./access.mjs";
import { id, timestamp, queryString } from "./schema.mjs";
import { messageSummary } from "./messages.mjs";

const ids = (max) => z.array(id).min(1).max(max).optional();
const strings = (max) =>
  z.array(z.string().min(1).max(max)).min(1).max(100).optional();
const negatable = (values) =>
  z
    .array(z.enum([...values, ...values.map((value) => `-${value}`)]))
    .min(1)
    .max(values.length * 2)
    .optional();
export const searchInput = z.strictObject({
  server_id: id,
  content: z.string().min(1).max(1024).optional(),
  channel_id: ids(500),
  author_id: ids(100),
  since: timestamp.optional(),
  until: timestamp.optional(),
  source: z.enum(["discord", "cache"]).default("discord"),
  limit: z.number().int().min(1).max(25).default(25),
  offset: z.number().int().min(0).max(9975).default(0),
  min_id: id.optional(),
  max_id: id.optional(),
  slop: z.number().int().min(0).max(100).optional(),
  author_type: negatable(["user", "bot", "webhook"]),
  mentions: ids(100),
  mentions_role_id: ids(100),
  mention_everyone: z.boolean().optional(),
  replied_to_user_id: ids(100),
  replied_to_message_id: ids(100),
  pinned: z.boolean().optional(),
  has: negatable([
    "image",
    "sound",
    "video",
    "file",
    "sticker",
    "embed",
    "link",
    "poll",
    "snapshot",
  ]),
  embed_type: z
    .array(z.enum(["image", "video", "gif", "sound", "article"]))
    .min(1)
    .max(5)
    .optional(),
  embed_provider: strings(256),
  link_hostname: strings(256),
  attachment_filename: strings(1024),
  attachment_extension: strings(256),
  sort_by: z.enum(["timestamp", "relevance"]).optional(),
  sort_order: z.enum(["asc", "desc"]).optional(),
  include_nsfw: z.boolean().optional(),
});

const ceiling = 1n << 64n;
const at = (value) => (BigInt(Date.parse(value)) - 1420070400000n) << 22n;

function searchQuery(args) {
  const { server_id, source, since, until, ...query } = args;
  if (since && until && Date.parse(since) >= Date.parse(until))
    throw new DiscordError("since must be earlier than until.");
  let lower = query.min_id === undefined ? -1n : BigInt(query.min_id);
  let upper = query.max_id === undefined ? ceiling : BigInt(query.max_id);
  if (since) lower = lower > at(since) - 1n ? lower : at(since) - 1n;
  if (until) upper = upper < at(until) ? upper : at(until);
  lower = lower < -1n ? -1n : lower;
  upper = upper > ceiling ? ceiling : upper;
  if (lower >= ceiling || upper <= 0n || upper <= lower + 1n)
    return { server_id, source, query, empty: true };
  if (lower >= 0n) query.min_id = String(lower);
  else delete query.min_id;
  if (upper < ceiling) query.max_id = String(upper);
  else delete query.max_id;
  return { server_id, source, query, empty: false };
}

export async function searchMessages(discord, cache, args) {
  const { server_id, source, query, empty } = searchQuery(args);
  if (source === "cache")
    return searchCache(discord, cache, server_id, query, empty);
  const coverage = {
    source: "discord_search",
    note: "Indexed messages with history access only. Totals may change. Use source=cache for locally observed messages; narrow channel/time filters beyond Discord's 10,000-result window.",
  };
  if (empty)
    return { messages: [], total_results: 0, next_offset: null, coverage };
  const result = await discord.request(
    `/guilds/${server_id}/messages/search?${queryString(query)}`,
  );
  if (result.code === 110000)
    return {
      indexing: true,
      retry_after: Number.isFinite(result.retry_after)
        ? Math.max(1, result.retry_after)
        : 2,
      coverage,
    };
  if (
    !Array.isArray(result.messages) ||
    !Number.isInteger(result.total_results)
  )
    throw new DiscordError("Discord returned an unexpected search response.");
  const messages = [
    ...new Map(
      result.messages
        .flat()
        .filter((message) => message.hit !== false)
        .map((message) => [message.id, message]),
    ).values(),
  ];
  const next = query.offset + query.limit;
  const hasMore = next < result.total_results;
  return {
    messages: messages.map(messageSummary),
    total_results: result.total_results,
    next_offset: hasMore && next <= 9975 ? next : null,
    ...(hasMore && next > 9975 ? { truncated: true } : {}),
    ...(result.doing_deep_historical_index ? { indexing: true } : {}),
    ...(result.threads?.length
      ? {
          threads: result.threads.map(({ id, name, parent_id }) => ({
            id,
            name,
            parent_id,
          })),
        }
      : {}),
    coverage,
  };
}

async function searchCache(discord, cache, serverId, query, empty) {
  if (!cache) throw new DiscordError("The message cache is unavailable.");
  const supported = new Set([
    "content",
    "channel_id",
    "author_id",
    "min_id",
    "max_id",
    "limit",
    "offset",
    "sort_by",
    "sort_order",
    "include_nsfw",
  ]);
  const unsupported = Object.keys(query).filter((name) => !supported.has(name));
  if (unsupported.length || query.sort_by === "relevance")
    throw new DiscordError(
      "Cache search supports literal text, channel_id, author_id, time/ID bounds and timestamp sorting only. Advanced filters and relevance require source=discord.",
    );
  const bot = await discord.identity();
  await discord.request(`/guilds/${serverId}/members/${bot.id}`);
  let check;
  const access = new Map();
  const matches = [];
  for (const message of empty ? [] : cache.serverMessages(serverId)) {
    if (query.channel_id && !query.channel_id.includes(message.channel_id))
      continue;
    if (query.author_id && !query.author_id.includes(message.author.id))
      continue;
    if (query.min_id && BigInt(message.id) <= BigInt(query.min_id)) continue;
    if (query.max_id && BigInt(message.id) >= BigInt(query.max_id)) continue;
    if (
      query.content &&
      ![
        message.content ?? "",
        ...(message.message_snapshots ?? []).map(
          (snapshot) => snapshot.message.content ?? "",
        ),
      ]
        .join("\n")
        .toLowerCase()
        .includes(query.content.toLowerCase())
    )
      continue;
    if (!check) {
      const channels = await discord.request(`/guilds/${serverId}/channels`);
      check = createAccessChecker(discord, {
        bot,
        channels: channels.map((channel) => ({
          guild_id: serverId,
          ...channel,
        })),
      });
    }
    if (!access.has(message.channel_id)) {
      try {
        access.set(message.channel_id, await check(message.channel_id));
      } catch (error) {
        if (![403, 404].includes(error.status)) throw error;
        access.set(message.channel_id, null);
      }
    }
    const current = access.get(message.channel_id);
    if (
      !current ||
      current.channel.guild_id !== serverId ||
      (current.nsfw && !query.include_nsfw)
    )
      continue;
    matches.push(message);
  }
  matches.sort((a, b) => {
    const order =
      BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0;
    return query.sort_order === "asc" ? order : -order;
  });
  const next = query.offset + query.limit;
  return {
    messages: matches.slice(query.offset, next).map(messageSummary),
    total_results: matches.length,
    next_offset: next < matches.length ? next : null,
    coverage: {
      ...cache.coverage(),
      matching:
        "Case-insensitive literal substring; totals cover only retained, currently accessible messages.",
    },
  };
}
