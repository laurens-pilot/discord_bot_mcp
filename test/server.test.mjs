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

test("channel discovery keeps working when the channel-list bucket is exhausted", async (t) => {
  const { call, calls } = await session(t, ({ path }) =>
    path.endsWith("/channels")
      ? Response.json([{ id: channelId, name: "photos", type: 0 }], {
          headers: {
            "X-RateLimit-Bucket": "channel-list",
            "X-RateLimit-Remaining": "0",
            "X-RateLimit-Reset-After": "30",
          },
        })
      : {
          threads: [
            {
              id: threadId,
              name: "Discussion",
              type: 11,
              parent_id: channelId,
            },
          ],
        },
  );
  const result = await call("list_channels", { server_id: serverId });
  assert.deepEqual(
    result.channels.map(({ id }) => id),
    [channelId, threadId],
  );
  assert.equal(calls.length, 2);
});

const rangeMessages = [
  ["1552832004096000007", "2026-09-25T00:00:00Z"],
  ["1552832004096000000", "2026-09-25T00:00:00Z"],
  ["1552832004091805696", "2026-09-24T23:59:59.999Z"],
  ["1552650810163200000", "2026-09-24T12:00:00Z"],
  ["1552469616230400003", "2026-09-24T00:00:00Z"],
  ["1552469616230400002", "2026-09-24T00:00:00Z"],
  ["1552469616230400000", "2026-09-24T00:00:00Z"],
  ["1552469616230399999", "2026-09-23T23:59:59.999Z"],
].map(([id, timestamp]) => ({ ...message, id, timestamp }));
const range = {
  channel_id: channelId,
  since: "2026-09-24T00:00:00Z",
  until: "2026-09-25T00:00:00Z",
};

function historySession(t, history = rangeMessages) {
  return session(t, ({ path }) => {
    const query = new URL(`https://discord.com${path}`).searchParams;
    return history
      .filter(
        ({ id }) =>
          !query.has("before") || BigInt(id) < BigInt(query.get("before")),
      )
      .slice(0, Number(query.get("limit")));
  });
}

test("time ranges include the start and exclude the end, using one request", async (t) => {
  const { call, calls } = await historySession(t);
  const result = await call("read_messages", range);
  assert.deepEqual(
    result.messages.map(({ id }) => id),
    rangeMessages.slice(2, 7).map(({ id }) => id),
  );
  assert.equal(result.next_before, null);
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].path,
    `/channels/${channelId}/messages?limit=20&before=1552832004096000000`,
  );
});

test("range pagination does not skip messages sharing the start timestamp", async (t) => {
  const { call, calls } = await historySession(t);
  const messages = [];
  let before;
  for (let page = 0; page < 3; page += 1) {
    const result = await call("read_messages", { ...range, limit: 2, before });
    messages.push(...result.messages);
    before = result.next_before;
    assert.equal(before === null, page === 2);
  }
  assert.deepEqual(
    messages.map(({ id }) => id),
    rangeMessages.slice(2, 7).map(({ id }) => id),
  );
  assert.equal(calls.length, 3);
  assert.equal(
    calls[1].path,
    `/channels/${channelId}/messages?limit=2&before=1552650810163200000`,
  );
  assert.equal(
    calls[2].path,
    `/channels/${channelId}/messages?limit=2&before=1552469616230400002`,
  );
});

test("timestamps with offsets select the same instants as UTC", async (t) => {
  const { call } = await historySession(t);
  const expected = await call("read_messages", range);
  assert.deepEqual(
    await call("read_messages", {
      ...range,
      since: "2026-09-24T05:30:00+05:30",
      until: "2026-09-24T17:00:00-07:00",
    }),
    expected,
  );
});

test("since and until work independently, and before can only narrow the upper bound", async (t) => {
  const { call, calls } = await historySession(t);
  const since = await call("read_messages", {
    channel_id: channelId,
    since: range.since,
  });
  assert.deepEqual(
    since.messages.map(({ id }) => id),
    rangeMessages.slice(0, 7).map(({ id }) => id),
  );
  assert.equal(calls[0].path, `/channels/${channelId}/messages?limit=20`);
  const until = await call("read_messages", {
    channel_id: channelId,
    until: range.until,
  });
  assert.deepEqual(
    until.messages.map(({ id }) => id),
    rangeMessages.slice(2).map(({ id }) => id),
  );
  const older = await call("read_messages", {
    ...range,
    before: "1552650810163200000",
  });
  assert.deepEqual(
    older.messages.map(({ id }) => id),
    rangeMessages.slice(4, 7).map(({ id }) => id),
  );
  assert.equal(
    calls[2].path,
    `/channels/${channelId}/messages?limit=20&before=1552650810163200000`,
  );
  const newer = await call("read_messages", {
    ...range,
    before: "1552832004096000007",
  });
  assert.deepEqual(
    newer.messages.map(({ id }) => id),
    rangeMessages.slice(2, 7).map(({ id }) => id),
  );
  assert.equal(
    calls[3].path,
    `/channels/${channelId}/messages?limit=20&before=1552832004096000000`,
  );
});

