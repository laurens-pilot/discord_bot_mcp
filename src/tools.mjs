import * as z from "zod/v4";
import { DiscordError } from "./discord.mjs";
import { createAccessChecker } from "./access.mjs";
import {
  id,
  page,
  nonblank,
  queryString,
  write,
  destructive,
} from "./schema.mjs";
import { messageSummary } from "./messages.mjs";
import { searchInput, searchMessages } from "./search.mjs";

const target = { channel_id: id, message_id: id };
const cursorTime = z.iso.datetime({ offset: true });
const emoji = nonblank(100).describe(
  "Unicode emoji or name:id; <:name:id> also accepted.",
);
const encodedEmoji = (value) =>
  encodeURIComponent(value.replace(/^<a?:([^>]+)>$/, "$1"));
const users = (values) =>
  values.map((user) => ({
    id: user.id,
    name: user.global_name || user.username,
  }));

export function registerFeatures(register, discord, cache) {
  const sent = new Map();
  const syncCache = (operation) => {
    try {
      operation();
      return {};
    } catch {
      return {
        cache_warning:
          "Discord confirmed the change, but the local cache could not be updated. Do not repeat the write.",
      };
    }
  };
  const rememberSent = (message) => {
    if (
      !id.safeParse(message?.id).success ||
      !id.safeParse(message?.channel_id).success
    )
      throw new DiscordError(
        "Discord returned an unexpected message response. Delivery is uncertain; check the channel before sending again.",
      );
    sent.set(`${message.channel_id}:${message.id}`, Date.now());
    if (sent.size > 5000) sent.delete(sent.keys().next().value);
    return syncCache(() => cache?.rememberSent(message.channel_id, message.id));
  };
  const history = async (channelId) => {
    const access = await createAccessChecker(discord)(channelId);
    if (!access.history)
      throw new DiscordError(
        "This operation requires Read Message History in this channel.",
      );
    return access;
  };
  const own = async ({ channel_id, message_id }) => {
    const access = await createAccessChecker(discord)(channel_id);
    let author;
    if (access.history) {
      const message = await discord.request(
        `/channels/${channel_id}/messages/${message_id}`,
      );
      if (message.id !== message_id || message.channel_id !== channel_id)
        throw new DiscordError("Could not verify message ownership.");
      author = message.author?.id;
    } else {
      const receipt = sent.get(`${channel_id}:${message_id}`);
      if (
        (receipt && Date.now() - receipt < 7 * 86400000) ||
        cache?.wasSent(channel_id, message_id)
      )
        return;
      author = cache?.read(channel_id, { message_id }).messages[0]?.author?.id;
    }
    if (author !== access.bot_id)
      throw new DiscordError(
        "Only the bot's own messages can be changed. Ownership could not be verified from Discord or the local cache/send receipts.",
      );
  };

  register(
    "list_emojis",
    "List server custom emojis, optionally by exact name (:name: accepted, case-insensitive). Returns reaction/message formats. Availability is not a permission guarantee.",
    z.strictObject({ server_id: id, name: nonblank(100).optional() }),
    async ({ server_id, name }) => {
      const result = await discord.request(`/guilds/${server_id}/emojis`);
      if (!Array.isArray(result))
        throw new DiscordError("Discord returned an unexpected emoji list.");
      const match = name
        ?.trim()
        .replace(/^:([^:]+):$/, "$1")
        .toLowerCase();
      return {
        emojis: result
          .filter((item) => !match || item.name?.toLowerCase() === match)
          .map((item) => ({
            id: item.id,
            name: item.name,
            animated: Boolean(item.animated),
            ...(typeof item.available === "boolean"
              ? { available: item.available }
              : {}),
            ...(item.roles?.length ? { role_ids: item.roles } : {}),
            reaction: `${item.name}:${item.id}`,
            message: `<${item.animated ? "a" : ""}:${item.name}:${item.id}>`,
          })),
      };
    },
  );

  register(
    "search_messages",
    "Search server messages. All Discord filters supported; author_type/has allow -negation. since/until are inclusive/exclusive. Page with next_offset. source=cache searches retained literal text/channel/author/time only; check coverage.",
    searchInput,
    (args) => searchMessages(discord, cache, args),
  );

  register(
    "edit_message",
    "Edit text on the bot's own message; attachments stay. Empty content clears text. Mentions never ping. No retries.",
    z.strictObject({ ...target, content: z.string().max(2000) }),
    async (args) => {
      await own(args);
      const message = await discord.request(
        `/channels/${args.channel_id}/messages/${args.message_id}`,
        {
          content: args.content,
          allowed_mentions: { parse: [], replied_user: false },
        },
        "PATCH",
      );
      if (
        message?.id !== args.message_id ||
        message?.channel_id !== args.channel_id
      )
        throw new DiscordError(
          "Unexpected edit response. The change is uncertain; check the message before trying again.",
        );
      const status = syncCache(() =>
        cache?.capture({ t: "MESSAGE_UPDATE", d: message }),
      );
      return { id: message.id, channel_id: message.channel_id, ...status };
    },
    destructive,
  );

  register(
    "delete_message",
    "Delete only the bot's own message after verifying ownership. No retries.",
    z.strictObject(target),
    async (args) => {
      await own(args);
      await discord.request(
        `/channels/${args.channel_id}/messages/${args.message_id}`,
        undefined,
        "DELETE",
      );
      sent.delete(`${args.channel_id}:${args.message_id}`);
      return {
        deleted: true,
        ...args,
        ...syncCache(() =>
          cache?.capture({
            t: "MESSAGE_DELETE",
            d: { id: args.message_id, channel_id: args.channel_id },
          }),
        ),
      };
    },
    destructive,
  );

  register(
    "list_threads",
    "List archived public threads/posts in a parent channel. Requires history permission. Page with next_before (archive timestamp). Active threads: list_channels.",
    z.strictObject({
      channel_id: id,
      before: cursorTime.optional(),
      limit: z.number().int().min(2).max(100).default(25),
    }),
    async ({ channel_id, before, limit }) => {
      const { channel } = await history(channel_id);
      if (![0, 5, 15, 16].includes(channel.type))
        throw new DiscordError(
          "Use a text, announcement, forum or media parent channel.",
        );
      const result = await discord.request(
        `/channels/${channel_id}/threads/archived/public?${queryString({ before, limit })}`,
      );
      const threads = result.threads.map((thread) => ({
        id: thread.id,
        name: thread.name,
        parent_id: thread.parent_id,
        archived: thread.thread_metadata?.archived,
        locked: thread.thread_metadata?.locked,
        archived_at: thread.thread_metadata?.archive_timestamp,
      }));
      const cursor = result.threads.at(-1)?.thread_metadata?.archive_timestamp;
      if (result.has_more && !cursor)
        throw new DiscordError(
          "Discord returned archived threads without a usable pagination cursor.",
        );
      return { threads, next_before: result.has_more ? cursor : null };
    },
  );

  register(
    "list_pins",
    "Read pinned messages, newest pin first. Requires history permission. Page with next_before (pin timestamp).",
    z.strictObject({
      channel_id: id,
      before: cursorTime.optional(),
      limit: z.number().int().min(1).max(50).default(25),
    }),
    async ({ channel_id, before, limit }) => {
      await history(channel_id);
      const result = await discord.request(
        `/channels/${channel_id}/messages/pins?${queryString({ before, limit })}`,
      );
      const cursor = result.items.at(-1)?.pinned_at;
      if (result.has_more && !cursor)
        throw new DiscordError(
          "Discord returned pins without a usable pagination cursor.",
        );
      return {
        messages: result.items.map((item) => ({
          ...messageSummary(item.message),
          pinned_at: item.pinned_at,
        })),
        next_before: result.has_more ? cursor : null,
      };
    },
  );

  register(
    "set_reaction",
    "Add an emoji reaction, or remove the bot's own reaction. Adding requires history permission. Reactions have no silent flag. No retries.",
    z.strictObject({ ...target, emoji, remove: z.boolean().default(false) }),
    async ({ channel_id, message_id, emoji, remove }) => {
      if (remove) await createAccessChecker(discord)(channel_id);
      else await history(channel_id);
      await discord.request(
        `/channels/${channel_id}/messages/${message_id}/reactions/${encodedEmoji(emoji)}/@me`,
        undefined,
        remove ? "DELETE" : "PUT",
      );
      return { channel_id, message_id, emoji, removed: remove };
    },
    { ...write, idempotentHint: true },
  );

  register(
    "list_reaction_users",
    "List users for an emoji reaction; burst selects super reactions. Page with next_after.",
    z.strictObject({
      ...target,
      emoji,
      burst: z.boolean().default(false),
      ...page,
    }),
    async ({ channel_id, message_id, emoji, burst, after, limit }) => {
      await createAccessChecker(discord)(channel_id);
      const result = await discord.request(
        `/channels/${channel_id}/messages/${message_id}/reactions/${encodedEmoji(emoji)}?${queryString({ type: burst ? 1 : 0, after, limit })}`,
      );
      return {
        users: users(result),
        next_after: result.length === limit ? result.at(-1).id : null,
      };
    },
  );

  register(
    "list_poll_voters",
    "List voters for a poll answer ID from read_messages. Page with next_after. Bots cannot vote.",
    z.strictObject({ ...target, answer_id: z.number().int().min(1), ...page }),
    async ({ channel_id, message_id, answer_id, after, limit }) => {
      await createAccessChecker(discord)(channel_id);
      const result = await discord.request(
        `/channels/${channel_id}/polls/${message_id}/answers/${answer_id}?${queryString({ after, limit })}`,
      );
      return {
        users: users(result.users),
        next_after:
          result.users.length === limit ? result.users.at(-1).id : null,
      };
    },
  );

  register(
    "end_poll",
    "End a poll created by the bot, after verifying ownership. Returns its message and available results. No retries.",
    z.strictObject(target),
    async (args) => {
      await own(args);
      const message = await discord.request(
        `/channels/${args.channel_id}/polls/${args.message_id}/expire`,
        undefined,
        "POST",
      );
      if (
        message?.id !== args.message_id ||
        message?.channel_id !== args.channel_id
      )
        throw new DiscordError(
          "Unexpected poll response. The change is uncertain; check the poll before trying again.",
        );
      return {
        ...messageSummary(message),
        ...syncCache(() => cache?.capture({ t: "MESSAGE_UPDATE", d: message })),
      };
    },
    destructive,
  );

  return { rememberSent };
}
