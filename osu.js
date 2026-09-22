let token;
let expiresAt = 0;
let tokenRequest;

async function getToken() {
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
  const response = await fetch(`https://osu.ppy.sh/api/v2${path}`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  });
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
