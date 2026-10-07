import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import test from "node:test";
import { MessageCache } from "../src/cache.mjs";
import { startGateway } from "../src/gateway.mjs";
import { runGateway } from "../src/gateway-worker.mjs";

async function until(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await setTimeout(20);
  }
  assert.fail("Timed out waiting for listener state");
}

test("listeners share one writer, persist events, and take over after shutdown", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "discord-gateway-"));
  const cache = new MessageCache(join(root, "cache.sqlite"));
  const workers = [];
  const createWorker = () => {
    const worker = new EventEmitter();
    worker.terminate = async () => worker.emit("exit", 0);
    workers.push(worker);
    return worker;
  };
  const first = startGateway("test", cache, {
    createWorker,
    interval: 20,
    retryDelay: 20,
  });
  await until(() => workers.length === 1);
  const second = startGateway("test", cache, { createWorker, interval: 20 });
  t.after(async () => {
    await first.close();
    await second.close();
    cache.close();
    await rm(root, { recursive: true, force: true });
  });
  await until(() => workers.length === 1);
  workers[0].emit("message", { status: "live" });
  workers[0].emit("message", {
    event: {
      t: "MESSAGE_CREATE",
      d: {
        id: "1",
        channel_id: "2",
        guild_id: "3",
        author: { id: "4", username: "test" },
        content: "captured",
      },
    },
  });
  assert.equal(cache.coverage().listener, "live");
  assert.equal(cache.read("2").messages[0].content, "captured");
  await setTimeout(100);
  assert.equal(workers.length, 1);
  workers[0].emit("exit", 1);
  assert.equal(cache.coverage().listener, "error");
  await until(() => workers.length === 2);
  await first.close();
  await until(() => workers.length === 3);
  workers[2].emit("message", { status: "disconnected", error: "Gap" });
  assert.equal(cache.coverage().listener, "disconnected");
  assert.equal(cache.coverage().complete, false);
  workers[2].emit("message", { status: "live" });
  assert.equal(cache.coverage().error, undefined);
  await second.close();
  assert.equal(cache.coverage().listener, "stopped");
});

test("Gateway wiring requests the needed intents, forwards message events and reports reconnects without secrets", async () => {
  let manager;
  let options;
  class Manager extends EventEmitter {
    constructor(args) {
      super();
      manager = this;
      options = args;
    }
    async connect() {
      this.emit("ready", {}, 0);
    }
  }
  const events = [];
  runGateway(
    "secret-token",
    { postMessage: (event) => events.push(event) },
    Manager,
  );
  assert.equal(options.intents, 1 | 512 | 32768);
  assert.equal(options.token, "secret-token");
  assert.equal(events.at(-1).status, "live");
  manager.emit("dispatch", { t: "MESSAGE_CREATE", d: { id: "1" } });
  assert.equal(events.at(-1).event.t, "MESSAGE_CREATE");
  const count = events.length;
  manager.emit("dispatch", { t: "PRESENCE_UPDATE", d: {} });
  assert.equal(events.length, count);
  manager.emit("closed", 4014, 0);
  assert.match(events.at(-1).error, /Message Content Intent/);
  manager.emit("resumed", 0);
  assert.equal(events.at(-1).status, "live");
  manager.emit("error", new Error("secret-token"), 0);
  manager.emit("socketError", new Error("secret-token"), 0);
  assert.ok(!JSON.stringify(events).includes("secret-token"));
});

test("closing immediately cannot leave a late worker holding the cache lock", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "discord-gateway-stop-"));
  const cache = new MessageCache(join(root, "cache.sqlite"));
  t.after(async () => {
    cache.close();
    await rm(root, { recursive: true, force: true });
  });
  const gateway = startGateway("test", cache, {
    createWorker: () => assert.fail("Worker started after shutdown"),
  });
  await gateway.close();
});
