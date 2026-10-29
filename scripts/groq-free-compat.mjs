import http from 'node:http';
import fs from 'node:fs';

export const GROQ_FREE_MODEL = 'openai/gpt-oss-20b';
export const GROQ_FREE_MODEL_ROUTE = `groq/${GROQ_FREE_MODEL}`;
export const GROQ_FREE_MAX_REQUESTS = 4;
export const GROQ_FREE_MAX_OUTPUT = 512;
const GROQ_ENDPOINT = '/v1/providers/groq/chat/completions';
const TOOL_NAMES = ['Read', 'Write', 'Edit'];

const safeError = (status) => ({
  402: 'billing_blocked', 403: 'provider_forbidden', 429: 'rate_limited',
  503: 'provider_unavailable', 502: 'provider_unavailable', 500: 'provider_unavailable',
}[status] ?? 'provider_error');

function readJsonFile(file) {
  if (!file) return null;
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || (st.mode & 0o077) !== 0) return null;
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value && typeof value === 'object' ? value : null;
  } catch { return null; }
}

function freshFreeAttestation(file, now = Date.now()) {
  const p = readJsonFile(file);
  const age = p?.verifiedAt ? now - Date.parse(p.verifiedAt) : Infinity;
  return p?.provider === 'groq'
    && p?.model === GROQ_FREE_MODEL
    && p?.tier === 'free'
    && p?.verifiedBy === 'operator_console'
    && p?.limits?.rpm === 30 && p?.limits?.rpd === 1000
    && p?.limits?.tpm === 8000 && p?.limits?.tpd === 200000
    && Number.isFinite(age) && age >= 0 && age <= 24 * 60 * 60 * 1000;
}

async function readBody(req, limit = 1024 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('body_too_large'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('invalid_json'), { status: 400 }); }
}

function validateRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'invalid_request';
  if (body.model !== 'auto') return 'model_forbidden';
  if (body.stream !== false) return 'streaming_not_supported';
  if (body.max_tokens !== GROQ_FREE_MAX_OUTPUT) return 'output_limit_exceeded';
  if (!Array.isArray(body.tools) || body.tools.length !== TOOL_NAMES.length) return 'tool_policy_mismatch';
  const names = body.tools.map(t => t?.function?.name);
  if (TOOL_NAMES.some(name => !names.includes(name)) || names.some(name => !TOOL_NAMES.includes(name))) return 'tool_policy_mismatch';
  if (!Array.isArray(body.messages) || body.messages.length < 2 || body.messages.length > 64) return 'invalid_messages';
  if (Buffer.byteLength(JSON.stringify(body)) > 512 * 1024) return 'request_too_large';
  if (body.max_completion_tokens !== undefined && body.max_completion_tokens !== GROQ_FREE_MAX_OUTPUT) return 'output_limit_exceeded';
  if (body.model !== 'auto' || body.stream !== false) return 'routing_parameter_forbidden';
  if (body.tool_choice !== 'auto' || body.parallel_tool_calls !== false) return 'routing_parameter_forbidden';
  return null;
}

function sanitizeResponse(body, proof) {
  const model = body?.model;
  if (model !== GROQ_FREE_MODEL && model !== GROQ_FREE_MODEL_ROUTE) throw new Error('model_not_allowed');
  const choice = body?.choices?.length === 1 ? body.choices[0] : null;
  const message = choice?.message;
  const usage = body?.usage;
  if (!choice || !message || message.role !== 'assistant' || !usage
    || !Number.isSafeInteger(usage.prompt_tokens) || usage.prompt_tokens < 0
    || !Number.isSafeInteger(usage.completion_tokens) || usage.completion_tokens < 0
    || usage.completion_tokens > GROQ_FREE_MAX_OUTPUT
    || !['stop', 'tool_calls', 'length'].includes(choice.finish_reason)) throw new Error('invalid_upstream_response');
  if (usage.cost !== undefined && usage.cost !== 0 && usage.cost !== '0' && usage.cost !== '0.0' && usage.cost !== '0.00') {
    throw new Error('nonzero_or_unknown_cost');
  }
  if (usage.cost === undefined && !proof.costKnownZero) throw new Error('cost_unknown');
  if (message.tool_calls !== undefined) {
    if (!Array.isArray(message.tool_calls) || message.tool_calls.some(c =>
      typeof c?.id !== 'string' || !c.id || c.type !== 'function'
      || !TOOL_NAMES.includes(c.function?.name) || typeof c.function?.arguments !== 'string')) {
      throw new Error('invalid_tool_calls');
    }
  }
  const normalized = { ...body, model: GROQ_FREE_MODEL };
  normalized.usage = { ...usage, cost: 0 };
  return normalized;
}

function json(res, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': data.length, 'cache-control': 'no-store' });
  res.end(data);
}

/**
 * Small OpenAI-compatible policy proxy. It only accepts StateX's fixed request
 * shape and calls OmniRoute's provider-pinned Groq route once. policyProbe must
 * inspect the live OmniRoute instance and a fresh, protected account attestation.
 */
