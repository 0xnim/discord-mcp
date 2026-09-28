#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

import { pathToFileURL } from "node:url";
import { readConfig, createDiscordClient } from "./discord-client.mjs";

export function createServer({ env = process.env, ...clientOptions } = {}) {
  const config = readConfig(env);
  const { bannedGuilds: BANNED_GUILDS, bannedUsers: BANNED_USERS, defaultGuild: DEFAULT_GUILD } = config;
  const request = createDiscordClient(config, clientOptions);

  // Apply guild restrictions to every route, including direct channel/thread IDs and webhooks.
  async function discordFetch(endpoint, options) {
    const [, resource, id, token] = endpoint.split('?')[0].split('/');
    if (BANNED_GUILDS.size) {
      let guildId;
      if (resource === 'guilds') guildId = id;
      if (resource === 'channels') {
        const channel = await request(`/channels/${id}`);
        guildId = channel.guild_id;
        if (!guildId && ![1, 3].includes(channel.type)) throw new Error('Cannot verify channel guild.');
        if (guildId && BANNED_GUILDS.has(guildId)) throw new Error('This guild is blocked.');
        if (endpoint === `/channels/${id}` && !options) return channel;
      }
      if (resource === 'webhooks') {
        const webhook = await request(`/webhooks/${id}${token ? `/${token}` : ''}`);
        guildId = webhook.guild_id;
        if (!guildId) throw new Error('Cannot verify webhook guild.');
      }
      if (guildId && BANNED_GUILDS.has(guildId)) throw new Error('This guild is blocked.');
    }
    return request(endpoint, options);
  }

  const TYPE_MAP = { 0:"TEXT",1:"DM",2:"VOICE",3:"GROUP_DM",4:"CATEGORY",5:"ANNOUNCEMENT",10:"THREAD",11:"PUBLIC_THREAD",12:"PRIVATE_THREAD",13:"STAGE",15:"FORUM",16:"MEDIA" };

  // ─── Error Handler ───────────────────────────────────────────────────────────
  function handleDiscordError(err) {
    const msg = typeof err === "string" ? err : err?.message || String(err);
    const code = err?.discordCode || err?.status || 0;
    const solutions = {
      40001: "Token invalid or expired. Check the configured credential.",
      10004: "Server not found. Solution: Check the server ID or that the bot/user is a member.",
      50001: "Missing access. Solution: Check channel permissions and bot/user membership.",
      50013: "Missing permissions. Solution: Grant the required permissions in server settings.",
      50034: "Messages older than two weeks cannot be bulk deleted.",
      50035: "Invalid request. Check the tool parameters and channel type.",
      10003: "Unknown channel. Check the ID and channel access.",
      10008: "Unknown message. Check the message ID.",
      10015: "Unknown webhook. Check its ID and token.",
      401: "Authentication failed. Check the configured credential.",
      403: "Discord denied access. Check permissions and account access.",
      429: "Rate limited by Discord. Solution: Wait a moment and retry.",
    };
    const solution = solutions[code] || `Discord API error (code ${code || "unknown"}): ${msg.substring(0, 200)}`;
    return { content: [{ type: "text", text: `Error: ${solution}` }], isError: true };
  }

  // Resolve fresh lists: duplicate names are errors, never arbitrary write targets.
  async function listGuilds() {
    const guilds = [];
    let after;
    while (true) {
      const params = new URLSearchParams({ limit: '200' });
      if (after) params.set('after', after);
      const page = await discordFetch(`/users/@me/guilds?${params}`);
      guilds.push(...page.filter(g => !BANNED_GUILDS.has(g.id)));
      if (page.length < 200) return guilds;
      const next = page.at(-1).id;
      if (next === after) throw new Error('Discord guild pagination did not advance.');
      after = next;
    }
  }

  function uniqueId(items, reference, kind) {
    const matches = items.filter(item => item.name.toLowerCase() === reference.toLowerCase());
    if (matches.length > 1) throw new Error(`Ambiguous ${kind} name; use its numeric ID.`);
    return matches[0]?.id || null;
  }

  async function resolveGuildId(guildRef) {
    if (!guildRef) return DEFAULT_GUILD || null;
    if (/^\d+$/.test(guildRef)) return guildRef;
    return uniqueId(await listGuilds(), guildRef, 'guild');
  }

  async function resolveChannelId(guildId, channelRef) {
    if (!channelRef) return null;
    if (/^\d+$/.test(channelRef)) return channelRef;
    if (!guildId) return null;
    const channels = await discordFetch(`/guilds/${guildId}/channels`);
    return uniqueId(channels, channelRef.replace(/^#/, ''), 'channel');
  }

  // ─── Format message ──────────────────────────────────────────────────────────
  function formatMessage(msg) {
    const author = msg.author?.global_name || msg.author?.username || "Unknown";
    const reactions = msg.reactions?.map(r => `${r.emoji?.name || "??"}(${r.count})`).join(", ") || "";
    const attachments = msg.attachments?.map(a => `[file: ${a.filename} (${a.url})]`).join(", ") || "";
    const embeds = msg.embeds?.length ? msg.embeds.map(e => `[embed: ${e.title || e.description?.substring(0, 60) || "rich"}]`).join(", ") : "";
    return {
      id: msg.id, author, authorId: msg.author?.id, timestamp: msg.timestamp,
      content: msg.content || "", reactions: reactions || undefined,
      attachments: attachments || undefined, embeds: embeds || undefined,
      pinned: msg.pinned, replyTo: msg.message_reference?.message_id || undefined,
    };
  }

  function isBanned(msg) {
    if (!msg || !msg.author) return false;
    if (BANNED_USERS.has(msg.author.id)) return true;
    return false;
  }

  // ─── MCP Server ──────────────────────────────────────────────────────────────
  const server = new McpServer({ name: "discord-mcp", version: "3.1.0" });
  const id = z.string().regex(/^\d{1,20}$/, 'Use a numeric Discord ID');
  const ref = z.string().trim().min(1).max(100);
  const contentSchema = z.string().min(1).max(2000);
  const emojiSchema = z.string().min(1).max(100);
  const tokenSchema = z.string().regex(/^[A-Za-z0-9._-]+$/);
  function tool(name, description, shape, handler) {
    const readOnly = /^discord_(list|get|read|search)_/.test(name);
    const destructive = name.startsWith('discord_delete_');
    const schema = z.object(shape).strict().superRefine((args, ctx) => {
      if (name === 'discord_create_channel' && args.type !== 15 && args.topic?.length > 1024) {
        ctx.addIssue({ code: 'custom', message: 'Topics for non-forum channels must be at most 1024 characters.' });
      }
      if (name === 'discord_read_channel' && args.before && args.after) {
        ctx.addIssue({ code: 'custom', message: 'Use either before or after, not both.' });
      }
    });
    server.registerTool(name, {
      description, inputSchema: schema,
      annotations: { readOnlyHint: readOnly, destructiveHint: destructive, idempotentHint: readOnly || destructive || /reaction/.test(name), openWorldHint: true },
    }, handler);
  }
  function encodeEmoji(emoji) {
    return encodeURIComponent(emoji.replace(/^<a?:([^:]+):(\d+)>$/, '$1:$2'));
  }

  // ─── TOOLS: Guilds & Server Info ─────────────────────────────────────────────

  tool("discord_list_guilds", "List all Discord servers the user/bot has access to.", {}, async () => {
    try {
      const guilds = await listGuilds();
      const result = guilds.map(g => ({
        id: g.id, name: g.name, owner: g.owner, permissions: g.permissions,
        icon: g.icon ? `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png` : null,
      }));
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (e) { return handleDiscordError(e); }
  });

  tool("discord_get_server_info", "Get detailed server information including roles, member count, and icon.", {
    guildId: ref.describe("Guild ID or name"),
  }, async ({ guildId }) => {
    try {
      const gId = await resolveGuildId(guildId);
      if (!gId) return { content: [{ type: "text", text: `Error: Could not resolve guild '${guildId}'` }], isError: true };
      const guild = await discordFetch(`/guilds/${gId}?with_counts=true`);
      return { content: [{ type: "text", text: JSON.stringify({
        id: guild.id, name: guild.name, description: guild.description || null,
        memberCount: guild.approximate_member_count, icon: guild.icon ? `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png` : null,
        ownerId: guild.owner_id, createdAt: new Date(Number(BigInt(guild.id) / 4194304n + 1420070400000n)).toISOString(),
        features: guild.features?.slice(0, 10), roles: guild.roles?.map(r => ({ id: r.id, name: r.name, color: r.color })),
      }, null, 2) }] };
    } catch (e) { return handleDiscordError(e); }
  });

  // ─── TOOLS: Channels ────────────────────────────────────────────────────────

  tool("discord_list_channels", "List all channels in a Discord server, grouped by category.", {
    guildId: ref.describe("Guild/server ID or name"),
  }, async ({ guildId }) => {
    try {
      const gId = await resolveGuildId(guildId);
      if (!gId) return { content: [{ type: "text", text: `Error: Could not resolve guild '${guildId}'` }], isError: true };
      const channels = await discordFetch(`/guilds/${gId}/channels`);
      const categories = {};
      for (const c of channels) { if (c.type === 4) categories[c.id] = c.name; }
      const result = channels.sort((a, b) => (a.parent_id || "").localeCompare(b.parent_id || "") || a.position - b.position)
        .map(c => ({ id: c.id, name: c.name, type: TYPE_MAP[c.type] || `UNKNOWN(${c.type})`, category: categories[c.parent_id] || null, topic: c.topic || null, nsfw: c.nsfw || false }));
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (e) { return handleDiscordError(e); }
  });

  tool("discord_get_channel_info", "Get detailed info about a specific Discord channel.", {
    channelId: ref.describe("Channel ID or name (requires guildId for name resolution)"),
    guildId: ref.optional().describe("Guild ID or name (required if channelId is a name)"),
  }, async ({ channelId, guildId }) => {
    try {
      const gId = guildId ? await resolveGuildId(guildId) : DEFAULT_GUILD;
      const cId = await resolveChannelId(gId, channelId);
      if (!cId) return { content: [{ type: "text", text: `Error: Could not resolve channel '${channelId}'` }], isError: true };
      const ch = await discordFetch(`/channels/${cId}`);
      return { content: [{ type: "text", text: JSON.stringify({
        id: ch.id, name: ch.name, type: TYPE_MAP[ch.type] || ch.type, topic: ch.topic || null,
        nsfw: ch.nsfw || false, position: ch.position, parentId: ch.parent_id, guildId: ch.guild_id,
        rateLimit: ch.rate_limit_per_user || 0,
      }, null, 2) }] };
    } catch (e) { return handleDiscordError(e); }
  });

  tool("discord_create_channel", "Create a text, voice, announcement or forum channel in a Discord server.", {
    guildId: ref.describe("Guild ID or name"),
    name: z.string().min(1).max(100).describe("Channel name (lowercase, no spaces, use hyphens)"),
    type: z.union([z.literal(0), z.literal(2), z.literal(5), z.literal(15)]).default(0).describe("Channel type: 0=text, 2=voice, 5=announcement, 15=forum"),
    topic: z.string().max(4096).optional().describe("Channel topic/description"),
    parentId: id.optional().describe("Parent category ID"),
  }, async ({ guildId, name, type = 0, topic, parentId }) => {
    try {
      const gId = await resolveGuildId(guildId);
      if (!gId) return { content: [{ type: "text", text: `Error: Could not resolve guild '${guildId}'` }], isError: true };
      const body = { name, type };
      if (topic) body.topic = topic;
      if (parentId) body.parent_id = parentId;
      const ch = await discordFetch(`/guilds/${gId}/channels`, { method: "POST", body: JSON.stringify(body) });
      return { content: [{ type: "text", text: JSON.stringify({ id: ch.id, name: ch.name, type: TYPE_MAP[ch.type] }, null, 2) }] };
    } catch (e) { return handleDiscordError(e); }
  });

  tool("discord_delete_channel", "Delete a Discord channel.", {
    channelId: ref.describe("Channel ID or name"),
    guildId: ref.optional().describe("Guild ID or name (required if channelId is a name)"),
    reason: z.string().max(512).optional().describe("Reason for deletion (audit log)"),
  }, async ({ channelId, guildId, reason }) => {
    try {
      const gId = guildId ? await resolveGuildId(guildId) : DEFAULT_GUILD;
      const cId = await resolveChannelId(gId, channelId);
      if (!cId) return { content: [{ type: "text", text: `Error: Could not resolve channel '${channelId}'` }], isError: true };
      await discordFetch(`/channels/${cId}`, { method: "DELETE", reason });
      return { content: [{ type: "text", text: `Channel ${cId} deleted successfully.` }] };
    } catch (e) { return handleDiscordError(e); }
  });

  // ─── TOOLS: Messages ────────────────────────────────────────────────────────

  tool("discord_read_channel", "Read messages from a Discord channel. Returns messages in chronological order.", {
    channelId: ref.describe("Channel ID or name (requires guildId for name)"),
    guildId: ref.optional().describe("Guild ID or name (required if channelId is a name)"),
    limit: z.number().int().min(1).max(100).default(50).describe("Number of messages (1-100, default 50)"),
    before: id.optional().describe("Get messages before this message ID (pagination)"),
    after: id.optional().describe("Get messages after this message ID (pagination)"),
  }, async ({ channelId, guildId, limit = 50, before, after }) => {
    try {
      const gId = guildId ? await resolveGuildId(guildId) : DEFAULT_GUILD;
      const cId = await resolveChannelId(gId, channelId);
      if (!cId) return { content: [{ type: "text", text: `Error: Could not resolve channel '${channelId}'` }], isError: true };
      const params = new URLSearchParams({ limit: String(Math.min(limit, 100)) });
      if (before) params.set("before", before);
      if (after) params.set("after", after);
      const messages = await discordFetch(`/channels/${cId}/messages?${params}`);
      let channelInfo;
      try { channelInfo = await discordFetch(`/channels/${cId}`); } catch { channelInfo = { id: cId, name: "unknown" }; }
      const formatted = messages.filter(m => !isBanned(m)).reverse().map(formatMessage);
      return { content: [{ type: "text", text: JSON.stringify({ channel: { id: channelInfo.id, name: channelInfo.name, type: TYPE_MAP[channelInfo.type] || channelInfo.type }, messageCount: formatted.length, messages: formatted }, null, 2) }] };
    } catch (e) { return handleDiscordError(e); }
  });

  tool("discord_send_message", "Send a message to a Discord channel.", {
    channelId: ref.describe("Channel ID or name (requires guildId for name)"),
    guildId: ref.optional().describe("Guild ID or name (required if channelId is a name)"),
    message: contentSchema.describe("Message content to send (1-2000 characters)"),
  }, async ({ channelId, guildId, message }) => {
    try {
      const gId = guildId ? await resolveGuildId(guildId) : DEFAULT_GUILD;
      const cId = await resolveChannelId(gId, channelId);
      if (!cId) return { content: [{ type: "text", text: `Error: Could not resolve channel '${channelId}'` }], isError: true };
      const msg = await discordFetch(`/channels/${cId}/messages`, { method: "POST", body: JSON.stringify({ content: message }) });
      return { content: [{ type: "text", text: JSON.stringify({ sent: true, messageId: msg.id, channelId: cId, timestamp: msg.timestamp }, null, 2) }] };
    } catch (e) { return handleDiscordError(e); }
  });

  tool("discord_delete_message", "Delete a specific message from a Discord channel.", {
    channelId: ref.describe("Channel ID or name"),
    guildId: ref.optional().describe("Guild ID or name (required if channelId is a name)"),
    messageId: id.describe("The message ID to delete"),
    reason: z.string().max(512).optional().describe("Reason for deletion (audit log)"),
  }, async ({ channelId, guildId, messageId, reason }) => {
    try {
      const gId = guildId ? await resolveGuildId(guildId) : DEFAULT_GUILD;
      const cId = await resolveChannelId(gId, channelId);
      if (!cId) return { content: [{ type: "text", text: `Error: Could not resolve channel '${channelId}'` }], isError: true };
      await discordFetch(`/channels/${cId}/messages/${messageId}`, { method: "DELETE", reason });
      return { content: [{ type: "text", text: `Message ${messageId} deleted from channel ${cId}.` }] };
    } catch (e) { return handleDiscordError(e); }
  });

  tool("discord_search_messages", "Search for messages containing specific text in a Discord channel.", {
    channelId: ref.describe("Channel ID or name"),
    guildId: ref.optional().describe("Guild ID or name (required if channelId is a name)"),
    query: z.string().min(1).max(2000).describe("Text to search for (case-insensitive)"),
    limit: z.number().int().min(1).max(500).default(200).describe("How many recent messages to search (max 500)"),
  }, async ({ channelId, guildId, query, limit = 200 }) => {
    try {
      const gId = guildId ? await resolveGuildId(guildId) : DEFAULT_GUILD;
      const cId = await resolveChannelId(gId, channelId);
      if (!cId) return { content: [{ type: "text", text: `Error: Could not resolve channel '${channelId}'` }], isError: true };
      const queryLower = query.toLowerCase();
      const matches = [];
      let lastId, remaining = Math.min(limit, 500);
      while (remaining > 0) {
        const batch = Math.min(remaining, 100);
        const params = new URLSearchParams({ limit: String(batch) });
        if (lastId) params.set("before", lastId);
        const msgs = await discordFetch(`/channels/${cId}/messages?${params}`);
        if (msgs.length === 0) break;
        for (const m of msgs) { if (m.content && m.content.toLowerCase().includes(queryLower) && !isBanned(m)) matches.push(formatMessage(m)); }
        lastId = msgs[msgs.length - 1].id;
        remaining -= msgs.length;
        if (msgs.length < batch) break;
      }
      return { content: [{ type: "text", text: JSON.stringify({ query, messagesSearched: Math.min(limit, 500) - remaining, matchesFound: matches.length, messages: matches }, null, 2) }] };
    } catch (e) { return handleDiscordError(e); }
  });

  tool("discord_get_pinned", "Get a page of pinned messages, newest pin first. Use nextBefore when hasMore is true.", {
    channelId: ref.describe("Channel ID or name"),
    guildId: ref.optional().describe("Guild ID or name"),
    limit: z.number().int().min(1).max(50).default(50),
    before: z.iso.datetime({ offset: true }).optional().describe("Pin timestamp cursor from nextBefore"),
  }, async ({ channelId, guildId, limit, before }) => {
    try {
      const gId = guildId ? await resolveGuildId(guildId) : DEFAULT_GUILD;
      const cId = await resolveChannelId(gId, channelId);
      if (!cId) throw new Error('Could not resolve channel.');
      const params = new URLSearchParams({ limit: String(limit) });
      if (before) params.set('before', before);
      const pinned = await discordFetch(`/channels/${cId}/messages/pins?${params}`);
      const messages = pinned.items.filter(p => !isBanned(p.message)).map(p => ({ ...formatMessage(p.message), pinnedAt: p.pinned_at }));
      return { content: [{ type: "text", text: JSON.stringify({ channelId: cId, pinnedCount: messages.length, messages, hasMore: pinned.has_more, nextBefore: pinned.has_more ? pinned.items.at(-1)?.pinned_at : undefined }, null, 2) }] };
    } catch (e) { return handleDiscordError(e); }
  });

  tool("discord_get_message", "Get a specific message by ID.", {
    channelId: ref.describe("Channel ID or name"),
    guildId: ref.optional().describe("Guild ID or name (required if channelId is a name)"),
    messageId: id.describe("The message ID"),
  }, async ({ channelId, guildId, messageId }) => {
    try {
      const gId = guildId ? await resolveGuildId(guildId) : DEFAULT_GUILD;
      const cId = await resolveChannelId(gId, channelId);
      if (!cId) return { content: [{ type: "text", text: `Error: Could not resolve channel '${channelId}'` }], isError: true };
      const msg = await discordFetch(`/channels/${cId}/messages/${messageId}`);
      return { content: [{ type: "text", text: JSON.stringify(isBanned(msg) ? null : formatMessage(msg), null, 2) }] };
    } catch (e) { return handleDiscordError(e); }
  });

  // ─── TOOLS: Forum ────────────────────────────────────────────────────────────

  tool("discord_list_forums", "List all forum channels in a Discord server.", {
    guildId: ref.describe("Guild ID or name"),
  }, async ({ guildId }) => {
    try {
      const gId = await resolveGuildId(guildId);
      if (!gId) return { content: [{ type: "text", text: `Error: Could not resolve guild '${guildId}'` }], isError: true };
      const channels = await discordFetch(`/guilds/${gId}/channels`);
      const forums = channels.filter(c => c.type === 15).map(c => ({ id: c.id, name: c.name, topic: c.topic || null, tags: c.available_tags?.map(t => ({ id: t.id, name: t.name })) || [] }));
      return { content: [{ type: "text", text: JSON.stringify(forums, null, 2) }] };
    } catch (e) { return handleDiscordError(e); }
  });

  tool("discord_get_forum_post", "Get messages from a forum thread/post.", {
    threadId: id.describe("The thread/post ID"),
    limit: z.number().int().min(1).max(100).default(50).describe("Number of messages (1-100)"),
  }, async ({ threadId, limit = 50 }) => {
    try {
      const params = new URLSearchParams({ limit: String(Math.min(limit, 100)) });
      const messages = await discordFetch(`/channels/${threadId}/messages?${params}`);
      let threadInfo;
      try { threadInfo = await discordFetch(`/channels/${threadId}`); } catch { threadInfo = { id: threadId, name: "unknown" }; }
      return { content: [{ type: "text", text: JSON.stringify({ thread: { id: threadInfo.id, name: threadInfo.name }, messageCount: messages.filter(m => !isBanned(m)).length, messages: messages.filter(m => !isBanned(m)).reverse().map(formatMessage) }, null, 2) }] };
    } catch (e) { return handleDiscordError(e); }
  });

  tool("discord_create_forum_post", "Create a new post in a Discord forum channel.", {
    forumChannelId: ref.describe("Forum channel ID or name"),
    guildId: ref.optional().describe("Guild ID or name (required if forumChannelId is a name)"),
    title: z.string().min(1).max(100).describe("Post title"),
    content: contentSchema.describe("Post body content"),
    tags: z.array(ref).max(5).optional().describe("Tag names or IDs to apply"),
  }, async ({ forumChannelId, guildId, title, content, tags }) => {
    try {
      const gId = guildId ? await resolveGuildId(guildId) : DEFAULT_GUILD;
      const fId = await resolveChannelId(gId, forumChannelId);
      if (!fId) return { content: [{ type: "text", text: `Error: Could not resolve forum '${forumChannelId}'` }], isError: true };
      const body = { name: title, message: { content } };
      if (tags?.length) {
        const forum = await discordFetch(`/channels/${fId}`);
        const tagIds = tags.map(t => { const found = forum.available_tags?.find(at => at.name.toLowerCase() === t.toLowerCase() || at.id === t); if (!found) throw new Error(`Unknown forum tag: ${t}`); return found.id; });
        if (tagIds.length) body.applied_tags = tagIds;
      }
      const thread = await discordFetch(`/channels/${fId}/threads`, { method: "POST", body: JSON.stringify(body) });
      return { content: [{ type: "text", text: JSON.stringify({ created: true, threadId: thread.id, title: thread.name }, null, 2) }] };
    } catch (e) { return handleDiscordError(e); }
  });

  tool("discord_reply_to_forum", "Reply to a forum post/thread.", {
    threadId: id.describe("Thread/post ID"),
    message: contentSchema.describe("Reply content"),
  }, async ({ threadId, message }) => {
    try {
      const msg = await discordFetch(`/channels/${threadId}/messages`, { method: "POST", body: JSON.stringify({ content: message }) });
      return { content: [{ type: "text", text: JSON.stringify({ sent: true, messageId: msg.id, threadId }, null, 2) }] };
    } catch (e) { return handleDiscordError(e); }
  });

  // ─── TOOLS: Reactions ────────────────────────────────────────────────────────

  tool("discord_add_reaction", "Add an emoji reaction to a message.", {
    channelId: ref.describe("Channel ID or name"),
    guildId: ref.optional().describe("Guild ID or name"),
    messageId: id.describe("Message ID"),
    emoji: emojiSchema.describe("Emoji to react with (e.g. 👍, 🎉)"),
  }, async ({ channelId, guildId, messageId, emoji }) => {
    try {
      const gId = guildId ? await resolveGuildId(guildId) : DEFAULT_GUILD;
      const cId = await resolveChannelId(gId, channelId);
      if (!cId) return { content: [{ type: "text", text: `Error: Could not resolve channel '${channelId}'` }], isError: true };
      await discordFetch(`/channels/${cId}/messages/${messageId}/reactions/${encodeEmoji(emoji)}/@me`, { method: "PUT" });
      return { content: [{ type: "text", text: `Reaction ${emoji} added to message ${messageId}.` }] };
    } catch (e) { return handleDiscordError(e); }
  });

  tool("discord_remove_reaction", "Remove your reaction from a message.", {
    channelId: ref.describe("Channel ID or name"),
    guildId: ref.optional().describe("Guild ID or name"),
    messageId: id.describe("Message ID"),
    emoji: emojiSchema.describe("Emoji to remove"),
  }, async ({ channelId, guildId, messageId, emoji }) => {
    try {
      const gId = guildId ? await resolveGuildId(guildId) : DEFAULT_GUILD;
      const cId = await resolveChannelId(gId, channelId);
      if (!cId) return { content: [{ type: "text", text: `Error: Could not resolve channel '${channelId}'` }], isError: true };
      await discordFetch(`/channels/${cId}/messages/${messageId}/reactions/${encodeEmoji(emoji)}/@me`, { method: "DELETE" });
      return { content: [{ type: "text", text: `Reaction ${emoji} removed from message ${messageId}.` }] };
    } catch (e) { return handleDiscordError(e); }
  });

  tool("discord_add_multiple_reactions", "Add multiple emoji reactions to a message at once.", {
    channelId: ref.describe("Channel ID or name"),
    guildId: ref.optional().describe("Guild ID or name"),
    messageId: id.describe("Message ID"),
    emojis: z.array(emojiSchema).min(1).max(20).describe("Array of emojis to add"),
  }, async ({ channelId, guildId, messageId, emojis }) => {
    try {
      const gId = guildId ? await resolveGuildId(guildId) : DEFAULT_GUILD;
      const cId = await resolveChannelId(gId, channelId);
      if (!cId) return { content: [{ type: "text", text: `Error: Could not resolve channel '${channelId}'` }], isError: true };
      const results = [];
      for (const emoji of emojis) {
        try {
          await discordFetch(`/channels/${cId}/messages/${messageId}/reactions/${encodeEmoji(emoji)}/@me`, { method: "PUT" });
          results.push({ emoji, status: "added" });
        } catch (e) { results.push({ emoji, status: "failed", error: e.message }); }
      }
      return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }], isError: results.some(r => r.status === "failed") };
    } catch (e) { return handleDiscordError(e); }
  });

  // ─── TOOLS: Webhooks ────────────────────────────────────────────────────────

  tool("discord_create_webhook", "Create a webhook in a Discord channel.", {
    channelId: ref.describe("Channel ID or name"),
    guildId: ref.optional().describe("Guild ID or name"),
    name: z.string().min(1).max(80).describe("Webhook name"),
  }, async ({ channelId, guildId, name }) => {
    try {
      const gId = guildId ? await resolveGuildId(guildId) : DEFAULT_GUILD;
      const cId = await resolveChannelId(gId, channelId);
      if (!cId) return { content: [{ type: "text", text: `Error: Could not resolve channel '${channelId}'` }], isError: true };
      const wh = await discordFetch(`/channels/${cId}/webhooks`, { method: "POST", body: JSON.stringify({ name }) });
      return { content: [{ type: "text", text: JSON.stringify({ id: wh.id, name: wh.name, token: wh.token, url: `https://discord.com/api/webhooks/${wh.id}/${wh.token}` }, null, 2) }] };
    } catch (e) { return handleDiscordError(e); }
  });

  tool("discord_list_webhooks", "List all webhooks in a Discord channel.", {
    channelId: ref.describe("Channel ID or name"),
    guildId: ref.optional().describe("Guild ID or name"),
  }, async ({ channelId, guildId }) => {
    try {
      const gId = guildId ? await resolveGuildId(guildId) : DEFAULT_GUILD;
      const cId = await resolveChannelId(gId, channelId);
      if (!cId) return { content: [{ type: "text", text: `Error: Could not resolve channel '${channelId}'` }], isError: true };
      const webhooks = await discordFetch(`/channels/${cId}/webhooks`);
      return { content: [{ type: "text", text: JSON.stringify(webhooks.map(w => ({ id: w.id, name: w.name, channelId: w.channel_id, token: w.token })), null, 2) }] };
    } catch (e) { return handleDiscordError(e); }
  });

  tool("discord_send_webhook_message", "Send a message via webhook (posts as a custom bot identity).", {
    webhookId: id.describe("Webhook ID"),
    webhookToken: tokenSchema.describe("Webhook token"),
    content: contentSchema.describe("Message content"),
    username: z.string().min(1).max(80).optional().describe("Override username for this message"),
    avatarUrl: z.url({ protocol: /^https?$/ }).optional().describe("Override avatar URL for this message"),
  }, async ({ webhookId, webhookToken, content, username, avatarUrl }) => {
    try {
      const body = { content };
      if (username) body.username = username;
      if (avatarUrl) body.avatar_url = avatarUrl;
      await discordFetch(`/webhooks/${webhookId}/${webhookToken}?wait=true`, { method: "POST", body: JSON.stringify(body) });
      return { content: [{ type: "text", text: "Webhook message sent successfully." }] };
    } catch (e) { return handleDiscordError(e); }
  });

  tool("discord_delete_webhook", "Delete a webhook.", {
    webhookId: id.describe("Webhook ID"),
    webhookToken: tokenSchema.optional().describe("Webhook token (for URL-based auth)"),
  }, async ({ webhookId, webhookToken }) => {
    try {
      const url = webhookToken ? `/webhooks/${webhookId}/${webhookToken}` : `/webhooks/${webhookId}`;
      await discordFetch(url, { method: "DELETE" });
      return { content: [{ type: "text", text: `Webhook ${webhookId} deleted.` }] };
    } catch (e) { return handleDiscordError(e); }
  });

  return server;
}

export async function main() {
  const config = readConfig();
  if (config.userMode) console.error('[discord-mcp] WARNING: user-token/selfbot automation violates Discord terms and can lead to account termination.');
  const handle = serveStdio(() => createServer(), {
    onerror: () => console.error('[discord-mcp] MCP transport error.'),
  });
  console.error('[discord-mcp] v3.1.0 started — REST API mode');
  return handle;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('[discord-mcp] Startup failed. Set exactly one valid Discord token and numeric configuration IDs.'); process.exitCode = 1; });
}
