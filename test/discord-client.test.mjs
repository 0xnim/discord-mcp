import test from 'node:test';
import assert from 'node:assert/strict';
import { createDiscordClient, readConfig } from '../assets/discord-client.mjs';

const config = readConfig({ DISCORD_USER_TOKEN: 'user-secret' });
function fixture(responses, options = {}) {
  const calls = [], waits = [];
  let time = 0;
  const request = createDiscordClient(config, {
    now: () => time,
    wait: async ms => { waits.push(ms); time += ms; },
    fetchImpl: async (url, init) => {
      calls.push({ url, ...init, time });
      const response = responses.shift();
      assert.ok(response, 'Unexpected Discord request');
      return response;
    },
    ...options,
  });
  return { request, calls, waits };
}
const json = (data, status = 200, headers = {}) => Response.json(data, { status, headers });

test('auth is explicit, trims tokens, accepts a single Bot prefix, and parses aliases', () => {
  assert.equal(config.authorization, 'user-secret');
  assert.equal(readConfig({ DISCORD_BOT_TOKEN: ' secret ' }).authorization, 'Bot secret');
  assert.equal(readConfig({ DISCORD_BOT_TOKEN: 'Bot secret' }).authorization, 'Bot secret');
  for (const env of [{}, { DISCORD_USER_TOKEN: 'a', DISCORD_BOT_TOKEN: 'b' }, { DISCORD_USER_TOKEN: 'a\nb' }]) assert.throws(() => readConfig(env));
  const value = readConfig({ DISCORD_USER_TOKEN: 'x', DISCORD_BANNED_GUILDS: ' 1,2, ', DISCORD_BANNED_GUILD_IDS: '2,3', DISCORD_BANNED_USERS: ' 4 ' });
  assert.deepEqual([...value.bannedGuilds], ['2', '3', '1']);
  assert.deepEqual([...value.bannedUsers], ['4']);
  assert.throws(() => readConfig({ DISCORD_USER_TOKEN: 'x', DISCORD_DEFAULT_GUILD_ID: '../bad' }));
});

test('API requests use v10, correct auth, audit reasons, timeout and redirect protection', async () => {
  const { request, calls } = fixture([new Response(null, { status: 204 })]);
  assert.equal(await request('/channels/1', { method: 'DELETE', reason: 'because / café' }), null);
  assert.equal(calls[0].url, 'https://discord.com/api/v10/channels/1');
  assert.equal(calls[0].headers.Authorization, 'user-secret');
  assert.equal(calls[0].headers['X-Audit-Log-Reason'], encodeURIComponent('because / café'));
  assert.equal(calls[0].redirect, 'error');
  assert.ok(calls[0].signal instanceof AbortSignal);
  await assert.rejects(request('https://elsewhere.example/channels/1'), /Invalid/);
  await assert.rejects(request('/channels/../users/@me'), /Invalid/);
});

test('webhook token auth omits the account Authorization header', async () => {
  const { request, calls } = fixture([json({}), json({})]);
  await request('/webhooks/1/webhook-secret?wait=true', { method: 'POST', body: '{}' });
  await request('/webhooks/1', { method: 'DELETE' });
  assert.equal(calls[0].headers.Authorization, undefined);
  assert.equal(calls[1].headers.Authorization, 'user-secret');
});

test('fractional JSON retry_after works without Retry-After header', async () => {
  const { request, waits, calls } = fixture([json({ retry_after: 0.125 }, 429), json({ ok: true })]);
  assert.deepEqual(await request('/channels/1'), { ok: true });
  assert.deepEqual(waits, [125]);
  assert.equal(calls.length, 2);
});

test('uses the longest server delay and exactly three attempts without a final sleep', async () => {
  const { request, waits, calls } = fixture(Array.from({ length: 3 }, () => json({ retry_after: 0.1 }, 429, { 'Retry-After': '0.25' })));
  await assert.rejects(request('/channels/1'), { status: 429 });
  assert.deepEqual(waits, [250, 250]);
  assert.equal(calls.length, 3);
});

test('exhausted global limit delays a queued request on another route', async () => {
  const { request, waits, calls } = fixture([
    ...Array.from({ length: 3 }, () => json({ retry_after: 0.1, global: true }, 429)), json({}),
  ]);
  const [first, second] = await Promise.allSettled([request('/channels/1'), request('/guilds/2')]);
  assert.equal(first.status, 'rejected');
  assert.equal(second.status, 'fulfilled');
  assert.deepEqual(waits, [100, 100, 100]);
  assert.equal(calls.at(-1).time, 300);
});

test('successful exhausted bucket delays next request; different major resource is independent', async () => {
  const { request, waits } = fixture([
    json({}, 200, { 'X-RateLimit-Bucket': 'bucket', 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset-After': '0.4' }),
    json({}, 200, { 'X-RateLimit-Bucket': 'bucket' }), json({}),
  ]);
  await request('/channels/1/messages');
  await request('/channels/2/messages');
  assert.deepEqual(waits, []);
  await request('/channels/1/messages');
  assert.deepEqual(waits, [400]);
});

test('learned shared bucket coordinates different methods/routes', async () => {
  const { request, waits } = fixture([
    json({}, 200, { 'X-RateLimit-Bucket': 'shared' }),
    json({}, 200, { 'X-RateLimit-Bucket': 'shared', 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset-After': '0.25' }), json({}),
  ]);
  await request('/channels/1/messages');
  await request('/channels/1/messages', { method: 'POST', body: '{}' });
  await request('/channels/1/messages');
  assert.deepEqual(waits, [250]);
});

test('long retry delays fail promptly and remain enforced across later calls', async () => {
  const { request, calls, waits } = fixture([json({ retry_after: 100, global: true }, 429)]);
  await assert.rejects(request('/channels/1'), { status: 429 });
  await assert.rejects(request('/guilds/2'), { status: 429 });
  assert.equal(calls.length, 1);
  assert.deepEqual(waits, []);
});

test('HTTP, non-JSON and network failures redact payloads and never replay writes', async () => {
  for (const response of [json({ code: 50013, message: 'user-secret' }, 403), new Response('user-secret', { status: 502 }), new Response('user-secret')]) {
    const { request, calls } = fixture([response]);
    await assert.rejects(request('/channels/1/messages', { method: 'POST', body: '{}' }), error => !error.message.includes('user-secret'));
    assert.equal(calls.length, 1);
  }
  let attempts = 0;
  const { request } = fixture([], { fetchImpl: async () => { attempts++; throw new Error('https://discord.com/api/webhooks/1/user-secret'); } });
  await assert.rejects(request('/channels/1/messages', { method: 'POST' }), /Delivery may be unknown/);
  assert.equal(attempts, 1);
});

test('timeout includes response-body consumption and queue recovers', async () => {
  let calls = 0;
  const { request } = fixture([], {
    timeoutMs: 10,
    fetchImpl: async (_url, { signal }) => {
      if (calls++) return json({ ok: true });
      return { text: () => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) };
    },
  });
  const keepAlive = setTimeout(() => {}, 100);
  try {
    await assert.rejects(request('/channels/1'), /timed out/);
    assert.deepEqual(await request('/channels/2'), { ok: true });
  } finally { clearTimeout(keepAlive); }
});
