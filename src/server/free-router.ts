/** In-process, fail-closed router for explicitly verified free API connections. */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export type FreeProvider = "groq" | "openrouter";
export type FreeRouterTrace = { executionId: string; requestId: string; iteration: number; agentId?: string; taskId?: number | null };
export class FreeRouterError extends Error {
  constructor(readonly code: string) { super(`free-router: ${code}`); this.name = "FreeRouterError"; }
}

const GROQ_MODEL = "openai/gpt-oss-20b";
const OPENROUTER_MODEL = "cohere/north-mini-code:free";
const DEFAULT_STATE = path.join(os.homedir(), ".pixel-office", "free-router-state.json");
const DEFAULT_ATTESTATION = path.join(os.homedir(), ".pixel-office", "free-provider-attestations.json");
const MAX_STATE_BYTES = 32 * 1024;
const SAFE_LOG = (event: string, data: Record<string, unknown>) => console.info(`[free-router] ${event} ${JSON.stringify(data)}`);
type Bucket = { until: number; reason: string };
type State = { version: 1; providers: Partial<Record<FreeProvider, Bucket>>; models: Record<string, Bucket> };
type RouterOptions = { fetch?: typeof fetch; now?: () => number; stateFile?: string; attestationFile?: string; env?: NodeJS.ProcessEnv };

function emptyState(): State { return { version: 1, providers: {}, models: {} }; }
function readState(file: string): State {
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink() || (st.mode & 0o077) !== 0 || st.size > MAX_STATE_BYTES) throw new Error();
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (value?.version !== 1 || !value.providers || typeof value.providers !== "object" || !value.models || typeof value.models !== "object") throw new Error();
    return value as State;
  } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return emptyState(); throw new FreeRouterError("state_unavailable"); }
}
function saveState(file: string, state: State) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(temp, JSON.stringify(state), { mode: 0o600, flag: "wx" });
    fs.renameSync(temp, file);
    fs.chmodSync(file, 0o600);
  } catch { throw new FreeRouterError("state_unavailable"); }
}
function parseRetryAfter(value: string | null, now: number): number | undefined {
  if (!value) return;
  const secs = Number(value);
  const until = Number.isFinite(secs) && secs >= 0 ? now + secs * 1000 : Date.parse(value);
  return Number.isFinite(until) && until > now ? Math.min(until, now + 24 * 60 * 60 * 1000) : undefined;
}
function safeErrorCode(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return;
  const e = (body as any).error;
  const s = typeof e === "object" && e ? [e.code, e.type, e.message].filter(x => typeof x === "string").join(" ").toLowerCase() : "";
  if (/daily|per.?day|rpd|quota.*account|account.*limit/.test(s)) return "account_limit";
  if (/token|tpm|context.length/.test(s)) return "token_limit";
  if (/model/.test(s) && /limit|rate|unavailable/.test(s)) return "model_limit";
  if (/billing|payment|credit/.test(s)) return "billing_rejected";
  return;
}
function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

