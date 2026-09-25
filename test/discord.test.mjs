import assert from "node:assert/strict";
import test from "node:test";
import { Discord } from "../src/discord.mjs";

const token = "test-token-that-must-not-appear-in-errors";
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers });

function clock(t) {
  let now = 1000;
  const waits = [];
  t.mock.method(Date, "now", () => now);
  return {
    waits,
    sleep: async (milliseconds) => {
      waits.push(milliseconds);
      now += milliseconds;
    },
    advance: (milliseconds) => {
      now += milliseconds;
    },
  };
}

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

test("global limits block every route until expiry, whether indicated by body or headers", async (t) => {
  const time = clock(t);
  for (const [body, headers] of [
    [{ retry_after: 30, global: true }, {}],
    [{}, { "Retry-After": "30", "X-RateLimit-Global": "true" }],
    [{ retry_after: 30 }, { "X-RateLimit-Scope": "global" }],
  ]) {
    let requests = 0;
    const discord = new Discord(
      token,
      async () => {
        requests += 1;
        return requests === 1 ? json(body, 429, headers) : json({ ok: true });
      },
      time,
    );
    await assert.rejects(
      discord.request("/channels/123/messages"),
      /retry in 30 seconds/,
    );
    await assert.rejects(
      discord.request("/guilds/456/channels"),
      /retry in 30 seconds/,
    );
    assert.equal(requests, 1);
    time.advance(30000);
    assert.deepEqual(await discord.request("/guilds/456/channels"), {
      ok: true,
    });
    assert.equal(requests, 2);
  }
  assert.deepEqual(time.waits, []);
});

test("successful responses limit only the same route, method, and major resource", async (t) => {
  const time = clock(t);
  let requests = 0;
  const discord = new Discord(
    token,
    async () => {
      requests += 1;
      return json({ ok: true }, 200, {
        "X-RateLimit-Remaining": "0",
        "X-RateLimit-Reset-After": "30",
      });
    },
    time,
  );
  await discord.request("/channels/123/messages?limit=20");
  await assert.rejects(
    discord.request("/channels/123/messages?limit=100&before=456"),
    /retry in 30 seconds/,
  );
  await discord.request("/channels/456/messages");
  await discord.request("/guilds/123/channels");
  await discord.request("/channels/123/messages", { content: "hello" });
  assert.equal(requests, 4);
  assert.deepEqual(time.waits, []);
});

test("learned shared buckets apply across routes but remain separate for each channel", async (t) => {
  const time = clock(t);
  let requests = 0;
  const discord = new Discord(
    token,
    async (url) => {
      requests += 1;
      return json({ ok: true }, 200, {
        "X-RateLimit-Bucket": "shared-messages",
        "X-RateLimit-Remaining": url.endsWith("/messages") ? "0" : "1",
        "X-RateLimit-Reset-After": "30",
      });
    },
    time,
  );
  await discord.request("/channels/123/messages/111");
  await discord.request("/channels/123/messages");
  await assert.rejects(
    discord.request("/channels/123/messages/222"),
    /retry in 30 seconds/,
  );
  await discord.request("/channels/456/messages/222");
  assert.equal(requests, 3);
  assert.deepEqual(time.waits, []);
});

test("reads wait through short known cooldowns before fetching the next page", async (t) => {
  const time = clock(t);
  let requests = 0;
  const discord = new Discord(
    token,
    async () => {
      requests += 1;
      return json({ ok: true }, 200, {
        "X-RateLimit-Remaining": "0",
        "X-RateLimit-Reset-After": "1.25",
        "X-RateLimit-Bucket": "messages",
      });
    },
    time,
  );
  await discord.request("/channels/123/messages?limit=1");
  await discord.request("/channels/123/messages?limit=1&before=456");
  assert.equal(requests, 2);
  assert.deepEqual(time.waits, [1250]);
});

test("learning a bucket on another channel preserves an earlier headerless cooldown", async (t) => {
  const time = clock(t);
  let requests = 0;
  const discord = new Discord(
    token,
    async () => {
      requests += 1;
      return requests === 1
        ? json({ retry_after: 30 }, 429)
        : json({}, 200, { "X-RateLimit-Bucket": "messages" });
    },
    time,
  );
  await assert.rejects(
    discord.request("/channels/123/messages"),
    /retry in 30 seconds/,
  );
  await discord.request("/channels/456/messages");
  await assert.rejects(
    discord.request("/channels/123/messages"),
    /retry in 30 seconds/,
  );
  assert.equal(requests, 2);
  assert.deepEqual(time.waits, []);
});

test("reads retry short 429 responses and obey fractional Retry-After headers", async (t) => {
  const time = clock(t);
  let requests = 0;
  const discord = new Discord(
    token,
    async () => {
      requests += 1;
      return requests < 3
        ? json({}, 429, {
            "Retry-After": "1.25",
            "X-RateLimit-Bucket": "messages",
          })
        : json({ ok: true });
    },
    time,
  );
  assert.deepEqual(await discord.request("/channels/123/messages"), {
    ok: true,
  });
  assert.equal(requests, 3);
  assert.deepEqual(time.waits, [1250, 1250]);
});

test("the read wait budget includes both an existing cooldown and a new 429", async (t) => {
  const time = clock(t);
  let requests = 0;
  const discord = new Discord(
    token,
    async () => {
      requests += 1;
      return requests === 1
        ? json({}, 200, {
            "X-RateLimit-Remaining": "0",
            "X-RateLimit-Reset-After": "3",
          })
        : json({ retry_after: 3 }, 429);
    },
    time,
  );
  await discord.request("/channels/123/messages");
  await assert.rejects(
    discord.request("/channels/123/messages"),
    /retry in 3 seconds/,
  );
  assert.equal(requests, 2);
  assert.deepEqual(time.waits, [3000]);
});

test("reads retry at most twice even when cooldowns are zero", async (t) => {
  const time = clock(t);
  for (const reset of [0, 0.001]) {
    let requests = 0;
    const discord = new Discord(
      token,
      async () => {
        requests += 1;
        return json({ retry_after: reset }, 429);
      },
      time,
    );
    await assert.rejects(
      discord.request("/channels/123/messages"),
      /rate limit/,
    );
    assert.equal(requests, 3);
  }
  assert.deepEqual(time.waits, [1, 1]);
});

test("missing or invalid cooldowns do not cause automatic retries", async (t) => {
  const time = clock(t);
  for (const body of [{}, { retry_after: "invalid" }, { retry_after: -1 }]) {
    let requests = 0;
    const discord = new Discord(
      token,
      async () => {
        requests += 1;
        return json(body, 429);
      },
      time,
    );
    await assert.rejects(
      discord.request("/channels/123/messages"),
      /rate limit/,
    );
    assert.equal(requests, 1);
  }
  assert.deepEqual(time.waits, []);
});

test("rate-limited sends are never retried or delayed and do not block other routes", async (t) => {
  const time = clock(t);
  let requests = 0;
  const discord = new Discord(
    token,
    async (_url, options) => {
      requests += 1;
      return options.method === "POST"
        ? json({ retry_after: 1, global: false }, 429)
        : json({ ok: true });
    },
    time,
  );
  await assert.rejects(
    discord.request("/channels/123/messages", { content: "hello" }),
    /retry in 1 seconds/,
  );
  await assert.rejects(
    discord.request("/channels/123/messages", { content: "hello" }),
    /retry in 1 seconds/,
  );
  assert.deepEqual(await discord.request("/channels/123/messages"), {
    ok: true,
  });
  assert.equal(requests, 2);
  assert.deepEqual(time.waits, []);
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
