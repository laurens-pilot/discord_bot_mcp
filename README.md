# discord_bot_mcp

A small local [MCP](https://modelcontextprotocol.io/) server for reading and sending Discord messages through a bot. Fifteen focused tools, one-time token setup, and no build step. A local Gateway listener caches newly observed messages, including in channels where the bot can view new messages but cannot read history.

| Tool                  | Purpose                                                                |
| --------------------- | ---------------------------------------------------------------------- |
| `list_servers`        | Find servers the bot has joined.                                       |
| `list_channels`       | Find channels and active threads; optionally inspect permissions.      |
| `list_emojis`         | Find server custom emojis and their reaction/message formats.          |
| `read_messages`       | Read history or observed cache, including reactions and polls.         |
| `search_messages`     | Search with every documented Discord filter, or search observed cache. |
| `send_message`        | Send text, files, replies, or a poll; silent by default.               |
| `create_thread`       | Create a public thread, optionally from an existing message.           |
| `edit_message`        | Edit text on the bot's own message.                                    |
| `delete_message`      | Delete only the bot's own message.                                     |
| `list_threads`        | Discover archived public threads and forum posts.                      |
| `list_pins`           | Read pinned messages.                                                  |
| `set_reaction`        | Add an emoji or remove the bot's own reaction.                         |
| `list_reaction_users` | List users of a normal or super reaction.                              |
| `list_poll_voters`    | List voters for one poll answer.                                       |
| `end_poll`            | End a poll created by the bot.                                         |

The MCP client starts the server when needed. It communicates over standard input/output, uses Discord's HTTP API for requests, and connects to the Gateway for live events. The cache is a private SQLite file outside the checkout. No database server is needed.

## Install

Requires **Node.js 22.14 or later** and Git. Each colleague installs and configures their own local copy.

```sh
git clone https://github.com/laurens-pilot/discord_bot_mcp.git
cd discord_bot_mcp
npm ci
npm run setup
```

Paste the bot token into the hidden terminal prompt. Setup verifies that Discord accepts it as a bot token before saving it, then prints an MCP configuration containing the absolute paths for your machine. The token is never included in that configuration. Running setup again replaces the saved token after validation.

Setup prefers a stable Node path that points to the running executable, including Homebrew's `bin/node` or `opt/<formula>/bin/node` links and matching links on your `PATH`. If none is available, it uses the current executable's path; update your MCP configuration if that installation is later removed.

## Create and invite a Discord bot

1. Open the [Discord Developer Portal](https://discord.com/developers/applications) and create an application, or use an existing bot you manage.
2. On its **Bot** page, enable **Message Content Intent** under Privileged Gateway Intents. This is needed for ordinary message text and attachments. Larger verified bots may need Discord's approval for this intent. The listener requests Guilds, Guild Messages, Guild Message Reactions, Guild Message Polls, and Message Content intents.
3. Copy or reset the bot token on the Bot page, then enter it in `npm run setup`. Resetting a token invalidates existing copies, including those used by colleagues.
4. Use the application's installation settings or OAuth2 URL Generator to create a server installation link with the `bot` scope. Grant **View Channels**, plus **Send Messages**, **Send Messages in Threads**, **Create Public Threads**, **Attach Files**, **Add Reactions**, and **Send Polls** as needed. **Read Message History** enables historical reads and replies; without it, reads are limited to newly observed cached messages. Administrator permission is unnecessary.
5. Open the installation link and add the bot to your server. A server administrator may need to do this. Configure channel overrides and private-thread membership to match the access you intend to give the bot.

The bot's permissions apply to every local client using its token. Colleagues can use separate bots or an approved shared bot; each enters the appropriate token locally. Sharing this repository does not share credentials.

## Connect an MCP client

Setup prints a ready-to-copy configuration in the common `mcpServers` format:

```json
{
  "mcpServers": {
    "discord": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/discord_bot_mcp/src/cli.mjs"]
    }
  }
}
```

Paste it into your client's MCP settings. If the client uses a different configuration format, use the same command and argument in its local/stdio server settings. Absolute paths avoid desktop applications having a different `PATH` or working directory. No token or environment variable is required in the client's configuration. Restart the connection after adding the server, updating its tools, or replacing the token. If your client has a tool allowlist, include the tools above that you want to enable. Restart any persistent `npm run listen` process after updating too, so it captures the new reaction and poll events.

Try asking the agent:

> List the Discord servers, find #general in my team server, and read its latest 10 messages.

To send, give the agent the intended server/channel and message or local files. Messages are posted as the bot. Replies use the optional `reply_to` message ID and require Read Message History. User, role, everyone, and reply mentions never ping. Sends default to `silent: true`, which sets Discord's `SUPPRESS_NOTIFICATIONS` flag (`4096`) to suppress push/desktop notifications; unread indicators can still appear. Set `silent: false` to allow ordinary notifications. A literal `@silent` prefix is not required by this API.

## Live capture and coverage

Capture runs while the MCP process is active. To keep receiving messages between agent sessions, run this in a persistent terminal, or configure your OS service manager to run the same command at login:

```sh
npm run listen
```

Only one listener runs per token/config directory on a machine; other MCP processes share the cache and take over if the listener stops. Separate machines keep separate caches and Gateway connections. The Gateway library handles heartbeats, reconnections, and session resumption. Stopping the process loses its resumable session; the cache survives restarts. Closing an MCP client's input stops its listener cleanly. `listen` continues until you stop it.

`read_messages` checks current server membership, roles, channel overrides, and private-thread access before choosing a source. With Read Message History it uses Discord's HTTP history. Without that permission it reads the cache, with the same pagination, time bounds, and exact-ID options. If access cannot be verified, the read fails; HTTP failures are not silently replaced with cached data.

Cached responses include `coverage.source: "gateway_cache"`, `coverage.complete: false`, listener status, and retention limits. **A cached empty result does not prove no messages were sent.** Capture starts when a listener connects, not retroactively when the bot was invited or granted access. Offline periods, permission changes, missed events, and eviction leave gaps. The cache cannot backfill messages without history permission. Exact-ID reads return an empty list with coverage if that message was not captured.

The cache retains up to **5,000 messages total across servers**, for **seven days after receipt**, with a 64 KiB limit per stored message. It applies observed edits, deletes, bulk deletes, reaction events, and channel/thread/server removals. Poll vote events invalidate cached vote totals rather than presenting stale totals as current; a later message update can refresh them. Missing poll totals or reaction counts mean unknown, not zero. Messages retained from an older listener may lack the new fields. Offline edits or deletions may leave stale data. Cached attachment URLs may expire and cannot be refreshed without history access. Pruning runs while a listener is active and whenever the cache is opened or read.

## Tool behavior

- IDs are strings. Discover them with the listing tools or copy them from Discord with Developer Mode enabled. For a message link, use the last two path segments as `channel_id` and `message_id`.
- `list_servers` returns up to 100 servers and `next_after`. Pass that value as `after` for the next page.
- `list_channels` accepts optional `channel_id` to narrow the listing and `include_permissions: true` for current capabilities. Permission details are opt-in; narrow to a channel to keep requests and output small. It returns channel metadata and visible active threads, including forum posts. Channel metadata is not a permission check: Discord can list a channel while denying access to its messages. Archived threads are not listed, but a known thread ID works if the bot can access it.
- `read_messages` defaults to 20 messages and accepts `limit` from 1 to 100. Results are newest first. Pass `next_before` as `before` for older messages, or use `message_id` to fetch one. `limit` is ignored with `message_id`. A non-null cursor means another page may exist, not that more results are guaranteed.
- Use optional `since` (inclusive) and `until` (exclusive) to restrict message creation times. Supply ISO 8601 timestamps with `Z` or an explicit offset, with at most three fractional second digits. Either bound may be omitted; when both are supplied, `since` must be earlier than `until`. Time bounds and `before` cannot be combined with `message_id`.
- Reads preserve message text, author, channel ID, timestamps, references, forwarded snapshots, attachment links, selected embed fields, pin status, stickers, reaction counts, and poll questions/answers/results when available. They do not return Discord's full message object. Attachment links expire; HTTP history reads can refresh them, cached reads cannot.
- Forum and media channels contain posts: use a post's thread ID to read or send messages. Creating forum/media posts, private-thread creation, pin/unpin mutations, moderation, and DMs are outside this server's scope.
- `create_thread` takes a parent `channel_id`, a nonblank `name` of 1–100 characters, and optional `message_id`. Without `message_id`, it creates a standalone public thread in a text channel. With `message_id`, it starts a thread on that message in a text or announcement channel. Discord permits one thread per message. Private-thread creation and forum/media posts are not supported. Public threads inherit access from the parent channel; they do not make a private server public.
- Successful creation returns `thread_id` and `parent_id`. Use `thread_id` as `channel_id` with the existing read/send tools. Creation can produce Discord system messages and exposes no notification-suppression flag; the tool does not accept `silent`. Messages subsequently sent through `send_message` remain silent by default.
- `send_message` accepts 1–2,000 characters of nonblank `content` and/or `files` or a `poll`, optionally `reply_to` and `silent`. `files` is an array of 1–10 absolute local paths, totaling at most 24 MiB per message. Discord may enforce a lower upload limit. Files must be readable regular files; the credential/cache directory and credential aliases cannot be uploaded. Files are uploaded as multipart attachments, without modifying their contents. Successful sends return the message ID and channel ID.
- Each HTTP request times out after 15 seconds. Cooldowns are tracked per Discord bucket and server/channel, separately from global limits. Reads wait through short cooldowns and retry rate-limit responses at most twice, with a total wait budget of five seconds per request. Longer cooldowns report when to try again. All writes, including edits, deletions, reactions and poll closure, are never automatically retried. If delivery is uncertain, inspect channel history before sending again. For uncertain thread creation, check `list_channels` before trying again.

Create a thread from an existing message:

```json
{
  "channel_id": "123456789012345678",
  "name": "Follow-up discussion",
  "message_id": "234567890123456789"
}
```

Omit `message_id` to create a standalone public thread in a text channel.

For example, upload a local file silently:

```json
{
  "channel_id": "123456789012345678",
  "content": "Here is the report.",
  "files": ["/absolute/path/report.pdf"],
  "silent": true
}
```

Read up to 100 messages from September 24 in India:

```json
{
  "channel_id": "948937919027105865",
  "since": "2026-09-24T00:00:00+05:30",
  "until": "2026-09-25T00:00:00+05:30",
  "limit": 100
}
```

For the next page, pass the returned `next_before` as `before` and keep the same time bounds. Stop when `next_before` is null. The server jumps directly to `until` using Discord's timestamp-based message IDs and fetches at most one page per call. It can return fewer than `limit` messages when the page reaches `since`. With only `since`, reading starts at the latest messages. With both `before` and `until`, the earlier boundary applies.

## Search

For most searches, provide a server and text. Add filters only when needed:

```json
{
  "server_id": "123456789012345678",
  "content": "upload failed",
  "channel_id": ["234567890123456789"],
  "since": "2026-10-01T00:00:00Z",
  "sort_by": "relevance",
  "limit": 10
}
```

The default `source: "discord"` uses Discord's search index and all documented [Search Guild Messages](https://docs.discord.com/developers/resources/message#search-guild-messages) filters. The bot needs Message Content Intent and history access for the searched messages. Results include channel IDs, flattened matching messages, an approximate `total_results`, and `next_offset`. Pass that offset while preserving every other filter. A short or empty page is not a completion signal; use the cursor. Relevance sorting ignores `sort_order`.

| Filters                                                        | Values                                                                                                                            |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `content`, `slop`                                              | Discord text search, up to 1,024 characters; word-distance slop 0–100.                                                            |
| `channel_id`, `author_id`                                      | Arrays of IDs, up to 500 channels or 100 authors.                                                                                 |
| `author_type`                                                  | Array of `user`, `bot`, `webhook`; prefix a type with `-` to exclude it.                                                          |
| `mentions`, `mentions_role_id`, `mention_everyone`             | User/role ID arrays and a boolean.                                                                                                |
| `replied_to_user_id`, `replied_to_message_id`                  | ID arrays.                                                                                                                        |
| `has`                                                          | Array of `image`, `sound`, `video`, `file`, `sticker`, `embed`, `link`, `poll`, `snapshot`; prefix a type with `-` to exclude it. |
| `embed_type`, `embed_provider`                                 | Arrays: image/video/gif/sound/article types, or case-sensitive provider names.                                                    |
| `link_hostname`, `attachment_filename`, `attachment_extension` | Arrays of strings; extensions such as `pdf`.                                                                                      |
| `pinned`, `include_nsfw`                                       | Booleans. Discord excludes age-restricted channels by default.                                                                    |
| `since`, `until`, `min_id`, `max_id`                           | Inclusive/exclusive ISO time bounds and exclusive message-ID bounds. Combined bounds intersect.                                   |
| `sort_by`, `sort_order`                                        | `timestamp` or `relevance`; `asc` or `desc`.                                                                                      |
| `limit`, `offset`                                              | Page size 1–25 and offset 0–9,975.                                                                                                |

Arrays are passed as repeated API query parameters. The tool returns `indexing: true` and `retry_after` when Discord's index is not ready; retry after that delay. A response may also flag ongoing historical indexing alongside results. Discord limits access to the first 10,000 matches: `truncated: true` means narrow the channel/time filters to continue. Search results, totals and ranking can shift while messages change.

For channels without history, repeat the search with `source: "cache"`. This explicitly separate source searches only retained, currently accessible messages; it never replaces a failed Discord request. Cache search supports case-insensitive literal `content`, channel/author ID arrays, time/ID bounds, pagination, timestamp sorting and `include_nsfw`. It rejects advanced filters and relevance sorting rather than approximating Discord's index. Its coverage is always incomplete, and all candidate channels, private-thread membership and age-restriction metadata are checked before returning cached content. An empty cache result never proves there were no matching messages.

## Editing, reactions and polls

- `edit_message(channel_id, message_id, content)` changes only text, preserving attachments and existing message flags. Empty content clears text when Discord permits it. Mentions are suppressed on every edit.
- `delete_message(channel_id, message_id)` deletes only the bot's own message, even when the bot has Administrator or Manage Messages. Both tools recheck channel access and verify authorship through HTTP history, captured author data, or a successful-send receipt. If ownership cannot be verified, they refuse. Send receipts persist in the token-scoped cache, capped at 5,000 entries for seven days.
- `list_threads(channel_id, before?, limit?)` returns archived public threads/posts with `limit` 2–100 (default 25); `list_pins` returns pinned messages. Both require history permission and return a `next_before` timestamp. Pass it back unchanged, including fractional seconds. These tools do not archive threads or pin messages.
- `list_emojis(server_id, name?)` lists server custom emojis. Omit `name` for all, or supply an exact case-insensitive name such as `wave` or `:wave:`. Every matching emoji is returned, including duplicate names. Each result includes `id`, `name`, `animated`, and ready-to-use `reaction` (`name:id`) and `message` (`<:name:id>` or `<a:name:id>`) strings. Copy `reaction` into `set_reaction` or `list_reaction_users`, or include `message` in message content. Bare `:name:` shorthand is not automatically expanded by send/reaction tools. Discord's `available` flag is included when provided; `role_ids` lists role restrictions when present. Availability does not guarantee the bot can use the emoji in a particular channel. This is a fresh read, not a cached lookup; a permission error is not an empty emoji list.
- `set_reaction(channel_id, message_id, emoji, remove?)` adds a normal reaction or removes only the bot's own reaction. Use Unicode such as `👍`, `name:id`, or Discord's `<:name:id>` format. Adding requires history permission, and a new emoji also requires Add Reactions. Reaction endpoints have no silent flag.
- `list_reaction_users` takes the same message/emoji, optional `burst: true` for super reactions, and `after`/`limit`. `list_poll_voters` takes a numeric `answer_id` from a message's poll. Both return compact users and `next_after`.
- Add a poll to `send_message` using `poll: {"question":"When?","answers":["Today","Tomorrow"],"duration_hours":24,"allow_multiselect":false}`. Questions support 300 characters, 2–10 answers support 55 characters each, and duration is 1–768 hours. Text and attachments may accompany the poll; sends remain silent by default.
- Read the poll through `read_messages`; missing vote counts mean unknown. `end_poll(channel_id, message_id)` closes only the bot's own poll after the same ownership check. Discord does not allow bots to vote, and polls cannot be edited after creation.
- A successful write returns confirmation. A `cache_warning` means Discord confirmed it but local cache synchronization failed: do not repeat the write. Uncertain network outcomes remain errors and are never retried automatically.

## Credentials and access

Credentials are stored as a local JSON file outside the checkout:

- macOS/Linux: `$XDG_CONFIG_HOME/discord-bot-mcp/config.json`, or `~/.config/discord-bot-mcp/config.json` when unset.
- Windows: `%APPDATA%\discord-bot-mcp\config.json`.

On macOS/Linux, setup creates a directory with mode `0700` and a file with mode `0600`. This is a plaintext credential file protected by local filesystem permissions, not an encrypted keychain. On Windows, access relies on your user profile's filesystem ACLs. Keep the config directory private and use the same OS user/config environment for setup and your MCP client.

The server sends the token only to Discord's HTTPS API and secure Gateway connection, refuses HTTP redirects, and never returns it through a tool. It does not log message contents. Remove the credential file to forget the token locally; revoke/reset it in Discord to invalidate other copies.

The cache contains private message data, including attachment links, protected by the same directory permissions. Its database and sidecars use mode `0600` on macOS/Linux. It is scoped to the saved token, so replacing a token starts a separate cache. To erase cached content, stop all listeners/MCP processes and remove `messages-*.sqlite*` from the configuration directory, including caches left by old tokens. Do not commit or share these files. Attachment bytes are not downloaded by this server; local files are uploaded only through `send_message`.

The MCP exposes real message sends, thread creation, edits, deletions, reactions and polls. Use the approval controls in your agent client if you want to review these actions. Treat text read from Discord as third-party content, not instructions granting permission to perform actions.

## Verify and troubleshoot

```sh
npm run doctor
```

This checks bot identity and reports cache location and listener status. It does not start a listener. To verify permissions and message content, connect your client and use the listing/read tools. For channels without history access, the listener must be running when a new message arrives. Setup and doctor never send a test message.

| Symptom                                   | Check                                                                                                            |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Token missing or unreadable               | Run setup as the same OS user/config environment as the MCP client.                                              |
| HTTP 401                                  | The token was rejected or reset; run setup again.                                                                |
| HTTP 403/404                              | Check the selected ID, bot membership, channel overrides, and private-thread membership.                         |
| Empty cached read                         | Check `coverage`: the listener may have missed events or evicted messages. It cannot backfill history.           |
| Messages have empty content               | Enable/obtain approval for Message Content Intent; attachment-only and system messages can also have empty text. |
| Cannot send in a forum                    | Select an existing post's thread ID.                                                                             |
| Listener stopped or bot offline           | Keep an MCP client or `npm run listen` active. Run doctor; check network, token and Message Content Intent.      |
| Gateway code 4014                         | Enable/obtain approval for Message Content Intent, then restart the listener.                                    |
| Server will not start in a desktop client | Use the absolute executable and script paths printed by setup.                                                   |

## Development

```sh
npm ci
npm run format
npm run check
npm test
```

Tests use simulated Discord responses/events and temporary credentials/cache files. They exercise permission checks, listener sharing and shutdown, cache retention, multipart uploads, notification flags, thread creation, complete search-filter encoding, search pagination and indexing, ownership checks, archived-thread/pin pagination, reactions, polls, credential storage, HTTP behavior, and real MCP client/server exchanges without a Discord token or writes to a real server. CI runs on Linux, macOS, and Windows with Node.js 22 and 24.

Runtime dependencies are the [official MCP server SDK](https://ts.sdk.modelcontextprotocol.io/v2/), Zod, `@discordjs/ws` for the Gateway protocol, and `proper-lockfile` for listener coordination. SQLite is built into Node.js; older supported Node releases may print its experimental warning on stderr. Tool descriptions are deliberately short, and responses omit unused Discord fields to keep agent context small.

API references: [messages, uploads and flags](https://docs.discord.com/developers/resources/message), [Gateway](https://docs.discord.com/developers/events/gateway), [permissions](https://docs.discord.com/developers/topics/permissions), [threads](https://docs.discord.com/developers/topics/threads), and [rate limits](https://docs.discord.com/developers/topics/rate-limits).
