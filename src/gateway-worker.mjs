import { parentPort, workerData } from "node:worker_threads";
import { WebSocketManager, WebSocketShardEvents } from "@discordjs/ws";
import { Discord } from "./discord.mjs";

export function runGateway(token, port, Manager = WebSocketManager) {
  const discord = new Discord(token);
  const ready = new Set();
  let shards = 1;
  const report = (status, error) => port.postMessage({ status, error });
  const manager = new Manager({
    token,
    intents: 1 | 512 | 1024 | 32768 | 16777216,
    rest: {
      get: async (path) => {
        const data = await discord.request(path);
        const url = new URL(data.url);
        if (url.protocol !== "wss:" || !url.hostname.endsWith(".discord.gg"))
          throw new Error("Unexpected Gateway address.");
        shards = data.shards;
        return data;
      },
    },
  });

  manager.on(WebSocketShardEvents.Dispatch, (event) => {
    if (
      [
        "MESSAGE_CREATE",
        "MESSAGE_UPDATE",
        "MESSAGE_DELETE",
        "MESSAGE_DELETE_BULK",
        "MESSAGE_REACTION_ADD",
        "MESSAGE_REACTION_REMOVE",
        "MESSAGE_REACTION_REMOVE_ALL",
        "MESSAGE_REACTION_REMOVE_EMOJI",
        "MESSAGE_POLL_VOTE_ADD",
        "MESSAGE_POLL_VOTE_REMOVE",
        "CHANNEL_DELETE",
        "THREAD_DELETE",
        "GUILD_DELETE",
      ].includes(event.t)
    )
      port.postMessage({ event });
  });
  manager.on(WebSocketShardEvents.Ready, (_data, shardId) => {
    ready.add(shardId);
    report(ready.size === shards ? "live" : "connecting");
  });
  manager.on(WebSocketShardEvents.Resumed, (shardId) => {
    ready.add(shardId);
    report(ready.size === shards ? "live" : "connecting");
  });
  manager.on(WebSocketShardEvents.Closed, (code, shardId) => {
    ready.delete(shardId);
    report(
      "disconnected",
      code === 4014
        ? "Enable Message Content Intent in the Discord Developer Portal, then restart the listener."
        : `Gateway disconnected (code ${code}); capture may have gaps.`,
    );
  });
  manager.on(WebSocketShardEvents.Error, () => {
    report(
      "error",
      "Gateway error. Check the token and Message Content Intent; restart the listener after correcting them.",
    );
  });
  manager.on(WebSocketShardEvents.SocketError, () => {
    report("disconnected", "Gateway network error; capture may have gaps.");
  });

  async function connect() {
    try {
      report("connecting");
      await manager.connect();
    } catch {
      report(
        "error",
        "Gateway connection failed. Check network, token, Message Content Intent and session limits; retrying in 30 seconds.",
      );
      await manager.destroy();
      ready.clear();
      setTimeout(() => void connect(), 30000);
    }
  }

  void connect();
}

if (parentPort) runGateway(workerData.token, parentPort);
