# discord_bot_mcp

A small local [MCP](https://modelcontextprotocol.io/) server for reading and sending Discord messages through a bot. Four tools, one-time token setup, no database, no background service, and no build step.

| Tool            | Purpose                                                           |
| --------------- | ----------------------------------------------------------------- |
| `list_servers`  | Find servers the bot has joined.                                  |
| `list_channels` | Find channels and visible active threads in a server.             |
| `read_messages` | Read recent messages, page through history, or fetch one message. |
| `send_message`  | Send text or reply as the bot.                                    |

The MCP client starts the server when needed. It communicates over standard input/output and makes requests to Discord's HTTP API. It does not connect to the Discord Gateway, so the bot can appear offline while these tools work.

## Install

Requires **Node.js 22.14 or later** and Git. Each colleague installs and configures their own local copy.

```sh
git clone https://github.com/laurens-pilot/discord_bot_mcp.git
cd discord_bot_mcp
npm ci
npm run setup
```

Paste the bot token into the hidden terminal prompt. Setup verifies that Discord accepts it as a bot token before saving it, then prints an MCP configuration containing the absolute paths for your machine. The token is never included in that configuration. Running setup again replaces the saved token after validation.

## Create and invite a Discord bot

1. Open the [Discord Developer Portal](https://discord.com/developers/applications) and create an application, or use an existing bot you manage.
2. On its **Bot** page, enable **Message Content Intent** under Privileged Gateway Intents. This is needed for ordinary message text and attachments even though this server only uses HTTP. Larger verified bots may need Discord's approval for this intent.
3. Copy or reset the bot token on the Bot page, then enter it in `npm run setup`. Resetting a token invalidates existing copies, including those used by colleagues.
4. Use the application's installation settings or OAuth2 URL Generator to create a server installation link with the `bot` scope. Grant **View Channels**, **Read Message History**, and **Send Messages**. Add **Send Messages in Threads** if needed. Administrator permission is unnecessary.
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

Paste it into your client's MCP settings. If the client uses a different configuration format, use the same command and argument in its local/stdio server settings. Absolute paths avoid desktop applications having a different `PATH` or working directory. No token or environment variable is required in the client's configuration. Restart the client after adding the server or replacing the token.

Try asking the agent:

> List the Discord servers, find #general in my team server, and read its latest 10 messages.

To send, give the agent the intended server/channel and message. Messages are posted as the bot. Replies use the optional `reply_to` message ID. User, role, everyone, and reply mentions never ping.

## Tool behavior

- IDs are strings. Discover them with the listing tools or copy them from Discord with Developer Mode enabled. For a message link, use the last two path segments as `channel_id` and `message_id`.
- `list_servers` returns up to 100 servers and `next_after`. Pass that value as `after` for the next page.
- `list_channels` returns channel metadata and visible active threads, including forum posts. Channel metadata is not a permission check: Discord can list a channel while denying access to its messages. Archived threads are not listed, but a known thread ID works if the bot can access it.
- `read_messages` defaults to 20 messages and accepts `limit` from 1 to 100. Results are newest first. Pass `next_before` as `before` for older messages, or use `message_id` to fetch one. `limit` is ignored with `message_id`. A non-null cursor means another page may exist, not that more results are guaranteed.
- Reads preserve message text, author, timestamp, references, attachment links, and selected embed fields. They do not return Discord's full message object. Attachment links expire; read the message again for a fresh link.
- Forum and media channels contain posts: use a post's thread ID to read or send messages. Creating posts, searching server history, uploading files, editing, deleting, reactions, and opening DMs are outside this server's scope.
- `send_message` accepts 1–2,000 characters of nonblank text and optionally `reply_to`. Successful sends return the message ID and channel ID.
- Requests time out after 15 seconds. Rate-limit responses report when to try again; the process also observes Discord's reported cooldown before allowing more requests. Requests are never automatically retried. If delivery is uncertain, inspect channel history before sending again.

## Credentials and access

Credentials are stored as a local JSON file outside the checkout:

- macOS/Linux: `$XDG_CONFIG_HOME/discord-bot-mcp/config.json`, or `~/.config/discord-bot-mcp/config.json` when unset.
- Windows: `%APPDATA%\discord-bot-mcp\config.json`.

On macOS/Linux, setup creates a directory with mode `0700` and a file with mode `0600`. This is a plaintext credential file protected by local filesystem permissions, not an encrypted keychain. On Windows, access relies on your user profile's filesystem ACLs. Keep the config directory private and use the same OS user/config environment for setup and your MCP client.

The server sends the token only to `https://discord.com/api/v10`, refuses redirects, and never returns it through a tool. It does not log message contents. Remove the credential file to forget the token locally; revoke/reset it in Discord to invalidate other copies.

The MCP exposes a real send capability. Use the approval controls in your agent client if you want to review outgoing messages. Treat text read from Discord as third-party content, not instructions granting permission to perform actions.

## Verify and troubleshoot

```sh
npm run doctor
```

This performs a read-only bot identity check. To verify permissions and message content, connect your client and use the listing/read tools against a channel containing a known ordinary message. Setup and doctor never send a test message.

| Symptom                                   | Check                                                                                                            |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Token missing or unreadable               | Run setup as the same OS user/config environment as the MCP client.                                              |
| HTTP 401                                  | The token was rejected or reset; run setup again.                                                                |
| HTTP 403/404                              | Check the selected ID, bot membership, channel overrides, and private-thread membership.                         |
| Empty history                             | The channel may be empty, or the bot may lack Read Message History.                                              |
| Messages have empty content               | Enable/obtain approval for Message Content Intent; attachment-only and system messages can also have empty text. |
| Cannot send in a forum                    | Select an existing post's thread ID.                                                                             |
| Bot appears offline                       | Expected: this server uses HTTP and does not maintain a Gateway presence.                                        |
| Server will not start in a desktop client | Use the absolute executable and script paths printed by setup.                                                   |

## Development

```sh
npm ci
npm run format
npm run check
npm test
```

Tests use simulated Discord responses and temporary credentials. They exercise credential storage, hidden setup, HTTP behavior, tool validation, and real MCP client/server exchanges without a Discord token or messages sent to a real server. CI runs on Linux, macOS, and Windows with Node.js 22 and 24.

The runtime dependencies are the [official MCP server SDK](https://ts.sdk.modelcontextprotocol.io/v2/) and Zod. There is no Discord framework or Gateway connection. Tool descriptions are deliberately short, and responses omit unused Discord fields to keep agent context small.

API references: [messages and content access](https://docs.discord.com/developers/resources/message), [permissions](https://docs.discord.com/developers/topics/permissions), [threads](https://docs.discord.com/developers/topics/threads), and [rate limits](https://docs.discord.com/developers/topics/rate-limits).
