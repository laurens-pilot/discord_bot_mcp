import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, sep } from "node:path";
import { configPath } from "./config.mjs";
import { DiscordError } from "./discord.mjs";

const MAX_BYTES = 24 * 1024 * 1024;

export async function uploadBody(
  payload,
  files,
  credentialFile = configPath(),
) {
  if (!files?.length) return payload;
  const form = new FormData();
  const directory = await realpath(dirname(credentialFile)).catch(() =>
    dirname(credentialFile),
  );
  const credential = await stat(credentialFile).catch(() => null);
  let total = 0;
  const attachments = [];
  for (const [index, file] of files.entries()) {
    if (!isAbsolute(file))
      throw new DiscordError("Upload paths must be absolute.");
    let handle;
    try {
      const path = await realpath(file);
      const location = relative(directory, path);
      if (
        !location ||
        (!location.startsWith(`..${sep}`) &&
          location !== ".." &&
          !isAbsolute(location))
      )
        throw new DiscordError(
          "Cannot upload files from the credential/cache directory.",
        );
      handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
      const info = await handle.stat();
      if (!info.isFile())
        throw new DiscordError("Uploads must be regular files.");
      if (
        credential &&
        info.dev === credential.dev &&
        info.ino === credential.ino
      )
        throw new DiscordError("Cannot upload the credential file.");
      if (info.size + total > MAX_BYTES)
        throw new DiscordError(
          "Uploads must total at most 24 MiB per message.",
        );
      const bytes = Buffer.alloc(info.size + 1);
      let length = 0;
      while (length < bytes.length) {
        const { bytesRead } = await handle.read(
          bytes,
          length,
          bytes.length - length,
          null,
        );
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length !== info.size)
        throw new DiscordError(
          "An upload changed while being read; try again with a stable file.",
        );
      total += length;
      const filename = basename(file);
      attachments.push({ id: index, filename });
      form.append(
        `files[${index}]`,
        new Blob([bytes.subarray(0, length)]),
        filename,
      );
    } catch (error) {
      if (error instanceof DiscordError) throw error;
      throw new DiscordError(
        "Could not read an upload. Check its path and permissions.",
      );
    } finally {
      await handle?.close();
    }
  }
  form.append("payload_json", JSON.stringify({ ...payload, attachments }));
  return form;
}
