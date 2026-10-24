const { setTimeout: delay } = require('node:timers/promises');

let token;
let expiresAt = 0;
let tokenRequest;
let requests = Promise.resolve();
let nextRequestAt = 0;
let blockedUntil = 0;

function rateLimitError(response) {
  const now = Date.now();
  if (response) {
    const header = response.headers.get('retry-after');
    const seconds = header && /^\d+(?:\.\d+)?$/.test(header) ? Number(header) : NaN;
    const wait = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - now;
    blockedUntil = Math.max(blockedUntil, now + (Number.isFinite(wait) ? Math.max(1000, wait) : 60000));
  }
  const error = new Error('OSU_RATE_LIMITED');
  error.status = 429;
  error.retryAfter = Math.max(1, Math.ceil((blockedUntil - now) / 1000));
  return error;
}

// Shared by recent plays and the finder: pace requests across users and commands.
function limitedGet(path, accessToken) {
  const request = requests.then(async () => {
    if (Date.now() < blockedUntil) throw rateLimitError();
    const wait = nextRequestAt - Date.now();
    if (wait > 0) await delay(wait);
    if (Date.now() < blockedUntil) throw rateLimitError();
    nextRequestAt = Date.now() + 1100;
    const response = await fetch(`https://osu.ppy.sh/api/v2${path}`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    if (response.status === 429) throw rateLimitError(response);
    return response;
  });
  requests = request.catch(() => {});
  return request;
}

async function getToken() {
  if (Date.now() < blockedUntil) throw rateLimitError();
  if (token && Date.now() < expiresAt) return token;
  if (!tokenRequest) {
    tokenRequest = (async () => {
      if (!process.env.OSU_CLIENT_ID || !process.env.OSU_CLIENT_SECRET) {
        throw new Error('OSU_NOT_CONFIGURED');
      }
      const response = await fetch('https://osu.ppy.sh/oauth/token', {
        method: 'POST',
        headers: { Accept: 'application/json' },
        body: new URLSearchParams({
          client_id: process.env.OSU_CLIENT_ID,
          client_secret: process.env.OSU_CLIENT_SECRET,
          grant_type: 'client_credentials',
          scope: 'public',
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (response.status === 429) throw rateLimitError(response);
      if (!response.ok) throw new Error('OSU_AUTH_FAILED');
      const data = await response.json();
      if (!data.access_token || !Number.isFinite(data.expires_in)) throw new Error('OSU_AUTH_FAILED');
      token = data.access_token;
      expiresAt = Date.now() + Math.max(0, data.expires_in - 60) * 1000;
      return token;
    })().finally(() => { tokenRequest = undefined; });
  }
  return tokenRequest;
}

async function osuGet(path, retry = true) {
  const accessToken = await getToken();
  const response = await limitedGet(path, accessToken);
  if (response.status === 401 && retry) {
    if (token === accessToken) { token = undefined; expiresAt = 0; }
    return osuGet(path, false);
  }
  if (!response.ok) {
    const error = new Error('OSU_API_FAILED');
    error.status = response.status;
    throw error;
  }
  return response.json();
}

module.exports = { osuGet };
