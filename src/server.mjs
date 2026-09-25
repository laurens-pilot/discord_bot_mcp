import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { DiscordError } from "./discord.mjs";

const id = z.string().regex(/^[0-9]{17,20}$/);
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

export function createServer(discord) {
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
    "Read channel/thread messages, newest first. Use next_before for older messages, or message_id for one message.",
    z.object({
      channel_id: id,
      limit: z.number().int().min(1).max(100).default(20),
      before: id.optional(),
      message_id: id.optional(),
    }),
    async ({ channel_id, limit, before, message_id }) => {
      if (message_id && before)
        throw new DiscordError("Use message_id or before, not both.");
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
      const query = new URLSearchParams({
        limit: String(limit),
        ...(before ? { before } : {}),
      });
      const messages = await discord.request(
        `/channels/${channel_id}/messages?${query}`,
      );
      return {
        messages: messages.map(messageSummary),
        next_before: messages.length === limit ? messages.at(-1).id : null,
      };
    },
  );

  register(
    "send_message",
    "Send text as the bot to a channel/thread; optionally reply. Mentions never ping. No automatic retries.",
    z.object({
      channel_id: id,
      content: z
        .string()
        .min(1)
        .max(2000)
        .refine(
          (value) => value.trim().length > 0,
          "Message must not be blank.",
        ),
      reply_to: id.optional(),
    }),
    async ({ channel_id, content, reply_to }) => {
      const message = await discord.request(
        `/channels/${channel_id}/messages`,
        {
          content,
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
