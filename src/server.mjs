import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { DiscordError } from "./discord.mjs";
import { channelAccess } from "./access.mjs";
import { uploadBody } from "./uploads.mjs";

const id = z.string().regex(/^[0-9]{1,20}$/);
const timestamp = z.iso
  .datetime({ offset: true })
  .refine(
    (value) => Number.isFinite(Date.parse(value)) && !/\.\d{4}/.test(value),
    "Use a valid timestamp with at most three fractional second digits.",
  );
const snowflakeCeiling = 1n << 64n;
const discordEpoch = 1420070400000n;
const readOnly = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};
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

function messageSummary(message) {
  return {
    id: message.id,
    author: {
      id: message.author.id,
      name: message.author.global_name || message.author.username,
    },
    timestamp: message.timestamp,
    content: message.content,
    ...(message.type ? { type: message.type } : {}),
    ...(message.message_reference
      ? { reference: message.message_reference }
      : {}),
    ...(message.thread ? { thread_id: message.thread.id } : {}),
    ...(message.attachments?.length
      ? {
          attachments: message.attachments.map(
            ({ filename, url, content_type }) => ({
              filename,
              url,
              content_type,
            }),
          ),
        }
      : {}),
    ...(message.embeds?.length
      ? {
          embeds: message.embeds.map(
            ({ title, description, url, fields, image }) => ({
              title,
              description,
              url,
              fields,
              ...(image?.url ? { image_url: image.url } : {}),
            }),
          ),
        }
      : {}),
  };
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
    z.object({ server_id: id }),
    async ({ server_id }) => {
      const channels = await discord.request(`/guilds/${server_id}/channels`);
      const { threads } = await discord.request(
        `/guilds/${server_id}/threads/active`,
      );
      return {
        channels: [...channels, ...threads].map(
          ({ id, name, type, parent_id }) => ({
            id,
            name,
            type: channelTypes[type] ?? type,
            ...(parent_id ? { parent_id } : {}),
          }),
        ),
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
    }),
    async ({ channel_id, content, reply_to, files, silent }) => {
      if (!content && !files?.length)
        throw new DiscordError("Provide content or files.");
      const body = await uploadBody(
        {
          ...(content ? { content } : {}),
          ...(silent ? { flags: 4096 } : {}),
          allowed_mentions: { parse: [], replied_user: false },
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
      return { id: message.id, channel_id: message.channel_id };
    },
    {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  );

  return server;
}
