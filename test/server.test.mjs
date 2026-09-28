import test from 'node:test';
import assert from 'node:assert/strict';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { spawnSync } from 'node:child_process';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { fileURLToPath } from 'node:url';
import { createServer } from '../assets/index.mjs';

async function connect(t, responder, env = {}, mode = 'legacy') {
  const calls = [];
  const factory = () => createServer({ env: { DISCORD_USER_TOKEN: 'test-secret', ...env }, fetchImpl: async (url, init) => {
    const call = { url: new URL(url), ...init };
    calls.push(call);
    const data = await responder(call, calls.length);
    return data instanceof Response ? data : Response.json(data);
  } });
  const client = new Client({ name: 'test-client', version: '1.0.0' }, { versionNegotiation: { mode } });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = serveStdio(factory, { transport: a });
  await client.connect(b);
  t.after(async () => { await client.close(); await server.close(); });
  return { client, calls, call: (name, args = {}) => client.callTool({ name, arguments: args }) };
}
function data(result) {
  assert.ok(!result.isError, result.content[0].text);
  return JSON.parse(result.content[0].text);
}
const msg = (id, author = '7', content = 'hello') => ({ id, author: { id: author, username: 'tester' }, content, timestamp: '2026-09-28T00:00:00Z' });

test('MCP discovers all 23 original tool names and bounded schemas/annotations', async t => {
  const { client } = await connect(t, () => []);
  const { tools } = await client.listTools();
  assert.equal(tools.length, 23);
  for (const name of ['discord_get_server_info', 'discord_delete_channel', 'discord_list_forums', 'discord_reply_to_forum', 'discord_add_multiple_reactions']) assert.ok(tools.some(tool => tool.name === name));
  const read = tools.find(tool => tool.name === 'discord_read_channel');
  assert.equal(read.inputSchema.properties.limit.maximum, 100);
  assert.equal(read.inputSchema.properties.limit.minimum, 1);
  assert.equal(read.annotations.readOnlyHint, true);
  assert.equal(tools.find(tool => tool.name === 'discord_delete_channel').annotations.destructiveHint, true);
});

test('invalid arguments are rejected before any Discord call', async t => {
  const { call, calls } = await connect(t, () => { throw new Error('Must not fetch'); });
  for (const [name, args] of [
    ['discord_read_channel', { channelId: '1', limit: 0 }],
    ['discord_read_channel', { channelId: '1', limit: 1.5 }],
    ['discord_read_channel', { channelId: '1', limit: 101 }],
    ['discord_read_channel', { channelId: '1', before: '2', after: '3' }],
    ['discord_send_message', { channelId: '1', message: '' }],
    ['discord_send_message', { channelId: '1', message: 'x'.repeat(2001) }],
    ['discord_get_message', { channelId: '1', messageId: '../webhooks' }],
    ['discord_create_channel', { guildId: '1', name: 'test', type: 3 }],
    ['discord_get_pinned', { channelId: '1', limit: 51 }],
    ['discord_get_pinned', { channelId: '1', before: '123' }],
    ['discord_send_webhook_message', { webhookId: '1', webhookToken: '../secret', content: 'x' }],
    ['discord_add_multiple_reactions', { channelId: '1', messageId: '2', emojis: [] }],
    ['discord_list_guilds', { unexpected: true }],
  ]) assert.equal((await call(name, args)).isError, true, name);
  assert.equal(calls.length, 0);
});

test('guild info safely converts snowflake timestamp and requests member counts', async t => {
  const { call, calls } = await connect(t, () => ({ id: '175928847299117063', name: 'test', approximate_member_count: 42 }));
  const result = data(await call('discord_get_server_info', { guildId: '175928847299117063' }));
  assert.equal(result.createdAt, '2016-04-30T11:18:25.796Z');
  assert.equal(result.memberCount, 42);
  assert.equal(calls[0].url.searchParams.get('with_counts'), 'true');
});

test('guild listing paginates and omits blocked guilds', async t => {
  const { call, calls } = await connect(t, (_call, index) => index === 1 ? Array.from({ length: 200 }, (_, i) => ({ id: String(i + 1), name: `g${i}` })) : [{ id: '201', name: 'last' }], { DISCORD_BANNED_GUILDS: ' 1 ' });
  assert.equal(data(await call('discord_list_guilds')).length, 200);
  assert.equal(calls[1].url.searchParams.get('after'), '200');
});

