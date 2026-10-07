import { fileURLToPath } from "node:url";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { configPath, loadToken } from "./config.mjs";
import { Discord } from "./discord.mjs";
import { nodeCommand } from "./node-command.mjs";
import { createServer } from "./server.mjs";
import { setup } from "./setup.mjs";

async function main() {
  const [command = "start", ...extra] = process.argv.slice(2);
  if (extra.length)
    throw new Error(
      "Unexpected arguments. Use --help; never pass the bot token as an argument.",
    );
  if (command === "--help" || command === "help") {
    console.log(
      "discord-bot-mcp [start|setup|doctor|listen]\n\nsetup   Save a bot token using a hidden prompt\ndoctor  Verify the saved token and report cache status\nstart   Serve MCP over stdio and capture live messages (default)\nlisten  Keep capturing messages between MCP sessions",
    );
    return;
  }
  if (command === "setup") {
    const { identity, file } = await setup();
    console.log(
      `Saved token for ${identity.name} (${identity.id}) in ${file}.\n\nAdd this to your MCP client's configuration:\n`,
    );
    console.log(
      JSON.stringify(
        {
          mcpServers: {
            discord: {
              command: await nodeCommand(),
              args: [fileURLToPath(import.meta.url)],
            },
          },
        },
        null,
        2,
      ),
    );
    console.log(
      "\nEnable Message Content Intent in the Discord Developer Portal to read ordinary messages. Restart your MCP client after setup.",
    );
    return;
  }
  if (!["start", "doctor", "listen"].includes(command))
    throw new Error("Unknown command. Use --help.");
  const token = await loadToken();
  const discord = new Discord(token);
  const { MessageCache, cachePath } = await import("./cache.mjs");
  const cache = new MessageCache(cachePath(token));
  if (command === "doctor") {
    try {
      const identity = await discord.identity();
      console.log(
        `Authenticated as ${identity.name} (${identity.id}).\nCredentials: ${configPath()}\nCache: ${cache.file}\n${JSON.stringify(cache.coverage())}\nToken check passed. Channel access and Message Content Intent still need a read_messages call.`,
      );
    } finally {
      cache.close();
    }
    return;
  }
  const { startGateway } = await import("./gateway.mjs");
  const gateway = startGateway(token, cache);
  const handle =
    command === "start"
      ? serveStdio(() => createServer(discord, { cache }))
      : undefined;
  if (command === "listen")
    console.error(
      "Listening for Discord messages. Keep this process running for continuous capture; use doctor to check status.",
    );
  let closing;
  const close = () =>
    (closing ??= (async () => {
      try {
        await handle?.close();
      } finally {
        try {
          await gateway.close();
        } finally {
          cache.close();
        }
      }
    })().catch(() => {
      process.exitCode = 1;
    }));
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  if (command === "start") {
    process.stdin.once("end", close);
    process.stdin.once("close", close);
    process.stdout.once("error", close);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
