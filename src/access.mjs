import { DiscordError } from "./discord.mjs";

const VIEW_CHANNEL = 1n << 10n;
const READ_MESSAGE_HISTORY = 1n << 16n;
const MANAGE_THREADS = 1n << 34n;
const ADMINISTRATOR = 1n << 3n;

export async function channelAccess(discord, channelId) {
  const channel = await discord.request(`/channels/${channelId}`);
  if (!channel.guild_id)
    throw new DiscordError("Only server channels and threads are supported.");
  const { id: botId } = await discord.identity();
  const member = await discord.request(
    `/guilds/${channel.guild_id}/members/${botId}`,
  );
  const roles = await discord.request(`/guilds/${channel.guild_id}/roles`);
  const roleIds = new Set([channel.guild_id, ...member.roles]);
  let permissions = roles.reduce(
    (value, role) =>
      roleIds.has(role.id) ? value | BigInt(role.permissions) : value,
    0n,
  );
  const admin = (permissions & ADMINISTRATOR) !== 0n;
  const thread = [10, 11, 12].includes(channel.type);
  const parent = thread
    ? await discord.request(`/channels/${channel.parent_id}`)
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
    if (!(permissions & VIEW_CHANNEL))
      throw new DiscordError("The bot cannot currently view this channel.");
    if (channel.type === 12 && !(permissions & MANAGE_THREADS))
      await discord.request(`/channels/${channelId}/thread-members/${botId}`);
  }
  return { history: admin || (permissions & READ_MESSAGE_HISTORY) !== 0n };
}
