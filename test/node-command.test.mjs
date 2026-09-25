import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import test from "node:test";
import { nodeCommand } from "../src/node-command.mjs";

async function directory(t) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "discord-mcp-node-")),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function executable(file, content = "node") {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content);
  return file;
}

test("setup preserves a PATH link through replacement and removal of the old installation", async (t) => {
  const root = await directory(t);
  const name = process.platform === "win32" ? "node.exe" : "node";
  const oldNode = await executable(join(root, "v1", name), "old node");
  const newNode = await executable(join(root, "v2", name), "new node");
  const link = join(root, "bin");
  await symlink(dirname(oldNode), link, "junction");
  const command = await nodeCommand({
    execPath: oldNode,
    path: [dirname(oldNode), link].join(delimiter),
  });
  assert.equal(command, join(link, name));
  await rm(link, { recursive: true, force: true });
  await symlink(dirname(newNode), link, "junction");
  await rm(dirname(oldNode), { recursive: true, force: true });
  assert.equal(await readFile(command, "utf8"), "new node");
});

test("setup falls back when candidates are missing, relative, or point to another Node", async (t) => {
  const root = await directory(t);
  const node = await executable(join(root, "current", "node"));
  const other = await executable(join(root, "other", "node"));
  assert.equal(
    await nodeCommand({
      execPath: node,
      path: [
        "",
        ".",
        "relative/bin",
        join(root, "missing"),
        dirname(other),
        dirname(node),
      ].join(delimiter),
    }),
    node,
  );
});

test(
  "Homebrew setup prefers the stable prefix over the versioned PATH entry",
  { skip: process.platform === "win32" },
  async (t) => {
    const root = await directory(t);
    const node = await executable(
      join(root, "Cellar", "node", "26.7.0", "bin", "node"),
    );
    await mkdir(join(root, "bin"));
    const stable = join(root, "bin", "node");
    await symlink(node, stable);
    assert.equal(
      await nodeCommand({ execPath: node, path: dirname(node) }),
      stable,
    );
  },
);

test(
  "Homebrew versioned formulas use their opt link when the prefix selects another Node",
  { skip: process.platform === "win32" },
  async (t) => {
    const root = await directory(t);
    const node = await executable(
      join(root, "Cellar", "node@22", "22.14.0", "bin", "node"),
    );
    await executable(join(root, "bin", "node"), "another version");
    await mkdir(join(root, "opt"));
    await symlink(dirname(dirname(node)), join(root, "opt", "node@22"));
    assert.equal(
      await nodeCommand({ execPath: node, path: join(root, "bin") }),
      join(root, "opt", "node@22", "bin", "node"),
    );
  },
);
