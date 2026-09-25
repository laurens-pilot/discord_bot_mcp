import { fileURLToPath } from "node:url";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { configPath, loadToken } from "./config.mjs";
import { Discord } from "./discord.mjs";
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
      "discord-bot-mcp [start|setup|doctor]\n\nsetup   Save a bot token using a hidden prompt\ndoctor  Verify the saved token with Discord (read-only)\nstart   Serve MCP over stdio (default)",
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
              command: process.execPath,
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
  if (command !== "start" && command !== "doctor")
    throw new Error("Unknown command. Use --help.");
  const discord = new Discord(await loadToken());
  if (command === "doctor") {
    const identity = await discord.identity();
    console.log(
      `Authenticated as ${identity.name} (${identity.id}).\nCredentials: ${configPath()}\nToken check passed. Channel access and Message Content Intent still need a read_messages call.`,
    );
    return;
  }
  const handle = serveStdio(() => createServer(discord));
  process.once("SIGINT", () => {
    void handle.close();
  });
  process.once("SIGTERM", () => {
    void handle.close();
  });
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
