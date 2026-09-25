import assert from "node:assert/strict";
import test from "node:test";
import { Discord } from "../src/discord.mjs";

const token = "test-token-that-must-not-appear-in-errors";
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers });

test("only the Discord API receives credentials and redirects are disabled", async () => {
  const discord = new Discord(token, async (url, options) => {
    assert.equal(url, "https://discord.com/api/v10/users/@me");
    assert.equal(options.headers.Authorization, `Bot ${token}`);
    assert.equal(options.method, "GET");
    assert.equal(options.redirect, "error");
    assert.ok(options.signal instanceof AbortSignal);
    return json({ id: "123", username: "bot", bot: true });
  });
  assert.deepEqual(await discord.identity(), { id: "123", name: "bot" });
});

test("setup rejects a non-bot identity", async () => {
  const discord = new Discord(token, async () => json({ bot: false }));
  await assert.rejects(discord.identity(), /not a Discord bot/);
});

test("HTTP errors are actionable and never reflect Discord response bodies", async () => {
  for (const [status, expected] of [
    [400, /HTTP 400, code 50035/],
    [401, /setup again/],
    [403, /permissions/],
    [404, /could not find/],
    [500, /Try again later/],
  ]) {
    const discord = new Discord(token, async () =>
      json({ message: token, code: 50035 }, status),
    );
    await assert.rejects(
      discord.request("/test"),
      (error) => expected.test(error.message) && !error.message.includes(token),
    );
  }
});

test("a failed send is never automatically retried and reports uncertain delivery", async () => {
  for (const fail of [
    () => {
      throw new Error(token);
    },
    () => json({}, 502),
    () => new Response("not JSON"),
  ]) {
    let requests = 0;
    const discord = new Discord(token, async () => {
      requests += 1;
      return fail();
    });
    await assert.rejects(
      discord.request("/channels/123/messages", { content: "hello" }),
      (error) =>
        /Delivery is uncertain/.test(error.message) &&
        !error.message.includes(token),
    );
    assert.equal(requests, 1);
  }
});

test("rate limits prevent subsequent requests until the cooldown expires", async (t) => {
  let now = 1000;
  t.mock.method(Date, "now", () => now);
  let requests = 0;
  const discord = new Discord(token, async () => {
    requests += 1;
    return requests === 1
      ? json({ retry_after: 1.25, global: true }, 429)
      : json({ ok: true });
  });
  await assert.rejects(discord.request("/one"), /retry in 2 seconds/);
  await assert.rejects(discord.request("/two"), /retry in 2 seconds/);
  assert.equal(requests, 1);
  now = 2250;
  assert.deepEqual(await discord.request("/two"), { ok: true });
  assert.equal(requests, 2);
});

test("successful responses can also exhaust a rate-limit bucket", async (t) => {
  t.mock.method(Date, "now", () => 1000);
  let requests = 0;
  const discord = new Discord(token, async () => {
    requests += 1;
    return json({ ok: true }, 200, {
      "X-RateLimit-Remaining": "0",
      "X-RateLimit-Reset-After": "3",
    });
  });
  assert.deepEqual(await discord.request("/one"), { ok: true });
  await assert.rejects(discord.request("/two"), /retry in 3 seconds/);
  assert.equal(requests, 1);
});

test("requests are serialized and errors do not poison the queue", async () => {
  let active = 0;
  let maximum = 0;
  let count = 0;
  const discord = new Discord(token, async () => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setImmediate(resolve));
    active -= 1;
    count += 1;
    return count === 1 ? json({}, 403) : json({ ok: true });
  });
  const results = await Promise.allSettled([
    discord.request("/one"),
    discord.request("/two"),
  ]);
  assert.equal(maximum, 1);
  assert.equal(results[0].status, "rejected");
  assert.equal(results[1].status, "fulfilled");
});
