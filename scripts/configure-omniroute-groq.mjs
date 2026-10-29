import fs from 'node:fs';

const BASE = process.env.STATEX_OMNIROUTE_URL ?? 'http://127.0.0.1:20128';
const MODEL = 'openai/gpt-oss-20b';

function readGroqKey() {
  const file = process.env.GROQ_API_KEY_FILE;
  if (!file) throw new Error('Set GROQ_API_KEY_FILE to the protected local key file.');
  const st = fs.lstatSync(file);
  if (!st.isFile() || st.isSymbolicLink() || (st.mode & 0o077) !== 0) {
    throw new Error('The Groq key file must be a regular non-symlink file with mode 0600 or stricter.');
  }
  const text = fs.readFileSync(file, 'utf8').trim();
  const match = text.match(/^(?:GROQ_API_KEY\s*=\s*)?([^\r\n]+)$/);
  const key = match?.[1]?.trim().replace(/^['"]|['"]$/g, '');
  if (!key || /\s/.test(key)) throw new Error('The Groq key file has an invalid format.');
  return key;
}

async function main() {
  const url = new URL(BASE);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.port !== '20128' || url.pathname !== '/') {
    throw new Error('OmniRoute must be reachable only at http://127.0.0.1:20128.');
  }
  const password = process.env.STATEX_OMNIROUTE_ADMIN_PASSWORD;
  if (!password) throw new Error('Set STATEX_OMNIROUTE_ADMIN_PASSWORD in the local shell; its value is never printed.');
  const apiKey = readGroqKey();

  const login = await fetch(new URL('/api/auth/login', url), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }), redirect: 'error',
  });
  const cookieHeader = login.headers.get('set-cookie') ?? '';
  const token = cookieHeader.match(/(?:^|,\s*)auth_token=([^;,]+)/)?.[1];
  if (!login.ok || !token) throw new Error('OmniRoute login failed; no provider configuration was changed.');
  const headers = { cookie: `auth_token=${token}`, 'content-type': 'application/json' };
  const get = async path => {
    const r = await fetch(new URL(path, url), { headers, redirect: 'error' });
    if (!r.ok) throw new Error(`OmniRoute preflight failed (${r.status}); no provider configuration was changed.`);
    return r.json();
  };
  const [providers, combos, settings] = await Promise.all([get('/api/providers'), get('/api/combos'), get('/api/settings')]);
  const connections = providers?.connections;
  const comboList = Array.isArray(combos) ? combos : combos?.combos;
  if (!Array.isArray(connections) || connections.length !== 0 || !Array.isArray(comboList) || comboList.length !== 0
      || (typeof settings?.globalFallbackModel === 'string' && settings.globalFallbackModel.trim())) {
    throw new Error('OmniRoute is not a clean single-provider instance (existing providers/combos/fallback found); nothing was changed.');
  }
  const response = await fetch(new URL('/api/providers', url), {
    method: 'POST', headers,
    body: JSON.stringify({ provider: 'groq', apiKey, name: 'StateX Groq Free', priority: 1,
      defaultModel: MODEL, testStatus: 'unknown' }), redirect: 'error',
  });
  if (!response.ok) throw new Error(`OmniRoute could not store the Groq provider (${response.status}); response body suppressed.`);

  const check = await get('/api/providers');
  const configured = check?.connections;
  if (!Array.isArray(configured) || configured.length !== 1 || configured[0]?.provider !== 'groq'
      || configured[0]?.authType !== 'apikey' || configured[0]?.isActive !== true
      || configured[0]?.defaultModel !== MODEL || configured[0]?.apiKey !== undefined) {
    throw new Error('Post-configuration verification failed; inspect OmniRoute locally without displaying credentials.');
  }
  console.log('OmniRoute configured with one encrypted Groq API-key connection and openai/gpt-oss-20b. Key value was not printed.');
}

main().catch(error => {
  console.error(`Groq configuration stopped: ${error?.message ?? 'unexpected error'}`);
  process.exitCode = 1;
});
