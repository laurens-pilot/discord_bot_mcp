import assert from "node:assert/strict";
import test from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { Discord } from "../src/discord.mjs";
import { createServer } from "../src/server.mjs";

const serverId = "123456789012345678";
const channelId = "234567890123456789";
const messageId = "345678901234567890";
const threadId = "456789012345678901";
const token = "fake-token-must-never-be-in-tool-results";
const message = {
  id: messageId,
  channel_id: channelId,
  author: { id: "567890123456789012", username: "alex", global_name: "Alex" },
  timestamp: "2026-09-25T10:00:00Z",
  content: "Hello from Discord",
  attachments: [],
  embeds: [],
};

async function session(t, handler) {
  const calls = [];
  const discord = new Discord(token, async (url, options) => {
    const path =
      new URL(url).pathname.replace("/api/v10", "") + new URL(url).search;
    const call = {
      path,
      method: options.method,
      body: options.body ? JSON.parse(options.body) : undefined,
    };
    calls.push(call);
    const result = await handler(call);
    return result instanceof Response
      ? result
      : new Response(JSON.stringify(result));
  });
  const server = createServer(discord);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  t.after(async () => {
    await client.close();
    await server.close();
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    calls,
    call: async (name, args = {}) => {
      const result = await client.callTool({ name, arguments: args });
      assert.ok(!result.isError, JSON.stringify(result));
      return JSON.parse(result.content[0].text);
    },
  };
}

test("exactly four compact tools with correct read/write annotations", async (t) => {
  const { client, calls } = await session(t, () => {
    throw new Error("No network during discovery");
  });
  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map(({ name }) => name),
    ["list_servers", "list_channels", "read_messages", "send_message"],
  );
  assert.deepEqual(
    tools.map(({ annotations }) => annotations.readOnlyHint),
    [true, true, true, false],
  );
  assert.equal(tools[3].annotations.idempotentHint, false);
  const size = Buffer.byteLength(JSON.stringify(tools));
  assert.ok(size < 4000, `Tool catalog grew to ${size} bytes`);
  t.diagnostic(`Four-tool catalog: ${size} JSON bytes`);
  assert.equal(calls.length, 0);
});

test("server listing is compact and paginates without dropping a full page", async (t) => {
  const { call, calls } = await session(t, ({ path }) =>
    path.includes("after=")
      ? []
      : Array.from({ length: 100 }, (_, i) => ({
          id: String(BigInt(serverId) + BigInt(i)),
          name: `Server ${i}`,
          unused: "discard",
        })),
  );
  const result = await call("list_servers");
  assert.equal(result.servers.length, 100);
  assert.equal(result.next_after, String(BigInt(serverId) + 99n));
  assert.deepEqual(Object.keys(result.servers[0]), ["id", "name"]);
  assert.deepEqual(await call("list_servers", { after: result.next_after }), {
    servers: [],
    next_after: null,
  });
  assert.equal(
    calls[1].path,
    `/users/@me/guilds?limit=100&after=${result.next_after}`,
  );
});

test("channel discovery includes active forum posts and their parents", async (t) => {
  const { call, calls } = await session(t, ({ path }) =>
    path.endsWith("/threads/active")
      ? {
          threads: [
            { id: threadId, name: "Post", type: 11, parent_id: channelId },
          ],
        }
      : [{ id: channelId, name: "forum", type: 15, parent_id: null }],
  );
  assert.deepEqual(await call("list_channels", { server_id: serverId }), {
    channels: [
      { id: channelId, name: "forum", type: "forum" },
      {
        id: threadId,
        name: "Post",
        type: "public_thread",
        parent_id: channelId,
      },
    ],
  });
  assert.deepEqual(
    calls.map(({ path }) => path),
    [`/guilds/${serverId}/channels`, `/guilds/${serverId}/threads/active`],
  );
});