export class FreeModelRouter {
  private fetcher: typeof fetch;
  private now: () => number;
  private stateFile: string;
  private attestationFile: string;
  private env: NodeJS.ProcessEnv;
  constructor(options: RouterOptions = {}) {
    this.fetcher = options.fetch ?? fetch; this.now = options.now ?? Date.now;
    this.stateFile = options.stateFile ?? process.env.STATEX_FREE_ROUTER_STATE ?? DEFAULT_STATE;
    this.attestationFile = options.attestationFile ?? process.env.STATEX_FREE_ATTESTATION_FILE ?? DEFAULT_ATTESTATION;
    this.env = options.env ?? process.env;
  }
  private state() { return readState(this.stateFile); }
  private persist(s: State) { saveState(this.stateFile, s); }
  private attested(provider: FreeProvider, model: string) {
    const key = provider === "groq" ? this.env.GROQ_API_KEY : this.env.OPENROUTER_API_KEY;
    if (!key) return false;
    try {
      const st = fs.lstatSync(this.attestationFile);
      if (!st.isFile() || st.isSymbolicLink() || (st.mode & 0o077) !== 0 || st.size > 4096) return false;
      const root = JSON.parse(fs.readFileSync(this.attestationFile, "utf8"));
      const a = root?.accounts?.[provider];
      const age = this.now() - Date.parse(a.verifiedAt);
      return root.version === 1 && a.model === model && a.freeTierConfirmed === true && a.billingEnabled === false && a.autoRecharge === false && Number.isFinite(age) && age >= 0 && age <= 24 * 3600_000;
    } catch { return false; }
  }
  health() {
    const enabled: FreeProvider[] = [];
    if (this.attested("groq", GROQ_MODEL)) enabled.push("groq");
    if (this.attested("openrouter", OPENROUTER_MODEL)) enabled.push("openrouter");
    const state = this.state(), now = this.now();
    const limited: Record<string, number> = {};
    for (const [key, value] of Object.entries({ ...state.providers, ...state.models })) if (value && value.until > now) limited[key] = value.until;
    return { status: enabled.length ? "ok" : "unavailable", policy: "free-only", providers: enabled, limited };
  }
  async complete(input: unknown, signal?: AbortSignal, trace?: FreeRouterTrace): Promise<unknown> {
    const payload = validatePayload(input);
    const health = this.health();
    let state = this.state();
    const now = this.now();
    const candidates: Array<{ provider: FreeProvider; model: string }> = [];
    if (health.providers.includes("groq")) candidates.push({ provider: "groq", model: GROQ_MODEL });
    if (health.providers.includes("openrouter")) candidates.push({ provider: "openrouter", model: OPENROUTER_MODEL });
    let attempted = 0;
    for (const [candidateIndex, candidate] of candidates.entries()) {
      const key = `${candidate.provider}/${candidate.model}`;
      if ((state.providers[candidate.provider]?.until ?? 0) > this.now() || (state.models[key]?.until ?? 0) > this.now()) continue;
      attempted++;
      try {
        if (candidate.provider === "openrouter") await this.verifyOpenRouterModel(signal);
        SAFE_LOG("selected", { ...traceFields(trace), attempt: candidateIndex + 1, provider: candidate.provider, model: candidate.model });
        const result = await this.call(candidate, payload, signal);
        SAFE_LOG("response", { ...traceFields(trace), attempt: candidateIndex + 1, provider: candidate.provider, model: candidate.model, finish_reason: result.choices?.[0]?.finish_reason ?? null, prompt_tokens: result.usage?.prompt_tokens ?? null, completion_tokens: result.usage?.completion_tokens ?? null, cost: result.usage?.cost ?? null });
        return result;
      } catch (error) {
        if (signal?.aborted) throw new FreeRouterError("cancelled");
        const failure = error instanceof CandidateFailure ? error : new CandidateFailure("transport_error", 0, undefined);
        if (failure.code === "positive_cost" || failure.code === "invalid_response") throw new FreeRouterError(failure.code);
        const until = this.cooldown(candidate, failure);
        state = this.state();
        const bucket = { until, reason: failure.code };
        if (failure.scope === "model") state.models[key] = bucket; else state.providers[candidate.provider] = bucket;
        this.persist(state);
        SAFE_LOG("fallback", { ...traceFields(trace), attempt: candidateIndex + 1, provider: candidate.provider, model: candidate.model, reason: failure.code, status: failure.status, scope: failure.scope ?? "provider", retryAt: new Date(until).toISOString() });
      }
    }
    const code = attempted ? "free_providers_exhausted" : "free_providers_cooling_down_or_unverified";
    SAFE_LOG("exhausted", { ...traceFields(trace), attempted, reason: code });
    throw new FreeRouterError(code);
  }
  private cooldown(candidate: { provider: FreeProvider; model: string }, failure: CandidateFailure) {
    const now = this.now();
    if (failure.retryAt && failure.retryAt > now) return failure.retryAt;
    if (failure.status === 402 || failure.status === 403 || failure.status === 401 || failure.code === "billing_rejected") return now + 24 * 3600_000;
    if (failure.status === 429 && failure.scope === "account") return now + 24 * 3600_000;
    if (failure.status === 429 && failure.scope === "day") return now + 24 * 3600_000;
    if (failure.status === 429 && failure.scope === "minute") return now + 60_000;
    if (failure.status === 429 && failure.scope === "model") return now + 60_000;
    if (failure.status >= 500 || failure.status === 0) return now + 30_000;
    return now + 60_000;
  }
  private async verifyOpenRouterModel(signal?: AbortSignal) {
    const key = this.env.OPENROUTER_API_KEY;
    if (!key) throw new CandidateFailure("credential_unavailable", 0);
    let response: Response;
    try { response = await this.fetcher("https://openrouter.ai/api/v1/models", { headers: { Authorization: `Bearer ${key}` }, signal, redirect: "error" }); }
    catch { throw new CandidateFailure("catalog_unavailable", 0); }
    if (!response.ok) throw new CandidateFailure("catalog_unavailable", response.status);
    let body: any; try { body = await response.json(); } catch { throw new CandidateFailure("catalog_invalid", response.status); }
    const row = Array.isArray(body?.data) ? body.data.find((x: any) => x?.id === OPENROUTER_MODEL) : undefined;
    if (!row || !isZero(row.pricing?.prompt) || !isZero(row.pricing?.completion) || !Array.isArray(row.supported_parameters) || !row.supported_parameters.includes("tools")) throw new CandidateFailure("model_not_verified_free", 0);
  }
  private async call(candidate: { provider: FreeProvider; model: string }, payload: ValidPayload, signal?: AbortSignal): Promise<any> {
    const groq = candidate.provider === "groq";
    const key = groq ? this.env.GROQ_API_KEY : this.env.OPENROUTER_API_KEY;
    if (!key) throw new CandidateFailure("credential_unavailable", 0);
    const base = groq ? "https://api.groq.com/openai/v1" : "https://openrouter.ai/api/v1";
    const body = { ...payload, model: candidate.model, ...(groq ? {} : { provider: { allow_fallbacks: false, require_parameters: true, max_price: { prompt: 0, completion: 0 } } }) };
    let response: Response;
    try { response = await this.fetcher(`${base}/chat/completions`, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(body), signal, redirect: "error" }); }
    catch { throw new CandidateFailure("transport_error", 0); }
    if (!response.ok) {
      let errorBody: unknown; try { errorBody = await response.clone().json(); } catch { /* malformed body */ }
      const scope = classifyLimit(response, errorBody);
      throw new CandidateFailure(safeErrorCode(errorBody) ?? `http_${response.status}`, response.status, parseRetryAfter(response.headers.get("retry-after"), this.now()), scope);
    }
    let result: any; try { result = await response.json(); } catch { throw new CandidateFailure("invalid_response", response.status); }
    if (!validResponse(result, candidate.model)) throw new CandidateFailure("invalid_response", response.status);
    if (result.usage && result.usage.cost !== undefined && !isZero(result.usage.cost)) throw new CandidateFailure("positive_cost", response.status);
    return result;
  }
}
function traceFields(trace?: FreeRouterTrace) {
  if (!trace) return {};
  const safeId = (value: string) => /^[a-zA-Z0-9._:-]{1,100}$/.test(value) ? value : "invalid";
  return {
    executionId: safeId(trace.executionId), requestId: safeId(trace.requestId), iteration: trace.iteration,
    ...(trace.agentId ? { agentId: safeId(trace.agentId) } : {}), ...(trace.taskId !== undefined ? { taskId: trace.taskId } : {}),
  };
}
class CandidateFailure extends Error {
  constructor(readonly code: string, readonly status: number, readonly retryAt?: number, readonly scope?: "account" | "day" | "minute" | "model" | "provider") { super(code); }
}
function isZero(n: unknown) { return (typeof n === "number" && Number.isFinite(n) && n === 0) || (typeof n === "string" && /^0(?:\.0+)?$/.test(n)); }
function classifyLimit(r: Response, body: unknown): CandidateFailure["scope"] {
  const text = `${r.headers.get("x-ratelimit-limit-requests") ?? ""} ${r.headers.get("x-ratelimit-remaining-requests") ?? ""} ${r.headers.get("x-ratelimit-limit-tokens") ?? ""} ${r.headers.get("x-ratelimit-remaining-tokens") ?? ""} ${JSON.stringify(body ?? "")}`.toLowerCase();
  const code = safeErrorCode(body);
  if (/daily|per.?day|rpd|requests per day/.test(text)) return "day";
  if (/account|organization|org.?limit/.test(text) || code === "account_limit") return "account";
  if (/per.?minute|minute|rpm|tpm|tokens|token limit/.test(text) || code === "token_limit") return "minute";
  if (/model/.test(text) || code === "model_limit") return "model";
  if (r.status === 429) return "provider";
  return "provider";
}
type ValidPayload = { messages: unknown[]; tools?: unknown[]; tool_choice?: unknown; parallel_tool_calls?: boolean; max_tokens: number; stream: false };
function validatePayload(input: unknown): ValidPayload {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new FreeRouterError("invalid_request");
  const o = input as Record<string, unknown>;
  const allowed = new Set(["model", "messages", "tools", "tool_choice", "parallel_tool_calls", "max_tokens", "stream"]);
  if (Object.keys(o).some(k => !allowed.has(k)) || o.model !== "auto" || !Array.isArray(o.messages) || o.messages.length > 128 || (o.tools !== undefined && !Array.isArray(o.tools)) || (o.tool_choice !== undefined && o.tool_choice !== "auto") || o.parallel_tool_calls !== false || !Number.isInteger(o.max_tokens) || Number(o.max_tokens) < 1 || Number(o.max_tokens) > 2048 || o.stream !== false) throw new FreeRouterError("invalid_request");
  return { messages: o.messages, ...(o.tools ? { tools: o.tools } : {}), tool_choice: "auto", parallel_tool_calls: false, max_tokens: Number(o.max_tokens), stream: false };
}
function validResponse(r: any, model: string): boolean {
  if (!r || r.model !== model || !Array.isArray(r.choices) || r.choices.length !== 1 || !r.usage || !Number.isSafeInteger(r.usage.prompt_tokens) || r.usage.prompt_tokens < 0 || !Number.isSafeInteger(r.usage.completion_tokens) || r.usage.completion_tokens < 0 || !["stop", "tool_calls", "length"].includes(r.choices[0]?.finish_reason)) return false;
  const m = r.choices[0]?.message;
  return !!m && m.role === "assistant" && (m.content === null || typeof m.content === "string" || m.content === undefined) && (!m.tool_calls || (Array.isArray(m.tool_calls) && m.tool_calls.every((t: any) => typeof t?.id === "string" && t.type === "function" && typeof t.function?.name === "string" && typeof t.function?.arguments === "string")));
}

let singleton: FreeModelRouter | undefined;
export function freeModelRouter() { return singleton ??= new FreeModelRouter(); }
export function resetFreeModelRouterForTests() { singleton = undefined; }
