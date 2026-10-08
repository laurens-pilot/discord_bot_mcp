import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, openSync, closeSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { configPath } from "./config.mjs";

const MAX_MESSAGES = 5000;
const MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const key = (id) => String(id).padStart(20, "0");

export function cachePath(token, file = configPath()) {
  const hash = createHash("sha256").update(token).digest("hex").slice(0, 24);
  return join(dirname(file), `messages-${hash}.sqlite`);
}

function secureFile(file) {
  try {
    const fd = openSync(file, "wx", 0o600);
    closeSync(fd);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  if (!lstatSync(file).isFile())
    throw new Error("Cache files must be regular files, not symbolic links.");
  chmodSync(file, 0o600);
}

export class MessageCache {
  #db;
  #now;

  constructor(file, { now = Date.now } = {}) {
    this.file = file;
    this.#now = now;
    const directory = dirname(file);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (lstatSync(directory).isSymbolicLink())
      throw new Error("The cache directory must not be a symbolic link.");
    chmodSync(directory, 0o700);
    for (const suffix of ["", "-wal", "-shm"]) secureFile(file + suffix);
    const mask = process.umask(0o077);
    try {
      this.#db = new DatabaseSync(file);
      this.#db.exec(`
        PRAGMA busy_timeout = 5000;
        PRAGMA journal_mode = WAL;
        PRAGMA secure_delete = ON;
        PRAGMA journal_size_limit = 1048576;
        CREATE TABLE IF NOT EXISTS messages (
          id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, guild_id TEXT NOT NULL,
          received_at INTEGER NOT NULL, data TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS channel_messages ON messages(channel_id, id);
        CREATE INDEX IF NOT EXISTS message_age ON messages(received_at);
        CREATE TABLE IF NOT EXISTS state (name TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS sent_messages (
          id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, received_at INTEGER NOT NULL
        );
      `);
      this.prune();
    } catch (error) {
      this.#db?.close();
      throw error;
    } finally {
      process.umask(mask);
    }
  }

  setState(value) {
    this.#db
      .prepare("INSERT OR REPLACE INTO state VALUES ('listener', ?)")
      .run(JSON.stringify({ ...value, updated_at: this.#now() }));
  }

  coverage() {
    const row = this.#db
      .prepare("SELECT value FROM state WHERE name = 'listener'")
      .get();
    const state = row ? JSON.parse(row.value) : { status: "stopped" };
    return {
      source: "gateway_cache",
      complete: false,
      listener:
        this.#now() - (state.updated_at ?? 0) > 15000
          ? "stopped"
          : state.status,
      ...(state.error ? { error: state.error } : {}),
      retention_days: 7,
      max_messages: MAX_MESSAGES,
      note: "Observed messages only; offline periods, access changes and eviction leave gaps. Edits, deletions, reactions, polls and attachment URLs may be stale. Missing counts are unknown.",
    };
  }

  capture({ t: type, d: data }) {
    if (type === "MESSAGE_CREATE" && data.guild_id && data.author) {
      const selected = Object.fromEntries(
        [
          "id",
          "channel_id",
          "guild_id",
          "author",
          "timestamp",
          "content",
          "type",
          "message_reference",
          "thread",
          "attachments",
          "embeds",
          "edited_timestamp",
          "pinned",
          "poll",
          "reactions",
          "sticker_items",
          "mentions",
          "mention_roles",
          "mention_everyone",
          "webhook_id",
          "message_snapshots",
        ]
          .filter((field) => data[field] !== undefined)
          .map((field) => [field, data[field]]),
      );
      selected.reactions ??= [];
      const encoded = JSON.stringify(selected);
      if (Buffer.byteLength(encoded) > 65536) return;
      this.#db
        .prepare("INSERT OR IGNORE INTO messages VALUES (?, ?, ?, ?, ?)")
        .run(
          key(data.id),
          data.channel_id,
          data.guild_id,
          this.#now(),
          encoded,
        );
      this.prune();
    } else if (type === "MESSAGE_UPDATE") {
      const row = this.#db
        .prepare("SELECT data FROM messages WHERE id = ? AND channel_id = ?")
        .get(key(data.id), data.channel_id);
      if (!row) return;
      const previous = JSON.parse(row.data);
      for (const field of [
        "content",
        "author",
        "attachments",
        "embeds",
        "message_reference",
        "thread",
        "edited_timestamp",
        "pinned",
        "poll",
        "reactions",
        "sticker_items",
        "mentions",
        "mention_roles",
        "mention_everyone",
      ])
        if (data[field] !== undefined) previous[field] = data[field];
      const encoded = JSON.stringify(previous);
      if (Buffer.byteLength(encoded) <= 65536)
        this.#db
          .prepare("UPDATE messages SET data = ? WHERE id = ?")
          .run(encoded, key(data.id));
    } else if (
      type.startsWith("MESSAGE_REACTION_") ||
      type.startsWith("MESSAGE_POLL_VOTE_")
    ) {
      const row = this.#db
        .prepare("SELECT data FROM messages WHERE id = ? AND channel_id = ?")
        .get(key(data.message_id), data.channel_id);
      if (!row) return;
      const message = JSON.parse(row.data);
      if (type.startsWith("MESSAGE_POLL_VOTE_")) {
        if (message.poll) delete message.poll.results;
      } else if (type === "MESSAGE_REACTION_REMOVE_ALL") message.reactions = [];
      else {
        if (!Array.isArray(message.reactions)) return;
        const matches = (reaction) =>
          reaction.emoji.id
            ? reaction.emoji.id === data.emoji.id
            : reaction.emoji.name === data.emoji.name;
        const reactions = message.reactions ?? [];
        let reaction = reactions.find(matches);
        if (type === "MESSAGE_REACTION_ADD") {
          if (!reaction) {
            reaction = {
              emoji: data.emoji,
              count: 0,
              count_details: { normal: 0, burst: 0 },
            };
            reactions.push(reaction);
          }
          reaction.count++;
          if (reaction.count_details)
            reaction.count_details[data.burst ? "burst" : "normal"]++;
        } else if (type === "MESSAGE_REACTION_REMOVE" && reaction) {
          reaction.count = Math.max(0, reaction.count - 1);
          if (reaction.count_details) {
            const key = data.burst ? "burst" : "normal";
            reaction.count_details[key] = Math.max(
              0,
              reaction.count_details[key] - 1,
            );
          }
        }
        message.reactions = reactions.filter(
          (item) =>
            item.count > 0 &&
            !(type === "MESSAGE_REACTION_REMOVE_EMOJI" && matches(item)),
        );
      }
      const encoded = JSON.stringify(message);
      if (Buffer.byteLength(encoded) <= 65536)
        this.#db
          .prepare("UPDATE messages SET data = ? WHERE id = ?")
          .run(encoded, key(data.message_id));
    } else if (["MESSAGE_DELETE", "MESSAGE_DELETE_BULK"].includes(type)) {
      const remove = this.#db.prepare(
        "DELETE FROM messages WHERE id = ? AND channel_id = ?",
      );
      for (const id of data.ids ?? [data.id]) {
        remove.run(key(id), data.channel_id);
        this.#db
          .prepare("DELETE FROM sent_messages WHERE id = ? AND channel_id = ?")
          .run(key(id), data.channel_id);
      }
    } else if (["CHANNEL_DELETE", "THREAD_DELETE"].includes(type)) {
      this.#db
        .prepare("DELETE FROM messages WHERE channel_id = ?")
        .run(data.id);
    } else if (type === "GUILD_DELETE" && !data.unavailable) {
      this.#db.prepare("DELETE FROM messages WHERE guild_id = ?").run(data.id);
    }
  }

  prune() {
    this.#db
      .prepare("DELETE FROM sent_messages WHERE received_at < ?")
      .run(this.#now() - MAX_AGE);
    this.#db
      .prepare(
        "DELETE FROM sent_messages WHERE id IN (SELECT id FROM sent_messages ORDER BY received_at DESC, id DESC LIMIT -1 OFFSET ?)",
      )
      .run(MAX_MESSAGES);
    this.#db
      .prepare("DELETE FROM messages WHERE received_at < ?")
      .run(this.#now() - MAX_AGE);
    this.#db
      .prepare(
        "DELETE FROM messages WHERE id IN (SELECT id FROM messages ORDER BY received_at DESC, id DESC LIMIT -1 OFFSET ?)",
      )
      .run(MAX_MESSAGES);
  }

  read(
    channelId,
    { message_id, lower = 0n, upper = 1n << 64n, limit = 20 } = {},
  ) {
    this.prune();
    if (!message_id && (lower >= 1n << 64n || upper <= lower || upper <= 0n))
      return { messages: [], next_before: null, coverage: this.coverage() };
    const rows = message_id
      ? this.#db
          .prepare("SELECT data FROM messages WHERE channel_id = ? AND id = ?")
          .all(channelId, key(message_id))
      : this.#db
          .prepare(
            "SELECT data FROM messages WHERE channel_id = ? AND id >= ? AND id < ? ORDER BY id DESC LIMIT ?",
          )
          .all(channelId, key(lower < 0n ? 0n : lower), key(upper), limit + 1);
    const messages = rows.slice(0, limit).map((row) => JSON.parse(row.data));
    return {
      messages,
      next_before: rows.length > limit ? messages.at(-1).id : null,
      coverage: this.coverage(),
    };
  }

  close() {
    this.#db.close();
  }

  rememberSent(channelId, messageId) {
    this.#db
      .prepare("INSERT OR REPLACE INTO sent_messages VALUES (?, ?, ?)")
      .run(key(messageId), channelId, this.#now());
    this.prune();
  }

  wasSent(channelId, messageId) {
    this.prune();
    return Boolean(
      this.#db
        .prepare("SELECT id FROM sent_messages WHERE id = ? AND channel_id = ?")
        .get(key(messageId), channelId),
    );
  }

  serverMessages(serverId) {
    this.prune();
    return this.#db
      .prepare("SELECT data FROM messages WHERE guild_id = ? ORDER BY id DESC")
      .all(serverId)
      .map((row) => JSON.parse(row.data));
  }
}
