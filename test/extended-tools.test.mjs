import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createServer } from "../src/server.mjs";
import { Discord } from "../src/discord.mjs";
import { MessageCache } from "../src/cache.mjs";
import { searchInput } from "../src/search.mjs";

const message = {
  id: "300",
  guild_id: "100",
  channel_id: "200",
  author: { id: "9", username: "bot", bot: true },
  timestamp: "2026-09-24T00:00:00Z",
  content: "Original",
};
const target = { channel_id: "200", message_id: "300" };
const secret = "fake-token-never-reflect";

async function fixture(
  t,
  {
    permissions = 66560n,
    useCache = false,
    cache: suppliedCache,
    handle = () => undefined,
  } = {},
) {
  let cache = suppliedCache;
  if (useCache) {
    const root = await mkdtemp(join(tmpdir(), "discord-extended-"));
    cache = new MessageCache(join(root, "messages.sqlite"));
    t.after(async () => {
      cache.close();
      await rm(root, { recursive: true, force: true });
    });
  }
  const calls = [];
  const discord = new Discord(secret, async (url, options) => {
    const parsed = new URL(url);
    const path = parsed.pathname.replace("/api/v10", "");
    const call = {
      path,
      query: parsed.searchParams,
      method: options.method,
      body: options.body ? JSON.parse(options.body) : undefined,
    };
    calls.push(call);
    let result = await handle(call);
    if (result === undefined) {
      if (path === "/users/@me")
        result = { id: "9", username: "bot", bot: true };
      else if (path === "/guilds/100/members/9") result = { roles: [] };
      else if (path === "/guilds/100/channels")
        result = [{ id: "200", type: 0, permission_overwrites: [] }];
      else if (path === "/guilds/100/roles")
        result = [
          {
            id: "100",
            permissions: String(
              typeof permissions === "function" ? permissions() : permissions,
            ),
          },
        ];
      else if (path === "/channels/200")
        result = {
          id: "200",
          guild_id: "100",
          type: 0,
          permission_overwrites: [],
        };
      else assert.fail(`Unexpected ${options.method} ${path}`);
    }
    return result instanceof Response ? result : Response.json(result);
  });
  const server = createServer(discord, { cache });
  const client = new Client({ name: "extended-tools-test", version: "1" });
  const [local, remote] = InMemoryTransport.createLinkedPair();
  await server.connect(remote);
  await client.connect(local);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  const call = (name, args) => client.callTool({ name, arguments: args });
  const ok = async (name, args) => {
    const result = await call(name, args);
    assert.ok(!result.isError, JSON.stringify(result));
    assert.ok(!JSON.stringify(result).includes(secret));
    return JSON.parse(result.content[0].text);
  };
  return { call, ok, calls, cache, client };
}

test("search exposes every documented filter and encodes repeated arrays without changing text", async (t) => {
  const query = {
    content: '"summer trip" & café',
    channel_id: ["200", "201"],
    author_id: ["9", "10"],
    min_id: "1",
    max_id: "999",
    slop: 0,
    author_type: ["user", "-webhook"],
    mentions: ["11"],
    mentions_role_id: ["12"],
    mention_everyone: false,
    replied_to_user_id: ["13"],
    replied_to_message_id: ["14"],
    pinned: false,
    has: ["image", "-video"],
    embed_type: ["gif", "article"],
    embed_provider: ["Tenor"],
    link_hostname: ["example.com"],
    attachment_filename: ["test & report.pdf"],
    attachment_extension: ["pdf"],
    sort_by: "relevance",
    sort_order: "asc",
    include_nsfw: true,
    limit: 3,
    offset: 6,
  };
  const { ok, calls } = await fixture(t, {
    handle: ({ path }) =>
      path.endsWith("/messages/search")
        ? { messages: [[{ ...message, unused: secret }]], total_results: 20 }
        : undefined,
  });
  const result = await ok("search_messages", { server_id: "100", ...query });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "/guilds/100/messages/search");
  for (const [key, value] of Object.entries(query))
    assert.deepEqual(
      calls[0].query.getAll(key),
      (Array.isArray(value) ? value : [value]).map(String),
      key,
    );
  assert.equal(result.next_offset, 9);
  assert.equal(result.messages[0].channel_id, "200");
  assert.equal(result.messages[0].unused, undefined);
  assert.deepEqual(
    Object.keys(searchInput.shape).sort(),
    [...Object.keys(query), "server_id", "source", "since", "until"].sort(),
  );
});

