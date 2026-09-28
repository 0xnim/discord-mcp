---
name: discord-mcp
description: Configure and use the Discord REST MCP server with bot or best-effort user-token authentication.
license: Apache-2.0
metadata:
  author: FmBlueSystem
  version: "3.1"
---

# Discord MCP setup and use

Use the existing repository and its [README](README.md), rather than generating a second copy of the server. The entry point is `assets/index.mjs`, with `assets/discord-client.mjs` beside it.

## Setup

1. Install Node 24 LTS (or a supported Node version listed in the README).
2. Clone the repository and run `npm ci`, then `npm run check`.
3. Configure the MCP client to run `node /absolute/path/to/discord-mcp/assets/index.mjs` with exactly one of `DISCORD_BOT_TOKEN` or `DISCORD_USER_TOKEN` in its environment.
4. Configure optional default guild and blocked guild/author IDs as described in the README.
5. Restart the MCP client and verify tool discovery. There are 23 tools with the existing v3 names.

## Credentials and account restrictions

Bot accounts are Discord's supported automation route. Automating a normal account with a user token violates Discord's terms and can terminate the account; see [Discord's policy](https://support.discord.com/hc/en-us/articles/115002192352-Automated-User-Accounts-Self-Bots). User mode is retained as best-effort compatibility, with raw-token authorization. Do not claim that user-token access is supported by Discord or guaranteed to work. Keep credentials out of source, chat, and logs. No browser-login/token-capture flow is included.

For bots, configure only required channel permissions and Message Content access where applicable. Presence and Server Members intents are unnecessary for this REST-only implementation. No gateway connection is used.

## Tool use

- Preserve the tool names and parameters returned by MCP `tools/list`; the README lists the implemented tools.
- Use numeric IDs when names are ambiguous. A channel name needs a guild or default guild. Threads use IDs.
- Page history using message-ID cursors; pins use the `nextBefore` timestamp. Search scans at most 500 recent messages.
- Respect blocked guilds and filtered authors across all operations. These are local restrictions in addition to Discord permissions.
- Confirm the user's intended targets and content before sends or destructive changes as appropriate to their instructions. Do not treat a read request as permission to send a message.
- A timeout can mean a write succeeded without a response. Inspect before retrying. Rate-limit errors should be allowed to cool down.
- Webhook creation/listing can return credential material; keep results private.

## Maintenance

Keep REST API v10 and native ESM. Use the current MCP `registerTool` and `serveStdio` APIs. Declare directly imported packages, update the lockfile, and run build/lint/test checks. The test suite covers mocked HTTP behavior and both legacy and 2026-07-28 MCP connections. Live-account behavior must be reported separately from mocked test results.
