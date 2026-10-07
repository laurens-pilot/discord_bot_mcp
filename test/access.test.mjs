import assert from "node:assert/strict";
import test from "node:test";
import { channelAccess } from "../src/access.mjs";

function fixture({
  permissions = 1024n,
  overwrites = [],
  memberRoles = [],
  roles = [],
  type = 0,
  membership = true,
} = {}) {
  const calls = [];
  const channel = {
    id: "20",
    guild_id: "10",
    type,
    parent_id: "21",
    permission_overwrites: overwrites,
  };
  const discord = {
    identity: async () => ({ id: "30" }),
    request: async (path) => {
      calls.push(path);
      if (path === "/channels/20") return channel;
      if (path === "/channels/21") return { ...channel, type: 0 };
      if (path.endsWith("/members/30")) return { roles: memberRoles };
      if (path.endsWith("/roles"))
        return [{ id: "10", permissions: String(permissions) }, ...roles];
      if (path.endsWith("/thread-members/30") && membership)
        return { user_id: "30" };
      throw new Error("Access denied");
    },
  };
  return { discord, calls, channel };
}

test("access distinguishes view-only from full history and rechecks revocations", async () => {
  const { discord, channel } = fixture();
  assert.deepEqual(await channelAccess(discord, "20"), { history: false });
  channel.permission_overwrites = [
    { id: "30", type: 1, allow: "0", deny: "1024" },
  ];
  await assert.rejects(channelAccess(discord, "20"), /cannot currently view/);
  assert.equal(
    (await channelAccess(fixture({ permissions: 66560n }).discord, "20"))
      .history,
    true,
  );
  assert.equal(
    (await channelAccess(fixture({ permissions: 8n }).discord, "20")).history,
    true,
  );
});

test("permission overwrites apply everyone, combined roles, then member", async () => {
  const options = {
    permissions: 66560n,
    memberRoles: ["40", "41"],
    roles: [
      { id: "40", permissions: "0" },
      { id: "41", permissions: "0" },
    ],
    overwrites: [
      { id: "10", type: 0, deny: "1024", allow: "0" },
      { id: "40", type: 0, deny: "1024", allow: "0" },
      { id: "41", type: 0, deny: "0", allow: "1024" },
      { id: "30", type: 1, deny: "65536", allow: "0" },
    ],
  };
  assert.equal(
    (await channelAccess(fixture(options).discord, "20")).history,
    false,
  );
});

test("threads inherit parent permissions and private threads require membership or management", async () => {
  const publicThread = fixture({ type: 11 });
  assert.equal(
    (await channelAccess(publicThread.discord, "20")).history,
    false,
  );
  assert.ok(publicThread.calls.includes("/channels/21"));
  await assert.rejects(
    channelAccess(fixture({ type: 12, membership: false }).discord, "20"),
    /denied/,
  );
  assert.equal(
    (await channelAccess(fixture({ type: 12 }).discord, "20")).history,
    false,
  );
  assert.equal(
    (
      await channelAccess(
        fixture({
          type: 12,
          permissions: (1n << 34n) | 1024n,
          membership: false,
        }).discord,
        "20",
      )
    ).history,
    false,
  );
});

test("unknown permissions and non-server channels fail closed", async () => {
  const { discord, channel } = fixture();
  delete channel.permission_overwrites;
  await assert.rejects(channelAccess(discord, "20"), /verify/);
  delete channel.guild_id;
  await assert.rejects(channelAccess(discord, "20"), /Only server/);
});