test("search time bounds preserve start milliseconds, intersect explicit IDs and reject invalid intervals", async (t) => {
  const { ok, call, calls } = await fixture(t, {
    handle: ({ path }) =>
      path.endsWith("/messages/search")
        ? { messages: [], total_results: 0 }
        : undefined,
  });
  await ok("search_messages", {
    server_id: "100",
    since: "2026-09-24T00:00:00Z",
    until: "2026-09-25T00:00:00Z",
  });
  assert.equal(calls[0].query.get("min_id"), "1552469616230399999");
  assert.equal(calls[0].query.get("max_id"), "1552832004096000000");
  await ok("search_messages", {
    server_id: "100",
    since: "2026-09-24T00:00:00Z",
    min_id: "1552469616230400001",
  });
  assert.equal(calls[1].query.get("min_id"), "1552469616230400001");
  const count = calls.length;
  assert.equal(
    (
      await call("search_messages", {
        server_id: "100",
        since: "2026-09-25T00:00:00Z",
        until: "2026-09-24T00:00:00Z",
      })
    ).isError,
    true,
  );
  assert.equal(
    (
      await ok("search_messages", {
        server_id: "100",
        until: "2010-01-01T00:00:00Z",
      })
    ).messages.length,
    0,
  );
  assert.equal(calls.length, count);
});

test("search uses totals rather than short-page length, reports indexing, and exposes the result-window boundary", async (t) => {
  let response = { messages: [[message]], total_results: 100 };
  const { ok } = await fixture(t, {
    handle: ({ path }) =>
      path.endsWith("/messages/search") ? response : undefined,
  });
  assert.equal(
    (await ok("search_messages", { server_id: "100", limit: 25 })).next_offset,
    25,
  );
  response = new Response(JSON.stringify({ code: 110000, retry_after: 0 }), {
    status: 202,
  });
  const indexing = await ok("search_messages", { server_id: "100" });
  assert.equal(indexing.indexing, true);
  assert.equal(indexing.retry_after, 1);
  assert.equal(indexing.messages, undefined);
  response = {
    messages: [[message]],
    total_results: 12000,
    doing_deep_historical_index: true,
  };
  const last = await ok("search_messages", { server_id: "100", offset: 9975 });
  assert.equal(last.next_offset, null);
  assert.equal(last.truncated, true);
  assert.equal(last.indexing, true);
});

test("invalid search filters fail before HTTP and native failures never become cache results", async (t) => {
  const { call, calls } = await fixture(t);
  for (const args of [
    { content: "" },
    { offset: 9976 },
    { limit: 26 },
    { slop: 101 },
    { author_type: ["human"] },
    { channel_id: "200" },
    { author_id: ["../users/@me"] },
    { has: ["unknown"] },
    { embed_type: ["-gif"] },
    { query: "undocumented" },
    { include_nsfw: "false" },
    { attachment_extension: ["a".repeat(257)] },
    { since: "2026-09-24T00:00:00.0001Z" },
  ])
    assert.equal(
      (await call("search_messages", { server_id: "100", ...args })).isError,
      true,
      JSON.stringify(args),
    );
  assert.equal(calls.length, 0);
  const denied = await fixture(t, {
    useCache: true,
    handle: ({ path }) =>
      path.endsWith("/messages/search")
        ? Response.json({ message: secret }, { status: 403 })
        : undefined,
  });
  denied.cache.capture({ t: "MESSAGE_CREATE", d: message });
  const result = await denied.call("search_messages", { server_id: "100" });
  assert.equal(result.isError, true);
  assert.ok(!JSON.stringify(result).includes(secret));
  assert.equal(denied.calls.length, 1);
});