export function createGroqFreeCompatServer({
  fetchImpl = fetch,
  omniRouteBase = 'http://127.0.0.1:20128',
  policyProbe,
  maxRequests = GROQ_FREE_MAX_REQUESTS,
} = {}) {
  if (typeof policyProbe !== 'function') throw new TypeError('policyProbe is required');
  if (!Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > GROQ_FREE_MAX_REQUESTS) throw new TypeError('invalid request cap');
  const omni = new URL(omniRouteBase);
  if (omni.protocol !== 'http:' || omni.hostname !== '127.0.0.1' || omni.port !== '20128' || omni.pathname !== '/' || omni.username || omni.password) {
    throw new TypeError('OmniRoute must be isolated on 127.0.0.1:20128');
  }
  let requests = 0;
  let inFlight = false;
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/health') {
        const proof = await policyProbe();
        const ready = proof?.ok === true && proof?.costKnownZero === true;
        return json(res, ready ? 200 : 503, ready
          ? { status: 'ok', policy: 'free-only', provider: 'groq', model: GROQ_FREE_MODEL, requests_remaining: Math.max(0, maxRequests - requests) }
          : { status: 'error', policy: 'unverified' });
      }
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') return json(res, 404, { error: { code: 'not_found' } });
      if (inFlight) return json(res, 429, { error: { code: 'rate_limited' } });
      const proof = await policyProbe();
      if (proof?.ok !== true || proof?.costKnownZero !== true) return json(res, 503, { error: { code: 'free_policy_unverified' } });
      const body = await readBody(req);
      const invalid = validateRequest(body);
      if (invalid) return json(res, 400, { error: { code: invalid } });
      if (requests >= maxRequests) return json(res, 429, { error: { code: 'test_request_limit' } });
      requests++;
      inFlight = true;
      try {
        let upstream;
        try {
          upstream = await fetchImpl(new URL(GROQ_ENDPOINT, omni), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ...body, model: GROQ_FREE_MODEL_ROUTE, max_tokens: GROQ_FREE_MAX_OUTPUT }),
            redirect: 'error',
            signal: AbortSignal.timeout(120000),
          });
        } catch {
          return json(res, 502, { error: { code: 'provider_unavailable' } });
        }
        if (!upstream.ok) return json(res, upstream.status, { error: { code: safeError(upstream.status) } });
        let raw;
        try { raw = await upstream.json(); }
        catch { return json(res, 502, { error: { code: 'invalid_upstream_response' } }); }
        try { return json(res, 200, sanitizeResponse(raw, proof)); }
        catch (error) {
          const code = ['model_not_allowed', 'nonzero_or_unknown_cost', 'cost_unknown', 'invalid_tool_calls'].includes(error.message)
            ? error.message : 'invalid_upstream_response';
          return json(res, 502, { error: { code } });
        }
      } finally { inFlight = false; }
    } catch (error) {
      return json(res, error?.status === 413 ? 413 : error?.status === 400 ? 400 : 503,
        { error: { code: error?.status === 413 ? 'request_too_large' : error?.status === 400 ? 'invalid_request' : 'free_policy_unverified' } });
    }
  });
  return { server, get requestsUsed() { return requests; } };
}

/** Live policy proof against OmniRoute's protected management API. */
export function createOmniRoutePolicyProbe({
  base = 'http://127.0.0.1:20128',
  adminPassword,
  attestationFile,
  fetchImpl = fetch,
  emergencyFallbackFile,
  now = () => Date.now(),
} = {}) {
  let cookie;
  async function login() {
    if (!adminPassword) return false;
    const r = await fetchImpl(new URL('/api/auth/login', base), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: adminPassword }), redirect: 'error',
    });
    const rawCookie = r.headers.get('set-cookie') ?? '';
    const match = rawCookie.match(/(?:^|,\s*)auth_token=([^;,]+)/);
    if (!r.ok || !match) return false;
    cookie = `auth_token=${match[1]}`;
    return true;
  }
  async function get(pathname) {
    if (!cookie && !await login()) return null;
    const r = await fetchImpl(new URL(pathname, base), { headers: { cookie }, redirect: 'error' });
    if (r.status === 401 && await login()) return get(pathname);
    if (!r.ok) return null;
    try { return await r.json(); } catch { return null; }
  }
  return async function verify() {
    if (!freshFreeAttestation(attestationFile, now())) return { ok: false };
    try {
      const [providers, combos, settings] = await Promise.all([get('/api/providers'), get('/api/combos'), get('/api/settings')]);
      const connections = providers?.connections;
      const comboList = Array.isArray(combos) ? combos : combos?.combos;
      if (!Array.isArray(connections) || connections.length !== 1 || !Array.isArray(comboList) || comboList.length !== 0 || !settings) return { ok: false };
      const [connection] = connections;
      const providerSettingsOkay = connection.provider === 'groq' && connection.authType === 'apikey'
        && connection.isActive === true && connection.defaultModel === GROQ_FREE_MODEL
        && connection.apiKey === undefined && connection.accessToken === undefined && connection.refreshToken === undefined;
      const noGlobalFallback = typeof settings.globalFallbackModel !== 'string' || settings.globalFallbackModel.trim() === '';
      const fallbackSource = emergencyFallbackFile ? fs.readFileSync(emergencyFallbackFile, 'utf8') : '';
      const noEmergencyFallback = !emergencyFallbackFile || /enabled:\s*false/.test(fallbackSource);
      return { ok: providerSettingsOkay && noGlobalFallback && noEmergencyFallback, costKnownZero: providerSettingsOkay && noGlobalFallback && noEmergencyFallback };
    } catch { return { ok: false }; }
  };
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  const attestationFile = process.env.STATEX_GROQ_FREE_ATTESTATION;
  const emergencyFallbackFile = process.env.STATEX_OMNIROUTE_FALLBACK_SOURCE;
  const policyProbe = createOmniRoutePolicyProbe({
    adminPassword: process.env.STATEX_OMNIROUTE_ADMIN_PASSWORD,
    attestationFile,
    emergencyFallbackFile,
  });
  const port = Number(process.env.STATEX_GROQ_COMPAT_PORT ?? 4142);
  if (port !== 4142) throw new Error('compatibility port must remain 4142');
  const { server } = createGroqFreeCompatServer({ policyProbe });
  server.listen(port, '127.0.0.1', () => console.log('StateX Groq compatibility gateway listening on http://127.0.0.1:4142'));
}