test('name resolution accepts #name and rejects duplicates before writing', async t => {
  const { call, calls } = await connect(t, ({ url }, n) => {
    if (url.pathname.endsWith('/channels')) return n === 1 ? [{ id: '2', name: 'general' }] : [{ id: '2', name: 'general' }, { id: '3', name: 'general' }];
    return { id: '10' };
  }, { DISCORD_DEFAULT_GUILD_ID: '1' });
  assert.ok(!((await call('discord_send_message', { channelId: '#GENERAL', message: 'first' })).isError));
  const result = await call('discord_send_message', { channelId: '#general', message: 'second' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Ambiguous/);
  assert.equal(calls.filter(c => c.method === 'POST').length, 1);
});

test('channel reads are chronological and use attachment filename; user filtering applies', async t => {
  const { call } = await connect(t, ({ url }) => url.pathname.endsWith('/messages') ? [msg('3'), msg('2', '9'), { ...msg('1'), attachments: [{ filename: 'report.txt', url: 'https://example.com/report.txt' }] }] : { id: '1', name: 'general', type: 0 }, { DISCORD_BANNED_USER_IDS: '9' });
  const result = data(await call('discord_read_channel', { channelId: '1' }));
  assert.deepEqual(result.messages.map(m => m.id), ['1', '3']);
  assert.match(result.messages[0].attachments, /report.txt/);
  assert.equal(result.messageCount, 2);
});

test('single-message, thread, search and pins reads consistently filter banned authors', async t => {
  const { call } = await connect(t, ({ url }) => {
    if (url.pathname.endsWith('/messages/pins')) return { items: [{ message: msg('2', '9'), pinned_at: '2026-09-28T00:00:00Z' }], has_more: true };
    if (url.pathname.endsWith('/messages/2')) return msg('2', '9');
    if (url.pathname.endsWith('/messages')) return [msg('2', '9'), msg('1')];
    return { id: '1', name: 'thread' };
  }, { DISCORD_BANNED_USERS: '9' });
  assert.equal(data(await call('discord_get_message', { channelId: '1', messageId: '2' })), null);
  assert.equal(data(await call('discord_get_forum_post', { threadId: '1' })).messageCount, 1);
  assert.equal(data(await call('discord_search_messages', { channelId: '1', query: 'HELLO' })).matchesFound, 1);
  const pins = data(await call('discord_get_pinned', { channelId: '1' }));
  assert.equal(pins.pinnedCount, 0);
  assert.equal(pins.nextBefore, '2026-09-28T00:00:00Z');
});

test('pins use new paginated endpoint and timestamp cursor', async t => {
  const { call, calls } = await connect(t, () => ({ items: [{ message: msg('3'), pinned_at: '2026-09-20T00:00:00Z' }], has_more: false }));
  const pins = data(await call('discord_get_pinned', { channelId: '1', before: '2026-09-28T00:00:00Z', limit: 10 }));
  assert.equal(pins.messages[0].pinnedAt, '2026-09-20T00:00:00Z');
  assert.equal(calls[0].url.pathname, '/api/v10/channels/1/messages/pins');
  assert.equal(calls[0].url.searchParams.get('limit'), '10');
  assert.equal(calls[0].url.searchParams.get('before'), '2026-09-28T00:00:00Z');
});

test('blocked guild checks cover channel/thread reads and writes, reactions and webhook routes', async t => {
  const { call, calls } = await connect(t, ({ url }) => ({ id: '1', guild_id: '99', type: 0, name: 'blocked', url: url.href }), { DISCORD_BANNED_GUILD_IDS: '99' });
  for (const [name, args] of [
    ['discord_list_channels', { guildId: '99' }],
    ['discord_get_server_info', { guildId: '99' }],
    ['discord_create_channel', { guildId: '99', name: 'test' }],
    ['discord_get_channel_info', { channelId: '1' }],
    ['discord_read_channel', { channelId: '1', guildId: '88' }],
    ['discord_send_message', { channelId: '1', message: 'hello' }],
    ['discord_delete_channel', { channelId: '1' }],
    ['discord_delete_message', { channelId: '1', messageId: '2' }],
    ['discord_get_message', { channelId: '1', messageId: '2' }],
    ['discord_get_pinned', { channelId: '1' }],
    ['discord_search_messages', { channelId: '1', query: 'hello' }],
    ['discord_get_forum_post', { threadId: '1' }],
    ['discord_create_forum_post', { forumChannelId: '1', title: 'test', content: 'hello' }],
    ['discord_reply_to_forum', { threadId: '1', message: 'hello' }],
    ['discord_add_reaction', { channelId: '1', messageId: '2', emoji: '👍' }],
    ['discord_remove_reaction', { channelId: '1', messageId: '2', emoji: '👍' }],
    ['discord_add_multiple_reactions', { channelId: '1', messageId: '2', emojis: ['👍'] }],
    ['discord_create_webhook', { channelId: '1', name: 'test' }],
    ['discord_list_webhooks', { channelId: '1' }],
    ['discord_send_webhook_message', { webhookId: '1', webhookToken: 'secret', content: 'hello' }],
    ['discord_delete_webhook', { webhookId: '1' }],
    ['discord_delete_webhook', { webhookId: '1', webhookToken: 'secret' }],
  ]) assert.equal((await call(name, args)).isError, true, name);
  assert.ok(calls.every(c => c.method === 'GET'));
  assert.ok(calls.every(c => /^\/api\/v10\/(channels|webhooks)\/1(?:\/secret)?$/.test(c.url.pathname)));
});

test('restrictions fail closed on unverifiable guild but permit DMs', async t => {
  const { call } = await connect(t, ({ url }) => url.pathname.endsWith('/2') ? { id: '2', type: 1 } : { id: '1', type: 0 }, { DISCORD_BANNED_GUILDS: '99' });
  assert.equal((await call('discord_get_channel_info', { channelId: '1' })).isError, true);
  assert.equal(data(await call('discord_get_channel_info', { channelId: '2' })).type, 'DM');
});

test('forum tags resolve names, preserve valid payload, and reject unknown tags', async t => {
  const { call, calls } = await connect(t, ({ method }) => method === 'GET' ? { available_tags: [{ id: '3', name: 'News' }] } : { id: '4', name: 'title' });
  const args = { forumChannelId: '1', title: 'title', content: 'body', tags: ['news'] };
  assert.equal(data(await call('discord_create_forum_post', args)).threadId, '4');
  assert.deepEqual(JSON.parse(calls[1].body), { name: 'title', message: { content: 'body' }, applied_tags: ['3'] });
  assert.equal((await call('discord_create_forum_post', { ...args, tags: ['unknown'] })).isError, true);
  assert.equal(calls.filter(c => c.method === 'POST').length, 1);
});

test('reaction syntax is normalized and partial batch failures mark the MCP result as error', async t => {
  const { call, calls } = await connect(t, (_call, n) => n === 1 ? new Response(null, { status: 204 }) : Response.json({ code: 50013 }, { status: 403 }));
  const result = await call('discord_add_multiple_reactions', { channelId: '1', messageId: '2', emojis: ['<a:wave:123>', '👍'] });
  assert.equal(result.isError, true);
  assert.ok(calls[0].url.pathname.includes('wave%3A123'));
});

test('delete reasons reach Discord and webhook writes request confirmation without account auth', async t => {
  const { call, calls } = await connect(t, ({ method }) => method === 'DELETE' ? new Response(null, { status: 204 }) : { id: '3' });
  assert.ok(!(await call('discord_delete_message', { channelId: '1', messageId: '2', reason: 'test / reason' })).isError);
  assert.equal(calls[0].headers['X-Audit-Log-Reason'], 'test%20%2F%20reason');
  assert.ok(!(await call('discord_send_webhook_message', { webhookId: '1', webhookToken: 'secret', content: 'hello' })).isError);
  assert.equal(calls[1].url.searchParams.get('wait'), 'true');
  assert.equal(calls[1].headers.Authorization, undefined);
});

test('errors return actionable MCP tool errors without echoing remote secrets', async t => {
  const { call } = await connect(t, () => Response.json({ code: 50013, message: 'test-secret' }, { status: 403 }));
  const result = await call('discord_send_message', { channelId: '1', message: 'hello' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Missing permissions/);
  assert.ok(!result.content[0].text.includes('test-secret'));
});

for (const mode of ['legacy', { pin: '2026-07-28' }]) test(`real stdio supports ${JSON.stringify(mode)} without contacting Discord`, async t => {
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../assets/index.mjs', import.meta.url))], env: { DISCORD_USER_TOKEN: 'fake-token' }, stderr: 'pipe' });
  let stderr = '';
  transport.stderr.on('data', chunk => { stderr += chunk; });
  const client = new Client({ name: 'stdio-test', version: '1' }, { versionNegotiation: { mode } });
  t.after(() => client.close());
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, 23);
  assert.match(stderr, /violates Discord terms/);
  assert.ok(!stderr.includes('fake-token'));
});


test('2026-07-28 negotiation serves tool results and validates arguments', async t => {
  const { call } = await connect(t, () => [], {}, { pin: '2026-07-28' });
  assert.deepEqual(data(await call('discord_list_guilds')), []);
  assert.equal((await call('discord_send_message', { channelId: '1', message: '' })).isError, true);
});

test('missing or conflicting credentials fail startup with clean stdout and no secret', () => {
  for (const tokens of [{}, { DISCORD_USER_TOKEN: 'fake-user-secret', DISCORD_BOT_TOKEN: 'fake-bot-secret' }]) {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../assets/index.mjs', import.meta.url))], { env: tokens, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /exactly one/);
    assert.ok(!result.stderr.includes('fake-'));
  }
});
