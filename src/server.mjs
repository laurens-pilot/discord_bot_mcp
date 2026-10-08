import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { DiscordError } from "./discord.mjs";
import { channelAccess, createAccessChecker } from "./access.mjs";
import { uploadBody } from "./uploads.mjs";
import { messageSummary, pollInput, pollBody } from "./messages.mjs";
import { registerFeatures } from "./tools.mjs";
import { id, timestamp, readOnly, write } from "./schema.mjs";

const snowflakeCeiling = 1n << 64n;
const discordEpoch = 1420070400000n;
const channelTypes = {
  0: "text",
  2: "voice",
  4: "category",
  5: "announcement",
  10: "announcement_thread",
  11: "public_thread",
  12: "private_thread",
  13: "stage",
  15: "forum",
  16: "media",
};

function snowflakeAt(timestamp) {
  return (BigInt(Date.parse(timestamp)) - discordEpoch) << 22n;
}

export function createServer(discord, { cache } = {}) {
  const server = new McpServer({ name: "discord-bot-mcp", version: "0.1.0" });
  const register = (
    name,
    description,
    inputSchema,
    handler,
    annotations = readOnly,
  ) => {
    server.registerTool(
      name,
      { description, inputSchema, annotations },
      async (args) => {
        try {
          return {
            content: [
              { type: "text", text: JSON.stringify(await handler(args)) },
            ],
          };
        } catch (error) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text:
                  error instanceof DiscordError
                    ? error.message
                    : "Could not process Discord's response.",
              },
            ],
          };
        }
      },
    );
  };

  register(
    "list_servers",
    "List servers the bot has joined; use next_after for another page.",
    z.object({ after: id.optional() }),
    async ({ after }) => {
      const query = new URLSearchParams({
        limit: "100",
        ...(after ? { after } : {}),
      });
      const servers = await discord.request(`/users/@me/guilds?${query}`);
      return {
        servers: servers.map(({ id, name }) => ({ id, name })),
        next_after: servers.length === 100 ? servers.at(-1).id : null,
      };
    },
  );

  register(
    "list_channels",
    "List server channels and visible active threads. Use a channel/thread id to read or send.",
    z.object({
      server_id: id,
      channel_id: id.optional(),
      include_permissions: z.boolean().default(false),
    }),
    async ({ server_id, channel_id, include_permissions }) => {
      const channels = await discord.request(`/guilds/${server_id}/channels`);
      const { threads } = await discord.request(
        `/guilds/${server_id}/threads/active`,
      );
      const selected = [...channels, ...threads].filter(
        (channel) => !channel_id || channel.id === channel_id,
      );
      const check = createAccessChecker(discord, {
        channels: [...channels, ...threads].map((channel) => ({
          guild_id: server_id,
          ...channel,
        })),
      });
      const permissions = new Map();
      if (include_permissions)
        for (const channel of selected) {
          try {
            permissions.set(channel.id, (await check(channel.id)).capabilities);
          } catch (error) {
            if (![403, 404].includes(error.status)) throw error;
            permissions.set(channel.id, { view: false });
          }
        }
      return {
        channels: selected.map(({ id, name, type, parent_id }) => ({
          id,
          name,
          type: channelTypes[type] ?? type,
          ...(parent_id ? { parent_id } : {}),
          ...(include_permissions ? { permissions: permissions.get(id) } : {}),
        })),
      };
    },
  );

  register(
    "read_messages",
    "Read newest first; since/until bound creation time. Page with next_before and the same bounds, or fetch message_id. Without history permission, returns observed cache only; check coverage.",
    z.object({
      channel_id: id,
      limit: z.number().int().min(1).max(100).default(20),
      before: id.optional(),
      message_id: id.optional(),
      since: timestamp
        .describe(
          "Inclusive start: ISO 8601 with timezone, up to milliseconds.",
        )
        .optional(),
      until: timestamp
        .describe("Exclusive end: ISO 8601 with timezone, up to milliseconds.")
        .optional(),
    }),
    async ({ channel_id, limit, before, message_id, since, until }) => {
      if (message_id && (before || since || until))
        throw new DiscordError(
          "message_id cannot be combined with before, since, or until.",
        );
      const start = since ? snowflakeAt(since) : undefined;
      const end = until ? snowflakeAt(until) : undefined;
      if (start !== undefined && end !== undefined && start >= end)
        throw new DiscordError("since must be earlier than until.");
      const lower = start ?? 0n;
      let upper = before ? BigInt(before) : snowflakeCeiling;
      if (end !== undefined && end < upper) upper = end;
      if (cache && !(await channelAccess(discord, channel_id)).history) {
        const result = cache.read(channel_id, {
          message_id,
          lower,
          upper,
          limit,
        });
        return { ...result, messages: result.messages.map(messageSummary) };
      }
      if (message_id)
        return {
          messages: [
            messageSummary(
              await discord.request(
                `/channels/${channel_id}/messages/${message_id}`,
              ),
            ),
          ],
        };
      if (upper <= lower) return { messages: [], next_before: null };
      const query = new URLSearchParams({
        limit: String(limit),
        ...(before || upper < snowflakeCeiling
          ? { before: String(upper) }
          : {}),
      });
      const messages = await discord.request(
        `/channels/${channel_id}/messages?${query}`,
      );
      const inRange = messages.filter(
        ({ id }) => BigInt(id) >= lower && BigInt(id) < upper,
      );
      return {
        messages: inRange.map(messageSummary),
        next_before:
          messages.length === limit && BigInt(messages.at(-1).id) > lower
            ? messages.at(-1).id
            : null,
      };
    },
  );

  register(
    "send_message",
    "Send text and/or local files as the bot; optionally reply. Silent by default; mentions never ping. No automatic retries.",
    z.object({
      channel_id: id,
      content: z
        .string()
        .min(1)
        .max(2000)
        .refine(
          (value) => value.trim().length > 0,
          "Message must not be blank.",
        )
        .optional(),
      reply_to: id.optional(),
      files: z
        .array(z.string().min(1))
        .min(1)
        .max(10)
        .describe("Absolute file paths; 24 MiB total maximum.")
        .optional(),
      silent: z.boolean().default(true),
      suppress_embeds: z
        .boolean()
        .default(false)
        .describe("Hide link previews while keeping links clickable."),
      poll: pollInput.optional(),
    }),
    async ({
      channel_id,
      content,
      reply_to,
      files,
      silent,
      suppress_embeds,
      poll,
    }) => {
      if (!content && !files?.length && !poll)
        throw new DiscordError("Provide content, files or a poll.");
      const flags = (silent ? 4096 : 0) | (suppress_embeds ? 4 : 0);
      const body = await uploadBody(
        {
          ...(content ? { content } : {}),
          ...(flags ? { flags } : {}),
          allowed_mentions: { parse: [], replied_user: false },
          ...(poll ? { poll: pollBody(poll) } : {}),
          ...(reply_to
            ? {
                message_reference: {
                  message_id: reply_to,
                  fail_if_not_exists: true,
                },
              }
            : {}),
        },
        files,
      );
      const message = await discord.request(
        `/channels/${channel_id}/messages`,
        body,
      );
      if (message?.channel_id !== channel_id)
        throw new DiscordError(
          "Unexpected send response. Delivery is uncertain; check the channel before sending again.",
        );
      return {
        id: message.id,
        channel_id: message.channel_id,
        ...features.rememberSent(message),
      };
    },
    write,
  );

  register(
    "create_thread",
    "Create a public thread in a text channel, or on message_id in text/announcement channels. Use thread_id to read/send. Creation has no silent flag. No retries.",
    z.strictObject({
      channel_id: id,
      name: z
        .string()
        .min(1)
        .max(100)
        .refine(
          (value) => value.trim().length > 0,
          "Thread name must not be blank.",
        ),
      message_id: id.optional(),
    }),
    async ({ channel_id, name, message_id }) => {
      const channel = await discord.request(`/channels/${channel_id}`);
      if (!channel.guild_id || ![0, 5].includes(channel.type))
        throw new DiscordError(
          "Use a server text or announcement channel as the parent. Forum posts and private threads are not supported.",
        );
      if (channel.type === 5 && !message_id)
        throw new DiscordError(
          "Announcement channels require message_id to start a thread.",
        );
      const thread = await discord.request(
        message_id
          ? `/channels/${channel_id}/messages/${message_id}/threads`
          : `/channels/${channel_id}/threads`,
        { name, ...(!message_id ? { type: 11 } : {}) },
      );
      if (!id.safeParse(thread?.id).success || thread?.parent_id !== channel_id)
        throw new DiscordError(
          "Discord returned an unexpected thread response. Thread creation is uncertain; use list_channels to check before trying again.",
        );
      return { thread_id: thread.id, parent_id: thread.parent_id };
    },
    write,
  );

  const features = registerFeatures(register, discord, cache);
  return server;
}
