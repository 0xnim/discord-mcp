const API_BASE = 'https://discord.com/api/v10';
const USER_AGENT = 'DiscordBot (https://github.com/FmBlueSystem/discord-mcp, 3.1.0)';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function readConfig(env = process.env) {
  const userToken = env.DISCORD_USER_TOKEN?.trim();
  const botToken = env.DISCORD_BOT_TOKEN?.trim();
  if (Boolean(userToken) === Boolean(botToken)) {
    throw new Error('Set exactly one of DISCORD_USER_TOKEN or DISCORD_BOT_TOKEN.');
  }
  const token = userToken || botToken.replace(/^Bot\s+/i, '');
  if (!token || /\s/.test(token)) throw new Error('Discord token must not contain whitespace.');
  const ids = (...values) => {
    const result = new Set(values.flatMap(value => (value || '').split(',')).map(s => s.trim()).filter(Boolean));
    if ([...result].some(id => !/^\d{1,20}$/.test(id))) throw new Error('Configured Discord IDs must be numeric strings.');
    return result;
  };
  const defaultGuild = env.DISCORD_DEFAULT_GUILD_ID?.trim() || '';
  ids(defaultGuild);
  return {
    authorization: userToken ? token : `Bot ${token}`,
    userMode: Boolean(userToken),
    defaultGuild,
    bannedGuilds: ids(env.DISCORD_BANNED_GUILD_IDS, env.DISCORD_BANNED_GUILDS),
    bannedUsers: ids(env.DISCORD_BANNED_USER_IDS, env.DISCORD_BANNED_USERS),
  };
}

export class DiscordError extends Error {
  constructor(message, status = 0, discordCode = 0) {
    super(message);
    this.status = status;
    this.discordCode = discordCode;
  }
}

const seconds = value => {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number * 1000 : null;
};

// One queue per server keeps concurrent MCP calls from racing the same bucket.
// Bucket identifiers remain scoped to their major resource; global limits stop all routes.
export function createDiscordClient(config, { fetchImpl = fetch, now = Date.now, wait = sleep, timeoutMs = 15_000, maxWaitMs = 30_000 } = {}) {
  const routes = new Map();
  const resets = new Map();
  let globalReset = 0;
  let queue = Promise.resolve();

  async function request(endpoint, { method = 'GET', body, reason } = {}) {
    if (!/^\/(channels|guilds|users|webhooks)\//.test(endpoint) || endpoint.includes('..') || endpoint.includes('#')) {
      throw new Error('Invalid Discord API endpoint.');
    }
    const path = endpoint.split('?')[0];
    const parts = path.split('/');
    const tokenAuth = parts[1] === 'webhooks' && Boolean(parts[3]);
    const major = parts.slice(1, tokenAuth ? 4 : 3).join('/');
    const route = `${method} ${major} ${parts.slice(tokenAuth ? 4 : 3).map(p => /^\d+$/.test(p) ? ':id' : p).join('/')}`;
    let key = routes.get(route) || route;
    for (let attempt = 0; attempt < 3; attempt++) {
      const delay = Math.max(globalReset, resets.get(key) || 0) - now();
      if (delay > maxWaitMs) throw new DiscordError('Discord rate limit requires a longer wait. Retry later.', 429);
      if (delay > 0) await wait(delay);
      const headers = { 'User-Agent': USER_AGENT };
      if (!tokenAuth) headers.Authorization = config.authorization;
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (reason) headers['X-Audit-Log-Reason'] = encodeURIComponent(reason);
      let response, data;
      try {
        response = await fetchImpl(`${API_BASE}${endpoint}`, {
          method, body, headers, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        });
        const text = await response.text();
        try { data = text ? JSON.parse(text) : null; } catch { data = null; }
      } catch {
        // Transport exceptions can contain URLs or credentials. Never echo them or replay writes.
        throw new DiscordError('Discord request failed or timed out. Delivery may be unknown; check before retrying a write.');
      }
      const bucket = response.headers.get('X-RateLimit-Bucket');
      if (bucket) {
        key = `${major}:${bucket}`;
        routes.set(route, key);
      }
      const resetAfter = seconds(response.headers.get('X-RateLimit-Reset-After'));
      if (response.headers.get('X-RateLimit-Remaining') === '0' && resetAfter !== null) {
        resets.set(key, now() + resetAfter);
      }
      if (response.status === 429) {
        const delays = [seconds(data?.retry_after), seconds(response.headers.get('Retry-After')), resetAfter].filter(value => value !== null);
        const retry = delays.length ? Math.max(...delays, 50) : 1000;
        if (data?.global || response.headers.get('X-RateLimit-Global') === 'true' || response.headers.get('X-RateLimit-Scope') === 'global') globalReset = now() + retry;
        else resets.set(key, now() + retry);
        if (attempt === 2) throw new DiscordError('Discord rate limit persisted after 3 attempts. Retry later.', 429);
        continue;
      }
      if (!response.ok) {
        // Discord response bodies may echo user content, webhook URLs or tokens.
        throw new DiscordError(`Discord API returned HTTP ${response.status}.`, response.status, typeof data?.code === 'number' ? data.code : 0);
      }
      if (response.status === 204) return null;
      if (data === null) throw new DiscordError('Discord returned an invalid JSON response.', response.status);
      return data;
    }
  }

  return (endpoint, options) => {
    const result = queue.then(() => request(endpoint, options));
    queue = result.catch(() => {});
    return result;
  };
}
