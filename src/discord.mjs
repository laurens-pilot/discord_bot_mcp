const API = "https://discord.com/api/v10";
const USER_AGENT =
  "DiscordBot (https://github.com/laurens-pilot/discord_bot_mcp, 0.1.0)";

export class DiscordError extends Error {}

export class Discord {
  #token;
  #fetch;
  #queue = Promise.resolve();
  #readyAt = 0;

  constructor(token, fetchImpl = fetch) {
    this.#token = token;
    this.#fetch = fetchImpl;
  }

  request(path, body) {
    const result = this.#queue.then(() => this.#request(path, body));
    this.#queue = result.catch(() => {});
    return result;
  }

  async #request(path, body) {
    const wait = (this.#readyAt - Date.now()) / 1000;
    if (wait > 0)
      throw new DiscordError(
        `Discord rate limit: retry in ${Math.ceil(wait)} seconds.`,
      );
    const uncertain = body
      ? " Delivery is uncertain; read the channel before trying to send again."
      : " Try again later.";
    let response;
    let data;
    try {
      response = await this.#fetch(`${API}${path}`, {
        method: body ? "POST" : "GET",
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

    const reset =
      response.status === 429
        ? Number(data?.retry_after ?? response.headers.get("Retry-After"))
        : response.headers.get("X-RateLimit-Remaining") === "0"
          ? Number(response.headers.get("X-RateLimit-Reset-After"))
          : 0;
    if (Number.isFinite(reset) && reset > 0)
      this.#readyAt = Date.now() + Math.ceil(reset * 1000);

    if (response.status === 429) {
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
