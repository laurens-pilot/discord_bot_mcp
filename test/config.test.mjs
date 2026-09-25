import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  stat,
  writeFile,
  chmod,
  rm,
  readdir,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  configPath,
  loadToken,
  normalizeToken,
  saveToken,
} from "../src/config.mjs";
import { promptToken, setup } from "../src/setup.mjs";

const token = "test-token-that-is-not-a-real-credential";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "discord-mcp-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return join(root, "private", "config.json");
}

test("credentials survive restart and replacement, with private permissions", async (t) => {
  const file = await fixture(t);
  await saveToken(token, file);
  assert.equal(await loadToken(file), token);
  await saveToken(`${token}-replacement`, file);
  assert.equal(await loadToken(file), `${token}-replacement`);
  assert.deepEqual(await readdir(join(file, "..")), ["config.json"]);
  if (process.platform !== "win32") {
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal((await stat(join(file, ".."))).mode & 0o777, 0o700);
    await chmod(file, 0o644);
    await assert.rejects(loadToken(file), /insecure/);
    await saveToken(token, file);
    assert.equal(await loadToken(file), token);
  }
});

test("missing, corrupt, and non-file credentials give a setup instruction without contents", async (t) => {
  const file = await fixture(t);
  await assert.rejects(loadToken(file), /Run npm run setup/);
  await saveToken(token, file);
  await writeFile(file, token);
  await assert.rejects(
    loadToken(file),
    (error) => !error.message.includes(token) && /setup/.test(error.message),
  );
  await assert.rejects(loadToken(join(file, "..")), /setup/);
});

test(
  "credential symlinks are refused",
  { skip: process.platform === "win32" },
  async (t) => {
    const file = await fixture(t);
    await saveToken(token, file);
    const link = join(file, "..", "link.json");
    await symlink(file, link);
    await assert.rejects(loadToken(link), /insecure/);
    const directoryLink = join(file, "..", "linked-directory");
    await symlink(join(file, ".."), directoryLink);
    await assert.rejects(
      saveToken(token, join(directoryLink, "config.json")),
      /symbolic link/,
    );
  },
);

test("config location is independent of the working directory", () => {
  const home = tmpdir();
  assert.equal(
    configPath({}, "linux", home),
    join(home, ".config", "discord-bot-mcp", "config.json"),
  );
  assert.equal(
    configPath({ XDG_CONFIG_HOME: home }, "darwin", "ignored"),
    join(home, "discord-bot-mcp", "config.json"),
  );
  assert.equal(
    configPath({ APPDATA: home }, "win32", "ignored"),
    join(home, "discord-bot-mcp", "config.json"),
  );
  assert.throws(
    () => configPath({ XDG_CONFIG_HOME: "relative" }, "linux", home),
    /absolute/,
  );
});

test("token validation never includes the rejected value", () => {
  assert.equal(normalizeToken(` ${token} `), token);
  for (const value of [
    undefined,
    "",
    `Bot ${token}`,
    `${token}\nheader`,
    "a".repeat(301),
  ]) {
    assert.throws(
      () => normalizeToken(value),
      (error) => !error.message.includes(token),
    );
  }
});

test("setup validates before saving and preserves existing credentials on failure", async (t) => {
  const file = await fixture(t);
  const identity = { id: "123456789012345678", name: "Test bot" };
  const result = await setup({
    file,
    prompt: async () => token,
    makeDiscord: (actual) => {
      assert.equal(actual, token);
      return { identity: async () => identity };
    },
  });
  assert.deepEqual(result, { identity, file });
  await assert.rejects(
    setup({
      file,
      prompt: async () => `${token}-invalid`,
      makeDiscord: () => ({
        identity: async () => {
          throw new Error("Rejected");
        },
      }),
    }),
    /Rejected/,
  );
  assert.equal(JSON.parse(await readFile(file, "utf8")).token, token);
});

test("the terminal prompt does not echo a pasted token", async () => {
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => {};
  const output = new PassThrough();
  let printed = "";
  output.on("data", (chunk) => {
    printed += chunk;
  });
  const prompted = promptToken(input, output);
  input.write(`${token}\r`);
  assert.equal(await prompted, token);
  assert.match(printed, /hidden/);
  assert.ok(!printed.includes(token));
  input.destroy();
  output.destroy();
});

test("setup refuses noninteractive input and supports cancellation", async () => {
  await assert.rejects(promptToken(new PassThrough()), /interactive terminal/);
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => {};
  const output = new PassThrough();
  const prompted = promptToken(input, output);
  input.write("\u0003");
  await assert.rejects(prompted, /cancelled/);
  input.destroy();
  output.destroy();
});
