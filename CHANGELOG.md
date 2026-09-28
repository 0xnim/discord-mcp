# Changelog

## 3.1.0 — September 2026 maintenance

Based on upstream `2492984` (2026-04-15). This is a focused maintenance update to the existing REST implementation and all 23 original tool names.

### Runtime and MCP

- Fix `npm start` and package entry point to use the checked-in `assets/index.mjs`.
- Replace MCP SDK 1.29.0 with stable split server/client SDK 2.1.0. Move to `registerTool`, explicit Zod object schemas, and `serveStdio` so both legacy clients and protocol 2026-07-28 work.
- Declare Zod 4.6.5 directly; refresh the lockfile and reconcile package version/license metadata to 3.1.0/Apache-2.0.
- Declare a maintained Node baseline (22.13+, 24+), recommend Node 24 LTS, and add `.nvmrc`.
- Extract a small injectable REST client and export a server factory for tests, retaining the existing handler structure. Copy-based deployments must now keep both asset files together.
- Add build syntax checks, ESLint, Node test-runner coverage, and GitHub Actions on Node 22/24/26.

### Authentication, restrictions and errors

- Prefix bot credentials correctly; preserve raw user-token authorization. Trim credentials and reject missing or conflicting auth configuration. Add a user-mode warning on stderr.
- Restrict outbound requests to the Discord API; disable redirects, use an identifiable user agent, and avoid forwarding account credentials on webhook-token routes.
- Enforce guild blocks on every guild/channel/thread/webhook path, including reads and direct-ID operations. Filter guild lists. Verification reads fail closed if the target guild cannot be determined (DMs remain allowed).
- Accept both documented and original blocked-ID variable names, merge aliases, trim whitespace, and validate IDs.
- Apply author filters to single messages, forum messages, and pins as well as history/search; filtered single messages return `null`.
- Add 15-second request timeouts, sanitized HTTP/network/JSON errors, correct misleading Discord error-code explanations, and avoid replaying potentially completed writes after transport failures.

### Rate limiting

- Serialize requests within a process; learn major-resource-scoped route buckets and honor exhausted-bucket resets and shared global cooldowns.
- Handle fractional JSON `retry_after` and response headers, malformed-delay fallback, and exactly three total attempts without sleeping after the final failure.
- Refuse waits exceeding 30 seconds while preserving the cooldown. Separate processes do not coordinate; this is intended for one local MCP process per account.

### Tool fixes

- Validate numeric IDs, content/title/name lengths, integer limits, channel types, emoji batches, URLs and tags; reject unknown arguments and conflicting history cursors. Add read/write/destructive/idempotency annotations.
- Fix snowflake-to-date conversion; request approximate guild member counts explicitly.
- Paginate guild listings, support `#channel` names, reject duplicate names, and remove indefinitely stale lookup caches.
- Return chronological history/thread reads, use attachment `filename`, and forward deletion audit reasons.
- Replace the deprecated pins route with the paginated `/messages/pins` endpoint, exposing `hasMore`, `nextBefore`, and per-message `pinnedAt`. `pinnedCount` now describes the visible page.
- Normalize pasted custom emoji syntax; mark partially failed reaction batches as tool errors.
- Remove unsupported forum creation payload fields; reject unknown tags rather than dropping them.
- Execute webhooks with `wait=true` so Discord confirms the request before reporting success.

### Documentation and validation limits

- Replace broken copy/install instructions; document both MCP configuration styles and accurate token, permission, environment-variable and tool names/counts.
- Remove the browser token-capture example and recommendation to use selfbots. Clearly explain that user-token automation violates Discord terms and can terminate the account, while retaining the mode technically.
- Explain Message Content restrictions, sensitive webhook outputs, local-search and forum-webhook limitations, pin pagination, stricter validation, and unknown delivery outcomes.
- Refresh the bundled skill so it no longer reproduces obsolete auth, setup, or dependency code.
- All automated Discord behavior uses mocks. Real user-token acceptance, live permissions and network behavior require separate account testing; no account was used here.
