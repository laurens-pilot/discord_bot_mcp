import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  writeFile,
  mkdir,
  symlink,
  link,
  open,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { MessageCache } from "../src/cache.mjs";
import { Discord } from "../src/discord.mjs";
import { createServer } from "../src/server.mjs";
import { uploadBody } from "../src/uploads.mjs";

async function fixture(t, fetchImpl, options) {
  const server = createServer(new Discord("fake-token", fetchImpl), options);
  const client = new Client({ name: "features-test", version: "1.0.0" });
  const [local, remote] = InMemoryTransport.createLinkedPair();
  await server.connect(remote);
  await client.connect(local);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  return async (name, args) => client.callTool({ name, arguments: args });
}
async function directory(t) {
  const root = await mkdtemp(join(tmpdir(), "discord-features-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("MCP uploads file-only and text replies with silent flags and no mention pings", async (t) => {
  const root = await directory(t);
  const files = [join(root, "hello.txt"), join(root, "empty.bin")];
  await writeFile(files[0], "hello bytes");
  await writeFile(files[1], "");
  const calls = [];
  const call = await fixture(t, async (url, options) => {
    calls.push({ url, ...options });
    return Response.json({ id: "8", channel_id: "2" });
  });
  const result = await call("send_message", { channel_id: "2", files });
  assert.ok(!result.isError, JSON.stringify(result));
  assert.ok(calls[0].body instanceof FormData);
  assert.equal(calls[0].headers["Content-Type"], undefined);
  const payload = JSON.parse(calls[0].body.get("payload_json"));
  assert.equal(payload.flags, 4096);
  assert.equal(payload.content, undefined);
  assert.deepEqual(payload.allowed_mentions, {
    parse: [],
    replied_user: false,
  });
  assert.deepEqual(payload.attachments, [
    { id: 0, filename: "hello.txt" },
    { id: 1, filename: "empty.bin" },
  ]);
  assert.equal(await calls[0].body.get("files[0]").text(), "hello bytes");
  assert.equal(calls[0].body.get("files[1]").size, 0);
  await call("send_message", {
    channel_id: "2",
    content: "@everyone test",
    files: [files[0]],
    reply_to: "5",
    silent: false,
  });
  const reply = JSON.parse(calls[1].body.get("payload_json"));
  assert.equal(reply.flags, undefined);
  assert.equal(reply.content, "@everyone test");
  assert.equal(reply.message_reference.message_id, "5");
  for (const args of [
    {},
    { files: [] },
    { files: Array(11).fill(files[0]) },
    { files: ["relative.txt"] },
  ])
    assert.equal(
      (await call("send_message", { channel_id: "2", ...args })).isError,
      true,
    );
  assert.equal(calls.length, 2);
});

test("uploads reject private configuration, aliases, non-files and oversized totals", async (t) => {
  const root = await directory(t);
  const privateDir = join(root, "private");
  await mkdir(privateDir);
  const credential = join(privateDir, "config.json");
  await writeFile(credential, "private-credential");
  const cached = join(privateDir, "messages.sqlite");
  await writeFile(cached, "private-cache");
  for (const path of [credential, cached, root, join(root, "missing")])
    await assert.rejects(uploadBody({}, [path], credential));
  if (process.platform !== "win32") {
    const alias = join(root, "alias");
    await symlink(credential, alias);
    await assert.rejects(uploadBody({}, [alias], credential), /credential/);
  }
  const hardlink = join(root, "hardlink");
  await link(credential, hardlink);
  await assert.rejects(uploadBody({}, [hardlink], credential), /credential/);
  const large = join(root, "large");
  const handle = await open(large, "w");
  await handle.truncate(13 * 1024 * 1024);
  await handle.close();
  await assert.rejects(uploadBody({}, [large, large], credential), /24 MiB/);
});

test("failed multipart sends report uncertain delivery without retries", async (t) => {
  const root = await directory(t);
  const file = join(root, "upload.txt");
  await writeFile(file, "hello");
  let requests = 0;
  const call = await fixture(t, async () => {
    requests++;
    throw new Error("network failed");
  });
  const result = await call("send_message", { channel_id: "2", files: [file] });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Delivery is uncertain/);
  assert.equal(requests, 1);
});

test("MCP uses cached time ranges without history, HTTP with history, and fails closed on revoked access", async (t) => {
  const root = await directory(t);
  const cache = new MessageCache(join(root, "messages.sqlite"));
  t.after(() => cache.close());
  for (const id of [
    "1552469616230400000",
    "1552469616230400001",
    "1552832004096000000",
  ]) {
    cache.capture({
      t: "MESSAGE_CREATE",
      d: {
        id,
        guild_id: "1",
        channel_id: "2",
        author: { id: "3", username: "test" },
        timestamp: "2026-09-24T00:00:00Z",
        content: "cached",
      },
    });
  }
  let permissions = "1024";
  let historyCalls = 0;
  const call = await fixture(
    t,
    async (url) => {
      const path = new URL(url).pathname.replace("/api/v10", "");
      if (path === "/users/@me")
        return Response.json({ id: "3", username: "bot", bot: true });
      if (path === "/channels/2")
        return Response.json({
          guild_id: "1",
          type: 0,
          permission_overwrites: [],
        });
      if (path === "/guilds/1/members/3") return Response.json({ roles: [] });
      if (path === "/guilds/1/roles")
        return Response.json([{ id: "1", permissions }]);
      if (path === "/channels/2/messages") {
        historyCalls++;
        return Response.json({ code: 50001 }, { status: 403 });
      }
      assert.fail(`Unexpected path ${path}`);
    },
    { cache },
  );
  const args = {
    channel_id: "2",
    since: "2026-09-24T00:00:00Z",
    until: "2026-09-25T00:00:00Z",
    limit: 1,
  };
  const first = JSON.parse((await call("read_messages", args)).content[0].text);
  assert.equal(first.messages[0].id, "1552469616230400001");
  assert.equal(first.coverage.complete, false);
  assert.equal(first.coverage.source, "gateway_cache");
  const second = JSON.parse(
    (await call("read_messages", { ...args, before: first.next_before }))
      .content[0].text,
  );
  assert.equal(second.messages[0].id, "1552469616230400000");
  assert.equal(second.next_before, null);
  const exact = JSON.parse(
    (
      await call("read_messages", {
        channel_id: "2",
        message_id: "1552469616230400000",
      })
    ).content[0].text,
  );
  assert.equal(exact.messages[0].content, "cached");
  assert.equal(historyCalls, 0);
  permissions = "0";
  const denied = await call("read_messages", args);
  assert.equal(denied.isError, true);
  assert.ok(!denied.content[0].text.includes("cached"));
  permissions = "66560";
  const failed = await call("read_messages", args);
  assert.equal(failed.isError, true);
  assert.equal(historyCalls, 1);
});
