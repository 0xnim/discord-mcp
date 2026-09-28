# discord-mcp

A small Discord MCP server with **23 tools**, Discord REST API v10, and stdio transport. No Discord gateway connection or discord.js dependency. Existing v3 tool names are preserved.

> **Account risk:** Automating a normal Discord account using a user token (a selfbot) violates Discord's terms and can result in account termination. [Discord's official policy](https://support.discord.com/hc/en-us/articles/115002192352-Automated-User-Accounts-Self-Bots). `DISCORD_USER_TOKEN` remains available on a best-effort basis; Discord does not provide a supported user-token automation API. A bot account is the supported automation route.

## Install and run

Use **Node.js 24 LTS** (recommended), Node.js 22.13+, or Node.js 26. Node 18 and 20 are end-of-life; use a maintained Node release. See the [Node release schedule](https://nodejs.org/en/about/previous-releases).

```sh
git clone https://github.com/FmBlueSystem/discord-mcp.git
cd discord-mcp
npm ci
npm run check
```

Configure exactly one credential in your MCP client's secret/environment settings:

- `DISCORD_BOT_TOKEN`: raw bot token; the server supplies the `Bot ` authorization prefix. A token already prefixed with `Bot ` is accepted too.
- `DISCORD_USER_TOKEN`: an existing raw token for your own account; sent without a prefix. This mode logs an account-risk warning to stderr. There is no automated login, token extraction, CAPTCHA handling, or account recovery in this project. Access is limited to what Discord permits for that account; it may stop working without notice.

Setting both credentials, neither credential, or malformed configured IDs stops startup. Keep tokens out of commits, shared configuration, screenshots, and chat. A `.env` file is **not loaded automatically**. If you use one locally, Node supports `node --env-file=.env assets/index.mjs`; supply only one token.

The entry point is **`assets/index.mjs`**. Run `npm start` once the environment is configured, or launch that file directly from an MCP client. Install the full repository; `assets/discord-client.mjs` must stay beside it. You no longer need to copy a template into the project root.

### Bot setup

1. Create an application and bot in the [Discord Developer Portal](https://discord.com/developers/applications), then securely store its token.
2. Have someone with permission to install the bot invite it to the intended server. The bot itself does not need Administrator permission.
3. Grant only permissions needed for your tools: View Channel and Read Message History for reads; Send Messages and Send Messages in Threads for writes; Add Reactions for new reactions; Manage Channels for channel creation/deletion; Manage Webhooks for webhook management; Manage Messages to delete other users' messages.
4. To read ordinary message content, configure the Message Content privileged intent where required; larger/verified applications may require approval. It affects REST message fields too. Presence and Server Members intents are not needed for this REST-only server. See [Discord message content restrictions](https://docs.discord.com/developers/resources/message#message-object).

### MCP configuration

For clients using `mcpServers` configuration:

```json
{
  "mcpServers": {
    "discord": {
      "command": "node",
      "args": ["/absolute/path/to/discord-mcp/assets/index.mjs"],
      "env": {
        "DISCORD_BOT_TOKEN": "REPLACE_WITH_BOT_TOKEN"
      }
    }
  }
}
```

For OpenCode:

```json
{
  "mcp": {
    "discord": {
      "type": "local",
      "command": ["node", "/absolute/path/to/discord-mcp/assets/index.mjs"],
      "environment": {
        "DISCORD_BOT_TOKEN": "REPLACE_WITH_BOT_TOKEN"
      }
    }
  }
}
```

Replace the path and placeholder locally, preferably using your client's secret handling. For user mode, replace the **environment key** with `DISCORD_USER_TOKEN`; do not configure both. If a desktop client cannot find Node, use the absolute path to its executable. Restart the MCP client after changes. The server writes protocol data to stdout and diagnostics to stderr.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `DISCORD_BOT_TOKEN` | Supported bot credential; mutually exclusive with user token |
| `DISCORD_USER_TOKEN` | Best-effort user-account credential; violates Discord terms |
| `DISCORD_DEFAULT_GUILD_ID` | Numeric default guild for tools whose `guildId` is optional |
| `DISCORD_BANNED_GUILD_IDS` | Comma-separated guild IDs; block reads **and** writes |
| `DISCORD_BANNED_USER_IDS` | Comma-separated author IDs to omit from message results |
| `DISCORD_BANNED_GUILDS` | Backward-compatible alias; merged with `DISCORD_BANNED_GUILD_IDS` |
| `DISCORD_BANNED_USERS` | Backward-compatible alias; merged with `DISCORD_BANNED_USER_IDS` |

Whitespace and empty entries in ID lists are ignored. Guild blocking covers direct IDs, threads, reactions, channel management, and token-authenticated webhook operations. Guild listing hides blocked guilds. With blocking enabled, the server performs a metadata lookup to verify a channel/webhook's guild and fails closed if it cannot verify it; DM/group-DM channels remain available. These settings are local filters, not a substitute for Discord permissions. Metadata needed to check the restriction is still fetched, but blocked content is not returned or modified.

Author filtering applies to channel history, local search, pins, individual messages, and forum reads. An individual filtered message returns JSON `null`; counts describe the visible results. This does not remove mentions of those users from other people's messages.

## Tools

| Category | Tools |
| --- | --- |
| Guilds (2) | `discord_list_guilds`, `discord_get_server_info` |
| Channels (4) | `discord_list_channels`, `discord_get_channel_info`, `discord_create_channel`, `discord_delete_channel` |
| Messages (6) | `discord_read_channel`, `discord_send_message`, `discord_delete_message`, `discord_search_messages`, `discord_get_pinned`, `discord_get_message` |
| Forums (4) | `discord_list_forums`, `discord_get_forum_post`, `discord_create_forum_post`, `discord_reply_to_forum` |
| Reactions (3) | `discord_add_reaction`, `discord_remove_reaction`, `discord_add_multiple_reactions` |
| Webhooks (4) | `discord_create_webhook`, `discord_list_webhooks`, `discord_send_webhook_message`, `discord_delete_webhook` |

The earlier README listed names that never existed in the implementation (`discord_modify_channel`, `discord_get_guild`, `discord_list_forum_posts`, `discord_reply_to_thread`, `discord_batch_add_reactions`). Use the names above; this update does not add unrelated tools or aliases.

- **IDs and names:** Pass Discord IDs as strings. Guild names are matched case-insensitively using paginated guild listings. Channel names such as `general` or `#general` need `guildId` or a configured default. Duplicate names are rejected: use numeric IDs. Lookups are refreshed rather than cached indefinitely. Thread tools require numeric IDs.
- **History:** `discord_read_channel` accepts `limit` from 1–100 (default 50) and either `before` or `after`, a message ID. Results are chronological. `discord_get_forum_post` returns up to 100 recent messages; use `discord_read_channel` with the thread ID to paginate.
- **Search:** `discord_search_messages` searches up to 500 recent messages locally, newest first, with a case-insensitive substring. It is not Discord's full-history search endpoint.
- **Pins:** `discord_get_pinned` uses `/channels/{id}/messages/pins`, with `limit` 1–50. When `hasMore` is true, pass the returned `nextBefore` timestamp as `before`. `pinnedCount` is the visible count in this page; cursors are based on unfiltered pins so filtering cannot stall pagination.
- **Messages:** Send/reply bodies must contain 1–2000 characters. Discord's normal mention behavior is preserved. No file-upload or rich-message authoring tools are provided.
- **Forums:** Titles are 1–100 characters; at most five tag names/IDs can be supplied. Unknown tags fail instead of being silently dropped. Discord still enforces required tags and permissions.
- **Reactions:** Unicode emoji, `name:id`, `<:name:id>`, and `<a:name:id>` work. Batches accept 1–20 entries and report each outcome; partial failure sets MCP `isError`.
- **Webhooks:** Execution uses webhook-token authentication without sending the account token, and `wait=true` to await Discord's response. Create/list results can contain webhook secrets; treat them as credentials. Forum/media webhook execution needs thread fields this tool does not expose; use forum tools for those channels.
- **Audit reasons:** Channel/message deletion forwards the optional `reason` to Discord's audit-log header.

## Rate limits and failures

Requests are serialized within one server process. The client learns route buckets scoped to major resources, observes reset headers, and shares global cooldowns across tools. A 429 uses the longest valid delay reported by `Retry-After`, JSON `retry_after`, or the bucket reset header, including fractional seconds. Missing/malformed delays fall back to one second. There are **three total attempts**, not three additional retries. See [Discord rate-limit documentation](https://docs.discord.com/developers/topics/rate-limits).

An individual HTTP request, including its body, has a 15-second timeout. A required rate-limit wait over 30 seconds returns an error promptly and preserves the cooldown for subsequent calls. Separate server processes do not share rate-limit state; avoid running several against the same account. A queued tool call can take longer than one request timeout.

Network failures, HTTP 5xx, 401/403, and malformed responses are not automatically replayed. A failed/timed-out write can have an unknown delivery outcome; check the channel before resending. Errors omit remote response bodies, request URLs, and credentials. Known Discord errors suggest checking IDs, membership, credentials, or permissions. No attempt is made to bypass Discord challenges or access restrictions.

## Development and compatibility

```sh
npm ci
npm run build
npm run lint
npm test
# or all three:
npm run check
npm audit
```

The source is native JavaScript ESM: `build` validates syntax; it does not transpile or generate a bundle. Tests use Node's built-in test runner, mocked Discord responses, and real MCP stdio child processes. They require no Discord token or network access. CI covers Node 22, 24, and 26.

Runtime dependencies are `@modelcontextprotocol/server` 2.1.x and explicit `zod` 4.6.x. The MCP client SDK is a test dependency. `serveStdio` supports both legacy MCP initialization and the 2026-07-28 protocol negotiation. The [official SDK](https://github.com/modelcontextprotocol/typescript-sdk) documents v2 as the stable line; this update preserves the REST handlers while adapting registration and transport. The lockfile records the tested versions.

See [CHANGELOG.md](CHANGELOG.md) for the September 2026 maintenance changes and compatibility differences. Automated tests do **not** prove live Discord user-token acceptance. No real Discord account was used for this maintenance pass.

## License

Apache-2.0, as declared by the upstream project. © FmBlueSystem.