test("cache search rechecks access, isolates servers, filters text/author/time and excludes NSFW by default", async (t) => {
  let permission = 1024n;
  const { cache, ok, call, calls } = await fixture(t, {
    useCache: true,
    permissions: () => permission,
    handle: ({ path }) => {
      if (path === "/channels/201") return Response.json({}, { status: 403 });
      if (path === "/channels/202")
        return {
          id: "202",
          guild_id: "100",
          type: 0,
          nsfw: true,
          permission_overwrites: [],
        };
    },
  });
  for (const [id, channel_id, guild_id, content, authorId] of [
    ["101", "200", "100", "Release CAFÉ", "9"],
    ["102", "200", "100", "Release café", "9"],
    ["103", "201", "100", "Release café", "9"],
    ["104", "202", "100", "Release café", "9"],
    ["105", "200", "999", "Release café", "9"],
    ["106", "200", "100", "Release café", "8"],
    ["107", "200", "100", "Other", "9"],
  ])
    cache.capture({
      t: "MESSAGE_CREATE",
      d: {
        ...message,
        id,
        channel_id,
        guild_id,
        content,
        author: { id: authorId, username: "user" },
      },
    });
  const args = {
    server_id: "100",
    source: "cache",
    content: "café",
    author_id: ["9"],
    limit: 1,
    min_id: "100",
    max_id: "107",
  };
  const result = await ok("search_messages", args);
  assert.equal(result.messages[0].id, "102");
  assert.equal(result.total_results, 2);
  assert.equal(result.next_offset, 1);
  assert.equal(result.coverage.complete, false);
  assert.equal(
    (await ok("search_messages", { ...args, offset: 1 })).messages[0].id,
    "101",
  );
  assert.equal(
    (await ok("search_messages", { ...args, include_nsfw: true }))
      .total_results,
    3,
  );
  assert.equal(
    (await ok("search_messages", { ...args, sort_order: "asc" })).messages[0]
      .id,
    "101",
  );
  const before = calls.length;
  assert.equal(
    (await call("search_messages", { ...args, has: ["image"] })).isError,
    true,
  );
  assert.equal(calls.length, before);
  permission = 0n;
  assert.equal((await ok("search_messages", args)).total_results, 0);
  assert.ok(!calls.some((c) => c.path.endsWith("/messages/search")));
});

test("editing and deleting verify ownership even with Administrator and preserve edit notification settings", async (t) => {
  let author = "8";
  const { call, ok, calls } = await fixture(t, {
    permissions: 8n,
    handle: ({ path, method, body }) => {
      if (path === "/channels/200/messages/300" && method === "GET")
        return { ...message, author: { id: author, username: "author" } };
      if (path === "/channels/200/messages/300" && method === "PATCH")
        return { ...message, content: body.content };
      if (path === "/channels/200/messages/300" && method === "DELETE")
        return new Response(null, { status: 204 });
    },
  });
  for (const name of ["edit_message", "delete_message", "end_poll"])
    assert.equal(
      (
        await call(name, {
          ...target,
          ...(name === "edit_message" ? { content: "Changed" } : {}),
        })
      ).isError,
      true,
    );
  assert.ok(calls.every((c) => c.method === "GET"));
  author = "9";
  await ok("edit_message", { ...target, content: "@everyone corrected" });
  assert.deepEqual(calls.at(-1).body, {
    content: "@everyone corrected",
    allowed_mentions: { parse: [], replied_user: false },
  });
  assert.equal(calls.at(-1).method, "PATCH");
  assert.equal((await ok("delete_message", target)).deleted, true);
  assert.equal(calls.at(-1).method, "DELETE");
});

test("send receipts persist across MCP sessions and allow own-message changes without history", async (t) => {
  const first = await fixture(t, {
    useCache: true,
    handle: ({ path }) =>
      path === "/channels/200/messages" ? message : undefined,
  });
  await first.ok("send_message", { channel_id: "200", content: "Original" });
  const second = await fixture(t, {
    cache: first.cache,
    permissions: 1024n,
    handle: ({ path, method, body }) => {
      if (path === "/channels/200/messages/300" && method === "PATCH")
        return { ...message, content: body.content };
      if (path === "/channels/200/messages/300" && method === "DELETE")
        return new Response(null, { status: 204 });
    },
  });
  await second.ok("edit_message", { ...target, content: "Corrected" });
  assert.ok(
    !second.calls.some(
      (c) => c.path.endsWith("/messages/300") && c.method === "GET",
    ),
  );
  assert.equal(
    (await second.call("delete_message", { ...target, message_id: "301" }))
      .isError,
    true,
  );
  await second.ok("delete_message", target);
  assert.equal(first.cache.wasSent("200", "300"), false);
});