test("empty intervals finish without a misleading continuation cursor", async (t) => {
  const { call, calls } = await historySession(t);
  const empty = { messages: [], next_before: null };
  assert.deepEqual(
    await call("read_messages", {
      ...range,
      since: "2026-09-24T13:00:00Z",
      until: "2026-09-24T14:00:00Z",
      limit: 1,
    }),
    empty,
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(
    await call("read_messages", { ...range, before: "1552469616230400000" }),
    empty,
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(
    await call("read_messages", {
      channel_id: channelId,
      since: "9999-01-01T00:00:00Z",
    }),
    empty,
  );
  assert.deepEqual(
    await call("read_messages", {
      channel_id: channelId,
      until: "2014-01-01T00:00:00Z",
    }),
    empty,
  );
  assert.equal(calls.length, 1);
});

test("wide dates do not produce invalid Discord cursors, and early IDs paginate", async (t) => {
  const { call, calls } = await historySession(t, [
    { ...message, id: "2", timestamp: "2015-01-01T00:00:00Z" },
    { ...message, id: "1", timestamp: "2015-01-01T00:00:00Z" },
  ]);
  const wide = {
    channel_id: channelId,
    since: "2014-01-01T00:00:00Z",
    until: "9999-01-01T00:00:00Z",
    limit: 1,
  };
  const first = await call("read_messages", wide);
  assert.equal(first.next_before, "2");
  assert.equal(calls[0].path, `/channels/${channelId}/messages?limit=1`);
  const second = await call("read_messages", {
    ...wide,
    before: first.next_before,
  });
  assert.equal(second.messages[0].id, "1");
  assert.deepEqual(
    await call("read_messages", { ...wide, before: second.next_before }),
    { messages: [], next_before: null },
  );
});

test("millisecond bounds retain all messages in the matching millisecond", async (t) => {
  const { call } = await historySession(t, [
    {
      ...message,
      id: "1552469616238788608",
      timestamp: "2026-09-24T00:00:00.002Z",
    },
    {
      ...message,
      id: "1552469616238788607",
      timestamp: "2026-09-24T00:00:00.001Z",
    },
    {
      ...message,
      id: "1552469616234594304",
      timestamp: "2026-09-24T00:00:00.001Z",
    },
    {
      ...message,
      id: "1552469616234594303",
      timestamp: "2026-09-24T00:00:00Z",
    },
  ]);
  const result = await call("read_messages", {
    channel_id: channelId,
    since: "2026-09-24T00:00:00.001Z",
    until: "2026-09-24T00:00:00.002Z",
  });
  assert.deepEqual(
    result.messages.map(({ id }) => id),
    ["1552469616238788607", "1552469616234594304"],
  );
  assert.equal(result.next_before, null);
});

test("invalid timestamps, intervals, and mixed exact-message reads fail before HTTP", async (t) => {
  const { client, calls } = await historySession(t);
  for (const args of [
    { since: "2026-09-24" },
    { since: "2026-09-24T00:00:00" },
    { since: "2026-02-30T00:00:00Z" },
    { since: "2026-09-24T00:00:00+24:00" },
    { since: "2026-09-24T00:00:00.0001Z" },
    { until: "2026-09-24T00:00:00.0001Z" },
    { since: range.until, until: range.since },
    { since: range.since, until: range.since },
    { since: range.since, until: "2026-09-24T05:30:00+05:30" },
    { message_id: messageId, since: range.since },
    { message_id: messageId, until: range.until },
  ]) {
    const result = await client.callTool({
      name: "read_messages",
      arguments: { channel_id: channelId, ...args },
    });
    assert.equal(result.isError, true, JSON.stringify(args));
  }
  assert.equal(calls.length, 0);
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
