import { DiscordError } from "./discord.mjs";

const flags = {
  view: 10,
  history: 16,
  send: 11,
  send_in_threads: 38,
  attach_files: 15,
  add_reactions: 6,
  create_threads: 35,
  manage_threads: 34,
  send_polls: 49,
  pin_messages: 51,
};

export function createAccessChecker(discord, { channels = [], bot } = {}) {
  const requests = new Map(
    channels.map((channel) => [
      `/channels/${channel.id}`,
      Promise.resolve(channel),
    ]),
  );
  const get = (path) => {
    if (!requests.has(path)) requests.set(path, discord.request(path));
    return requests.get(path);
  };
  let identity = bot ? Promise.resolve(bot) : undefined;
  return async (channelId) => {
    const channel = await get(`/channels/${channelId}`);
    if (!channel.guild_id)
      throw new DiscordError("Only server channels and threads are supported.");
    const { id: botId } = await (identity ??= discord.identity());
    const member = await get(`/guilds/${channel.guild_id}/members/${botId}`);
    const roles = await get(`/guilds/${channel.guild_id}/roles`);
    const roleIds = new Set([channel.guild_id, ...member.roles]);
    let permissions = roles.reduce(
      (value, role) =>
        roleIds.has(role.id) ? value | BigInt(role.permissions) : value,
      0n,
    );
    const admin = Boolean(permissions & (1n << 3n));
    const thread = [10, 11, 12].includes(channel.type);
    const parent = thread
      ? await get(`/channels/${channel.parent_id}`)
      : channel;
    if (parent.guild_id !== channel.guild_id)
      throw new DiscordError("Could not verify channel permissions.");
    if (!admin) {
      const overwrites = parent.permission_overwrites;
      if (!Array.isArray(overwrites))
        throw new DiscordError("Could not verify channel permissions.");
      const apply = (items) => {
        let allow = 0n;
        let deny = 0n;
        for (const item of items) {
          allow |= BigInt(item.allow);
          deny |= BigInt(item.deny);
        }
        permissions = (permissions & ~deny) | allow;
      };
      apply(overwrites.filter((item) => item.id === channel.guild_id));
      apply(
        overwrites.filter(
          (item) =>
            item.type === 0 &&
            item.id !== channel.guild_id &&
            roleIds.has(item.id),
        ),
      );
      apply(overwrites.filter((item) => item.type === 1 && item.id === botId));
      if (Date.parse(member.communication_disabled_until ?? "") > Date.now())
        permissions &= (1n << 10n) | (1n << 16n);
    }
    const allowed = (name) =>
      admin || Boolean(permissions & (1n << BigInt(flags[name])));
    if (!allowed("view"))
      throw new DiscordError(
        "The bot cannot currently view this channel.",
        403,
      );
    if (
      [2, 13].includes(channel.type) &&
      !admin &&
      !(permissions & (1n << 20n))
    )
      throw new DiscordError(
        "The bot cannot currently connect to this voice channel.",
        403,
      );
    if (channel.type === 12 && !allowed("manage_threads"))
      await get(`/channels/${channelId}/thread-members/${botId}`);
    const capabilities = Object.fromEntries(
      Object.keys(flags).map((name) => [name, allowed(name)]),
    );
    capabilities.send =
      allowed(thread ? "send_in_threads" : "send") &&
      ![4, 15, 16].includes(channel.type) &&
      !(channel.thread_metadata?.locked && !allowed("manage_threads"));
    capabilities.add_reactions &&= allowed("history");
    capabilities.attach_files &&= capabilities.send;
    capabilities.send_polls &&= capabilities.send;
    return {
      channel,
      bot_id: botId,
      history: allowed("history"),
      capabilities,
      nsfw: Boolean(channel.nsfw || parent.nsfw),
    };
  };
}

export async function channelAccess(discord, channelId) {
  const { history } = await createAccessChecker(discord)(channelId);
  return { history };
}