test("cached authors verify ownership without history and access revocation still blocks writes", async (t) => {
  let permissions = 1024n;
  const { cache, call, ok, calls } = await fixture(t, {
    useCache: true,
    permissions: () => permissions,
    handle: ({ path, method, body }) => {
      if (path.endsWith("/messages/300") && method === "PATCH")
        return { ...message, content: body.content };
    },
  });
  cache.capture({ t: "MESSAGE_CREATE", d: message });
  await ok("edit_message", { ...target, content: "Changed" });
  assert.equal(
    cache.read("200", { message_id: "300" }).messages[0].content,
    "Changed",
  );
  permissions = 0n;
  const count = calls.filter((c) => c.method !== "GET").length;
  assert.equal((await call("delete_message", target)).isError, true);
  assert.equal(calls.filter((c) => c.method !== "GET").length, count);
});

test("cache failures after a confirmed send never turn success into an ambiguous retry", async (t) => {
  const { ok } = await fixture(t, {
    cache: {
      rememberSent() {
        throw new Error(secret);
      },
    },
    handle: ({ path }) => (path.endsWith("/messages") ? message : undefined),
  });
  const result = await ok("send_message", {
    channel_id: "200",
    content: "Original",
  });
  assert.equal(result.id, "300");
  assert.match(result.cache_warning, /Do not repeat/);
});

test("archived threads and pins preserve microsecond cursors and require history", async (t) => {
  const cursor = "2026-10-08T01:02:03.123456+00:00";
  const { ok, calls } = await fixture(t, {
    handle: ({ path }) => {
      if (path.endsWith("/threads/archived/public"))
        return {
          threads: [
            {
              id: "400",
              name: "Archived",
              parent_id: "200",
              thread_metadata: {
                archived: true,
                locked: false,
                archive_timestamp: cursor,
              },
            },
          ],
          has_more: true,
        };
      if (path.endsWith("/messages/pins"))
        return { items: [{ pinned_at: cursor, message }], has_more: true };
    },
  });
  for (const name of ["list_threads", "list_pins"]) {
    const limit = name === "list_threads" ? 2 : 1;
    const result = await ok(name, { channel_id: "200", limit });
    assert.equal(result.next_before, cursor);
    await ok(name, { channel_id: "200", before: result.next_before, limit });
    assert.equal(calls.at(-1).query.get("before"), cursor);
  }
  const denied = await fixture(t, { permissions: 1024n });
  for (const name of ["list_threads", "list_pins"])
    assert.equal(
      (await denied.call(name, { channel_id: "200" })).isError,
      true,
    );
  assert.ok(
    denied.calls.every(
      (c) => !c.path.includes("/archived/") && !c.path.includes("/pins"),
    ),
  );
});

test("reactions encode Unicode and custom emoji, remove only @me, and page through normal/burst users", async (t) => {
  const { ok, calls } = await fixture(t, {
    handle: ({ path, method }) => {
      if (path.includes("/reactions/") && method !== "GET")
        return new Response(null, { status: 204 });
      if (path.includes("/reactions/") && method === "GET")
        return [{ id: "8", username: "Alex" }];
    },
  });
  await ok("set_reaction", { ...target, emoji: "👍" });
  assert.equal(
    calls.at(-1).path,
    "/channels/200/messages/300/reactions/%F0%9F%91%8D/@me",
  );
  assert.equal(calls.at(-1).method, "PUT");
  await ok("set_reaction", { ...target, emoji: "<a:wave:123>", remove: true });
  assert.equal(
    calls.at(-1).path,
    "/channels/200/messages/300/reactions/wave%3A123/@me",
  );
  assert.equal(calls.at(-1).method, "DELETE");
  const result = await ok("list_reaction_users", {
    ...target,
    emoji: "wave:123",
    burst: true,
    limit: 1,
    after: "7",
  });
  assert.equal(result.next_after, "8");
  assert.equal(calls.at(-1).query.get("type"), "1");
  assert.equal(calls.at(-1).query.get("after"), "7");
  const noHistory = await fixture(t, {
    permissions: 1024n,
    handle: ({ method }) =>
      method === "DELETE" ? new Response(null, { status: 204 }) : undefined,
  });
  assert.equal(
    (await noHistory.call("set_reaction", { ...target, emoji: "👍" })).isError,
    true,
  );
  await noHistory.ok("set_reaction", { ...target, emoji: "👍", remove: true });
});

