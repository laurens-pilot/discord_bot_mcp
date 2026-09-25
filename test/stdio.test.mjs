import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { configPath, saveToken } from "../src/config.mjs";

const cli = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
const token = "fake-stdio-token-that-must-not-be-printed";

async function environment(t) {
  const root = await mkdtemp(join(tmpdir(), "discord-mcp-stdio-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    root,
    env: { ...process.env, XDG_CONFIG_HOME: root, APPDATA: root },
  };
}

test("CLI fails clearly with no credentials and keeps stdout clean", async (t) => {
  const { root, env } = await environment(t);
  const result = spawnSync(process.execPath, [cli], {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Run npm run setup/);
});

test("setup refuses token arguments and piped tokens without echoing them", async (t) => {
  const { env } = await environment(t);
  for (const args of [
    [cli, "setup", token],
    [cli, "setup"],
  ]) {
    const result = spawnSync(process.execPath, args, {
      env,
      input: `${token}\n`,
      encoding: "utf8",
      timeout: 5000,
    });
    assert.equal(result.status, 1);
    assert.ok(!(result.stdout + result.stderr).includes(token));
  }
});

for (const mode of ["legacy", { pin: "2026-07-28" }]) {
  test(`stdio MCP works after restart from another directory (${JSON.stringify(mode)})`, async (t) => {
    const { root, env } = await environment(t);
    await saveToken(token, configPath(env));
    const preload = join(root, "mock-discord.mjs");
    await writeFile(
      preload,
      `globalThis.fetch = async (url, options) => {
      if (options.headers.Authorization !== ${JSON.stringify(`Bot ${token}`)}) throw new Error("Wrong token");
      if (url === "https://discord.com/api/v10/users/@me/guilds?limit=100") return new Response(JSON.stringify([{ id: "123456789012345678", name: "Test server" }]));
      if (url === "https://discord.com/api/v10/channels/234567890123456789/messages?limit=1&before=1552832004096000000") return new Response(JSON.stringify([{ id: "1552469616230400000", channel_id: "234567890123456789", author: { id: "123456789012345678", username: "tester" }, timestamp: "2026-09-24T00:00:00Z", content: "Inside the time range" }]));
      if (url === "https://discord.com/api/v10/channels/234567890123456789/messages" && options.method === "POST") return new Response(JSON.stringify({ id: "345678901234567890", channel_id: "234567890123456789" }));
      throw new Error("Unexpected network request");
    };`,
    );
    const client = new Client(
      { name: "stdio-test", version: "1.0.0" },
      { versionNegotiation: { mode } },
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", pathToFileURL(preload).href, cli],
      cwd: root,
      env,
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr.on("data", (data) => {
      stderr += data;
    });
    t.after(() => client.close());
    await client.connect(transport);
    assert.equal((await client.listTools()).tools.length, 4);
    const read = await client.callTool({ name: "list_servers", arguments: {} });
    assert.deepEqual(JSON.parse(read.content[0].text), {
      servers: [{ id: "123456789012345678", name: "Test server" }],
      next_after: null,
    });
    const history = await client.callTool({
      name: "read_messages",
      arguments: {
        channel_id: "234567890123456789",
        since: "2026-09-24T00:00:00Z",
        until: "2026-09-25T00:00:00Z",
        limit: 1,
      },
    });
    assert.ok(!history.isError);
    assert.equal(
      JSON.parse(history.content[0].text).messages[0].content,
      "Inside the time range",
    );
    assert.equal(JSON.parse(history.content[0].text).next_before, null);
    const send = await client.callTool({
      name: "send_message",
      arguments: { channel_id: "234567890123456789", content: "Test message" },
    });
    assert.equal(JSON.parse(send.content[0].text).id, "345678901234567890");
    assert.ok(!JSON.stringify([read, send]).includes(token));
    await client.close();
    assert.equal(stderr, "");
  });
}