test("history defaults, exact-message reads, and older-page cursors reach the right endpoints", async (t) => {
  const { call, calls } = await session(t, ({ path }) =>
    path.includes("?") ? [message] : message,
  );
  const first = await call("read_messages", { channel_id: channelId });
  assert.equal(first.next_before, null);
  assert.equal(first.messages[0].content, message.content);
  assert.equal(calls[0].path, `/channels/${channelId}/messages?limit=20`);
  const full = await call("read_messages", {
    channel_id: channelId,
    limit: 1,
    before: messageId,
  });
  assert.equal(full.next_before, messageId);
  assert.equal(
    calls[1].path,
    `/channels/${channelId}/messages?limit=1&before=${messageId}`,
  );
  await call("read_messages", { channel_id: channelId, message_id: messageId });
  assert.equal(calls[2].path, `/channels/${channelId}/messages/${messageId}`);
});

test("message summaries preserve useful content without dumping the full Discord payload", async (t) => {
  const { call } = await session(t, () => [
    {
      ...message,
      type: 19,
      message_reference: { message_id: messageId },
      thread: { id: threadId },
      attachments: [
        {
          filename: "log.txt",
          url: "https://cdn.discordapp.com/log.txt",
          size: 999,
        },
      ],
      embeds: [
        {
          title: "Title",
          description: "Details",
          fields: [{ name: "Status", value: "Ready" }],
          image: { url: "https://example.com/picture.png" },
          provider: { name: "Unused" },
        },
      ],
      unused: "discard",
    },
  ]);
  const result = (await call("read_messages", { channel_id: channelId }))
    .messages[0];
  assert.deepEqual(result.author, { id: message.author.id, name: "Alex" });
  assert.equal(result.thread_id, threadId);
  assert.deepEqual(result.attachments, [
    { filename: "log.txt", url: "https://cdn.discordapp.com/log.txt" },
  ]);
  assert.equal(result.embeds[0].image_url, "https://example.com/picture.png");
  assert.equal(result.embeds[0].fields[0].value, "Ready");
  assert.ok(!JSON.stringify(result).includes("Unused"));
  assert.ok(!JSON.stringify(result).includes("discard"));
});

test("sends and replies suppress every mention and preserve text", async (t) => {
  const { call, calls } = await session(t, () => message);
  const content =
    " @everyone <@123456789012345678> <@&234567890123456789> hello\n";
  assert.deepEqual(
    await call("send_message", {
      channel_id: channelId,
      content,
      reply_to: messageId,
    }),
    { id: messageId, channel_id: channelId },
  );
  assert.deepEqual(calls[0], {
    path: `/channels/${channelId}/messages`,
    method: "POST",
    body: {
      content,
      allowed_mentions: { parse: [], replied_user: false },
      message_reference: { message_id: messageId, fail_if_not_exists: true },
    },
  });
  await call("send_message", { channel_id: threadId, content: "hello" });
  assert.equal(calls[1].path, `/channels/${threadId}/messages`);
  assert.ok(!("message_reference" in calls[1].body));
});

test("invalid tool arguments cannot reach Discord", async (t) => {
  const { client, calls } = await session(t, () => message);
  for (const [name, args] of [
    ["read_messages", { channel_id: "../users/@me" }],
    ["read_messages", { channel_id: Number(channelId) }],
    ["read_messages", { channel_id: channelId, limit: 0 }],
    ["read_messages", { channel_id: channelId, limit: 101 }],
    [
      "read_messages",
      { channel_id: channelId, before: messageId, message_id: messageId },
    ],
    ["send_message", { channel_id: channelId, content: "" }],
    ["send_message", { channel_id: channelId, content: " \n " }],
    ["send_message", { channel_id: channelId, content: "x".repeat(2001) }],
    ["send_message", { content: "hello" }],
  ]) {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, true, JSON.stringify(args));
  }
  assert.equal(calls.length, 0);
});

test("Discord failures are MCP tool errors, with no credential leakage", async (t) => {
  const { client } = await session(
    t,
    () => new Response(JSON.stringify({ message: token }), { status: 403 }),
  );
  const result = await client.callTool({
    name: "read_messages",
    arguments: { channel_id: channelId },
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /permissions/);
  assert.ok(!JSON.stringify(result).includes(token));
});