test("polls use silent sends, expose answers/results, list voters and end only owned polls", async (t) => {
  const poll = {
    question: { text: "When?" },
    answers: [
      { answer_id: 1, poll_media: { text: "Today" } },
      { answer_id: 2, poll_media: { text: "Tomorrow" } },
    ],
    expiry: "2026-10-09T00:00:00Z",
    allow_multiselect: false,
  };
  const { ok, call, calls } = await fixture(t, {
    handle: ({ path, method }) => {
      if (path === "/channels/200/messages" && method === "POST")
        return { ...message, poll };
      if (path === "/channels/200/messages/300") return { ...message, poll };
      if (path === "/channels/200/polls/300/answers/1")
        return { users: [{ id: "8", username: "Alex" }] };
      if (path === "/channels/200/polls/300/expire")
        return {
          ...message,
          poll: {
            ...poll,
            results: {
              is_finalized: true,
              answer_counts: [{ id: 1, count: 3 }],
            },
          },
        };
    },
  });
  await ok("send_message", {
    channel_id: "200",
    content: "Please vote",
    poll: { question: "When?", answers: ["Today", "Tomorrow"] },
  });
  assert.equal(calls.at(-1).body.flags, 4096);
  assert.deepEqual(calls.at(-1).body.poll, {
    question: { text: "When?" },
    answers: [
      { poll_media: { text: "Today" } },
      { poll_media: { text: "Tomorrow" } },
    ],
    duration: 24,
    allow_multiselect: false,
    layout_type: 1,
  });
  const read = await ok("read_messages", { ...target });
  assert.equal(read.messages[0].poll.answers[0].votes, undefined);
  assert.equal(
    (await ok("list_poll_voters", { ...target, answer_id: 1, limit: 1 }))
      .next_after,
    "8",
  );
  const ended = await ok("end_poll", target);
  assert.equal(ended.poll.answers[0].votes, 3);
  assert.equal(ended.poll.answers[1].votes, 0);
  assert.equal(ended.poll.finalized, true);
  assert.equal(calls.at(-1).method, "POST");
  assert.equal(calls.at(-1).body, undefined);
  for (const value of [
    { question: "", answers: ["A", "B"] },
    { question: "Q", answers: ["A"] },
    { question: "Q", answers: ["A", "B"], duration_hours: 769 },
  ])
    assert.equal(
      (await call("send_message", { channel_id: "200", poll: value })).isError,
      true,
    );
});

test("optional channel permissions disclose usable capabilities and respect channel scoping", async (t) => {
  const { ok, calls } = await fixture(t, {
    permissions: 1024n | 2048n | (1n << 6n),
    handle: ({ path }) => {
      if (path === "/guilds/100/channels")
        return [
          { id: "200", name: "General", type: 0, permission_overwrites: [] },
          { id: "201", name: "Other", type: 0 },
        ];
      if (path === "/guilds/100/threads/active") return { threads: [] };
    },
  });
  const result = await ok("list_channels", {
    server_id: "100",
    channel_id: "200",
    include_permissions: true,
  });
  assert.equal(result.channels.length, 1);
  assert.equal(result.channels[0].permissions.send, true);
  assert.equal(result.channels[0].permissions.history, false);
  assert.equal(result.channels[0].permissions.add_reactions, false);
  assert.ok(!calls.some((c) => c.path === "/channels/201"));
});

test("forwarded search results preserve snapshot content without inventing an author", async (t) => {
  const forward = {
    ...message,
    content: "",
    message_snapshots: [
      {
        message: {
          content: "Forwarded report",
          timestamp: message.timestamp,
          attachments: [
            {
              filename: "report.pdf",
              url: "https://cdn.discordapp.com/report.pdf",
            },
          ],
        },
      },
    ],
  };
  const { ok, cache } = await fixture(t, {
    useCache: true,
    handle: ({ path }) =>
      path.endsWith("/messages/search")
        ? { messages: [[forward]], total_results: 1 }
        : undefined,
  });
  cache.capture({ t: "MESSAGE_CREATE", d: forward });
  for (const source of ["discord", "cache"]) {
    const result = await ok("search_messages", {
      server_id: "100",
      source,
      content: "Forwarded report",
    });
    assert.equal(result.messages[0].forwarded[0].content, "Forwarded report");
    assert.equal(result.messages[0].forwarded[0].author, undefined);
    assert.equal(
      result.messages[0].forwarded[0].attachments[0].filename,
      "report.pdf",
    );
  }
});

test("archived-thread minimum matches Discord validation before making requests", async (t) => {
  const { call, calls } = await fixture(t);
  assert.equal(
    (await call("list_threads", { channel_id: "200", limit: 1 })).isError,
    true,
  );
  assert.equal(calls.length, 0);
});
