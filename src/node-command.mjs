import { realpath } from "node:fs/promises";
import { basename, delimiter, isAbsolute, join } from "node:path";

export async function nodeCommand({
  execPath = process.execPath,
  path = process.env.PATH ?? "",
} = {}) {
  const executable = await realpath(execPath);
  const homebrew = executable.match(
    /^(.*)\/Cellar\/([^/]+)\/[^/]+\/bin\/node$/,
  );
  const candidates = homebrew
    ? [
        join(homebrew[1], "bin", "node"),
        join(homebrew[1], "opt", homebrew[2], "bin", "node"),
      ]
    : [];
  candidates.push(
    ...path
      .split(delimiter)
      .filter(isAbsolute)
      .map((directory) => join(directory, basename(execPath))),
  );
  for (const candidate of candidates) {
    if (candidate === executable || candidate === execPath) continue;
    if ((await realpath(candidate).catch(() => null)) === executable)
      return candidate;
  }
  return execPath;
}
