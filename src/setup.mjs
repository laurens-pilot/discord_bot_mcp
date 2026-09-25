import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { configPath, normalizeToken, saveToken } from "./config.mjs";
import { Discord } from "./discord.mjs";

export async function promptToken(
  input = process.stdin,
  output = process.stderr,
) {
  if (!input.isTTY)
    throw new Error(
      "Run setup in an interactive terminal so the token can be entered without echo.",
    );
  const hidden = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const reader = createInterface({
    input,
    output: hidden,
    terminal: true,
    historySize: 0,
  });
  output.write("Discord bot token (hidden): ");
  try {
    return await new Promise((resolve, reject) => {
      reader.once("SIGINT", () => reject(new Error("Setup cancelled.")));
      reader.once("close", () => reject(new Error("Setup cancelled.")));
      reader.question("", resolve);
    });
  } finally {
    reader.close();
    output.write("\n");
  }
}

export async function setup({
  prompt = promptToken,
  makeDiscord = (token) => new Discord(token),
  file = configPath(),
} = {}) {
  const token = normalizeToken(await prompt());
  const identity = await makeDiscord(token).identity();
  await saveToken(token, file);
  return { identity, file };
}
