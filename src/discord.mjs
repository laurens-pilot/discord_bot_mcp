import { setTimeout } from "node:timers/promises";

const API = "https://discord.com/api/v10";
const USER_AGENT =
  "DiscordBot (https://github.com/laurens-pilot/discord_bot_mcp, 0.1.0)";

export class DiscordError extends Error {}

export class Discord {
  #token;
  #fetch;
  #sleep;
  #queue = Promise.resolve();
  #globalReadyAt = 0;
  #buckets = new Map();
  #readyAt = new Map();

  constructor(token, fetchImpl = fetch, { sleep = setTimeout } = {}) {
    this.#token = token;
    this.#fetch = fetchImpl;
    this.#sleep = sleep;
  }

  request(path, body) {
    const result = this.#queue.then(() => this.#request(path, body));
    this.#queue = result.catch(() => {});
    return result;
  }

  #rateKey(route, major) {
    return `${this.#buckets.get(route) ?? route}:${major}`;
  }

  async #request(path, body, retries = 0, waitBudget = 5000) {
    const method = body ? "POST" : "GET";
    const pathname = path.split("?")[0];
    const route = `${method} ${pathname.replace(/\/\d+/g, "/:id")}`;
    const major = pathname.match(/^\/(channels|guilds)\/(\d+)/)?.[0] ?? "";
    const wait =
      Math.max(
        this.#globalReadyAt,
        this.#readyAt.get(this.#rateKey(route, major)) ?? 0,
        this.#readyAt.get(`${route}:${major}`) ?? 0,
      ) - Date.now();
    if (wait > 0) {
      if (body || wait > waitBudget)
        throw new DiscordError(
          `Discord rate limit: retry in ${Math.ceil(wait / 1000)} seconds.`,
        );
      await this.#sleep(wait);
      return this.#request(path, body, retries, waitBudget - wait);
    }
    const uncertain = body
      ? " Delivery is uncertain; read the channel before trying to send again."
      : " Try again later.";
    let response;
    let data;
    try {
      response = await this.#fetch(`${API}${path}`, {
        method,
        headers: {
          Authorization: `Bot ${this.#token}`,
          "User-Agent": USER_AGENT,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15000),
        redirect: "error",
      });
      data = await response.json().catch(() => null);
    } catch {
      throw new DiscordError(
        `Discord request failed or timed out.${uncertain}`,
      );
    }

    const bucket = response.headers.get("X-RateLimit-Bucket");
    if (bucket) this.#buckets.set(route, bucket);
    const global =
      response.status === 429 &&
      (data?.global === true ||
        response.headers.get("X-RateLimit-Global") === "true" ||
        response.headers.get("X-RateLimit-Scope") === "global");
    const reset =
      response.status === 429
        ? Number(
            data?.retry_after ?? response.headers.get("Retry-After") ?? NaN,
          )
        : response.headers.get("X-RateLimit-Remaining") === "0"
          ? Number(response.headers.get("X-RateLimit-Reset-After"))
          : 0;
    if (Number.isFinite(reset) && reset > 0) {
      const readyAt = Date.now() + Math.ceil(reset * 1000);
      if (global) this.#globalReadyAt = Math.max(this.#globalReadyAt, readyAt);
      else {
        for (const key of [`${route}:${major}`, this.#rateKey(route, major)])
          this.#readyAt.set(
            key,
            Math.max(this.#readyAt.get(key) ?? 0, readyAt),
          );
      }
    }

    if (response.status === 429) {
      if (
        !body &&
        retries < 2 &&
        Number.isFinite(reset) &&
        reset >= 0 &&
        Math.ceil(reset * 1000) <= waitBudget
      )
        return this.#request(path, body, retries + 1, waitBudget);
      throw new DiscordError(
        `Discord rate limit: retry in ${reset > 0 && Number.isFinite(reset) ? Math.ceil(reset) : "a few"} seconds.`,
      );
    }
    if (response.status === 401)
      throw new DiscordError(
        "Discord rejected the bot token. Run npm run setup again.",
      );
    if (response.status === 403)
      throw new DiscordError(
        "Discord denied access. Check the bot's server, channel, and thread permissions.",
      );
    if (response.status === 404)
      throw new DiscordError(
        "Discord could not find that server, channel, or message, or the bot cannot access it.",
      );
    if (!response.ok) {
      const code = Number.isInteger(data?.code) ? `, code ${data.code}` : "";
      throw new DiscordError(
        `Discord rejected the request (HTTP ${response.status}${code}).${response.status >= 500 ? uncertain : ""}`,
      );
    }
    if (data === null)
      throw new DiscordError(
        `Discord returned an unreadable response.${uncertain}`,
      );
    return data;
  }

  async identity() {
    const user = await this.request("/users/@me");
    if (!user.bot) throw new DiscordError("This is not a Discord bot account.");
    return { id: user.id, name: user.username };
  }
}
