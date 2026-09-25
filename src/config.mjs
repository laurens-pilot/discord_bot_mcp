import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

export function configPath(
  env = process.env,
  platform = process.platform,
  home = homedir(),
) {
  const base =
    platform === "win32"
      ? env.APPDATA || join(home, "AppData", "Roaming")
      : env.XDG_CONFIG_HOME || join(home, ".config");
  if (!isAbsolute(base))
    throw new Error("The configuration directory must be an absolute path.");
  return join(base, "discord-bot-mcp", "config.json");
}

export function normalizeToken(value) {
  if (typeof value !== "string" || !/^[\w.-]{20,300}$/.test(value.trim())) {
    throw new Error(
      "Enter the bot token from Discord's Bot page, without the Bot prefix.",
    );
  }
  return value.trim();
}

export async function saveToken(token, file = configPath()) {
  token = normalizeToken(token);
  const directory = dirname(file);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await lstat(directory)).isSymbolicLink()) {
    throw new Error("The credential directory must not be a symbolic link.");
  }
  await chmod(directory, 0o700);
  const temporary = join(directory, `.config-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify({ token }) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function loadToken(file = configPath()) {
  try {
    const info = await lstat(file);
    if (
      !info.isFile() ||
      (process.platform !== "win32" && (info.mode & 0o077) !== 0)
    ) {
      throw new Error("Unsafe credential file.");
    }
    return normalizeToken(JSON.parse(await readFile(file, "utf8")).token);
  } catch {
    throw new Error(
      "Bot token is missing, unreadable, or insecure. Run npm run setup in the repository.",
    );
  }
}
