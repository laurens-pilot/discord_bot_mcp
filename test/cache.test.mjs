import assert from "node:assert/strict";
import { mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MessageCache, cachePath } from "../src/cache.mjs";

const message = (id, channel_id = "20") => ({
  id,
  channel_id,
  guild_id: "10",
  author: { id: "30", username: "test" },
  content: `Message ${id}`,
  timestamp: "2026-10-07T00:00:00Z",
});
async function fixture(t, options) {
  const root = await mkdtemp(join(tmpdir(), "discord-cache-"));
  const file = join(root, "messages.sqlite");
  const cache = new MessageCache(file, options);
  t.after(async () => {
    cache.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    file,
    cache,
    add: (id, channel) =>
      cache.capture({ t: "MESSAGE_CREATE", d: message(id, channel) }),
  };
}

test("cache persists, isolates tokens, orders snowflakes numerically and paginates channels", async (t) => {
  const { cache, file, root, add } = await fixture(t);
  for (const id of ["1", "9", "10", "100"]) add(id);
  add("101", "21");
  add("10");
  const first = cache.read("20", { limit: 2 });
  assert.deepEqual(
    first.messages.map((m) => m.id),
    ["100", "10"],
  );
  assert.equal(first.next_before, "10");
  assert.deepEqual(
    cache.read("20", { upper: 10n }).messages.map((m) => m.id),
    ["9", "1"],
  );
  assert.deepEqual(
    cache.read("20", { lower: 9n, upper: 100n }).messages.map((m) => m.id),
    ["10", "9"],
  );
  assert.equal(cache.read("20", { message_id: "101" }).messages.length, 0);
  assert.equal(
    cache.read("20", { message_id: "10" }).messages[0].content,
    "Message 10",
  );
  assert.equal(cache.read("20", { lower: 10n ** 30n }).messages.length, 0);
  const reader = new MessageCache(file);
  assert.equal(reader.read("20").messages.length, 4);
  reader.close();
  assert.notEqual(
    cachePath("bot-a", join(root, "config.json")),
    cachePath("bot-b", join(root, "config.json")),
  );
  if (process.platform !== "win32") {
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal((await stat(root)).mode & 0o777, 0o700);
    assert.equal((await stat(file + "-wal")).mode & 0o777, 0o600);
  }
});

test("cache edits existing messages only and handles all deletion events", async (t) => {
  const { cache, add } = await fixture(t);
  const dispatch = (type, d) => cache.capture({ t: type, d });
  dispatch("MESSAGE_UPDATE", {
    id: "2",
    channel_id: "20",
    content: "not observed",
  });
  dispatch("MESSAGE_CREATE", { ...message("3"), guild_id: undefined });
  assert.equal(cache.read("20").messages.length, 0);
  for (const id of ["1", "2", "3"]) add(id);
  dispatch("MESSAGE_UPDATE", {
    id: "1",
    channel_id: "20",
    content: "edited",
    embeds: [{ title: "preview" }],
  });
  const updated = cache.read("20", { message_id: "1" }).messages[0];
  assert.equal(updated.content, "edited");
  assert.equal(updated.author.username, "test");
  dispatch("MESSAGE_DELETE", { id: "1", channel_id: "21" });
  assert.equal(cache.read("20").messages.length, 3);
  dispatch("MESSAGE_DELETE", { id: "1", channel_id: "20" });
  dispatch("MESSAGE_DELETE_BULK", { ids: ["2", "3"], channel_id: "20" });
  assert.equal(cache.read("20").messages.length, 0);
  for (const type of ["CHANNEL_DELETE", "THREAD_DELETE"]) {
    add("1");
    dispatch(type, { id: "20" });
    assert.equal(cache.read("20").messages.length, 0);
  }
  add("1");
  dispatch("GUILD_DELETE", { id: "10", unavailable: true });
  assert.equal(cache.read("20").messages.length, 1);
  dispatch("GUILD_DELETE", { id: "10" });
  assert.equal(cache.read("20").messages.length, 0);
});

test("retention expires without new events and coverage never claims complete history", async (t) => {
  let now = Date.now();
  const { cache, add } = await fixture(t, { now: () => now });
  add("1");
  cache.setState({ status: "live" });
  assert.equal(cache.coverage().listener, "live");
  assert.equal(cache.coverage().complete, false);
  now += 16000;
  assert.equal(cache.coverage().listener, "stopped");
  now += 7 * 86400000;
  assert.equal(cache.read("20").messages.length, 0);
});

test("cache enforces message count and per-message byte bounds", async (t) => {
  const { cache, add } = await fixture(t);
  for (let i = 1; i <= 5001; i++) add(String(i));
  assert.equal(cache.read("20", { message_id: "1" }).messages.length, 0);
  assert.equal(cache.read("20", { message_id: "2" }).messages.length, 1);
  cache.capture({
    t: "MESSAGE_CREATE",
    d: { ...message("9999"), content: "x".repeat(65536) },
  });
  assert.equal(cache.read("20", { message_id: "9999" }).messages.length, 0);
});

test(
  "cache refuses symlinks for database and sidecars",
  { skip: process.platform === "win32" },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "discord-cache-links-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const target = join(root, "target");
    await writeFile(target, "unchanged");
    for (const suffix of ["", "-wal", "-shm"]) {
      const file = join(root, `db${suffix.length}.sqlite`);
      await symlink(target, file + suffix);
      assert.throws(() => new MessageCache(file), /symbolic links/);
    }
  },
);
