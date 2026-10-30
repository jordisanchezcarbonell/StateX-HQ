# StateX in-process Free Router

`npm run dev:free` now uses the TypeScript router in the StateX Node server by default. It does not inspect, start, or stop port 4141. The previous Python router remains available with `STATEX_FREE_ROUTER_BACKEND=python npm run dev:free` as a temporary rollback. `npm run stop:free` stops only PIDs recorded by the launcher.

## Free-only controls

- Groq is pinned to `openai/gpt-oss-20b` and enabled only with a recent local account attestation. It is called directly at Groq's OpenAI-compatible API.
- OpenRouter is pinned to `cohere/north-mini-code:free`. Before inference, the live model catalog must show exact zero input and output prices and support tools. Requests also set `provider.allow_fallbacks=false`, `require_parameters=true` and zero `max_price` limits.
- Both connections require a local attestation asserting that the account is on free access, billing is disabled and auto-recharge is disabled. Attestations expire after 24 hours. This is a fail-closed operator assertion; the providers do not expose a reliable API that proves account billing settings.
- Only the exact two model IDs above are in code. The client cannot select a provider/model or override fallback and price routing.
- Each candidate is attempted at most once per inference. 429, 402, 403, 5xx and transport failures add a persisted provider/model cooldown. The current task history remains in the existing runtime; router fallback happens before returning a completion, so no tool action is repeated. There is no same-provider or streaming retry.
- A task-wide execution budget defaults to 5 model iterations, 12 tool calls and 24,000 cumulative input+output tokens. Each `runFreeAgent` loop is limited to 120 seconds. A tool call on the last available iteration is refused before execution because the runtime could not safely send its result back to a model. Each inference is capped at 1,024 output tokens by default. Router fallback may make at most one additional provider attempt for that inference.
- Cooldown state is kept in `~/.pixel-office/free-router-state.json` with mode 0600. It contains provider/model, reason and expiry only, never credentials or prompts.
- Each logical inference and provider attempt is traced with execution ID, request ID, task ID (or null for chat), iteration, provider, model, token counts, provider finish reason and sanitized fallback/finalization reason. Logs exclude prompts, tool arguments, file contents and authorization data.
- Identical successful Write/Edit calls within one execution are deduplicated and reuse the prior tool result. Reads are not deduplicated because rereading after a mutation is how the runtime verifies the changed file.
- The system prompt and accumulated conversation/tool results are sent on every completion call because both configured APIs are stateless Chat Completions endpoints. Dropping those messages would break tool cycles and safety instructions; this MVP keeps them intact.

The limits may be tightened with `STATEX_FREE_MAX_ITERATIONS` (1–6), `STATEX_FREE_MAX_TOOLS` (1–12), `STATEX_FREE_MAX_TOTAL_TOKENS` (1,024–24,000), and `STATEX_FREE_MAX_OUTPUT_TOKENS` (512–2,048). `STATEX_FREE_MAX_REQUESTS` remains a legacy alias for iteration count. Invalid values use the conservative defaults (or hard maximum where the limit itself is already the default). The 5-iteration default covers Read → approved Write/Edit → Read → final response with one spare inference for recovery.

## Configure credentials and attestations

Do not put credentials in this repository. Store them in a local file outside it, for example `~/.config/statex-hq/free-providers.env`, with only the provider keys you intend to enable and file mode 0600. Create/edit it with a local editor; do not paste key values into chat, command arguments, or logs. Example structure (replace locally):

```sh
GROQ_API_KEY='...'
OPENROUTER_API_KEY='...'
```

From zsh, load it without echoing the file contents, then start the office:

```sh
umask 077
mkdir -p "$HOME/.config/statex-hq"
chmod 700 "$HOME/.config/statex-hq"
chmod 600 "$HOME/.config/statex-hq/free-providers.env"
set -a
source "$HOME/.config/statex-hq/free-providers.env"
set +a
npm run dev:free
```

The launcher passes the two supported key environment variables only to the office process; it never prints them or copies them into project files. Do not enable a provider until you have checked that account's current console/billing settings and that it is eligible for its free tier. If the account has billing or auto-recharge enabled, leave it out of the attestation and do not run with that connection.

Create `~/.pixel-office/free-provider-attestations.json` with mode 0600 only after checking the account. `verifiedAt` must be a current UTC ISO timestamp; refresh it after 24 hours. Include only providers you have checked. Example structure:

```json
{
  "version": 1,
  "accounts": {
    "groq": {
      "model": "openai/gpt-oss-20b",
      "verifiedAt": "REPLACE_WITH_CURRENT_UTC_ISO_TIMESTAMP",
      "freeTierConfirmed": true,
      "billingEnabled": false,
      "autoRecharge": false
    },
    "openrouter": {
      "model": "cohere/north-mini-code:free",
      "verifiedAt": "REPLACE_WITH_CURRENT_UTC_ISO_TIMESTAMP",
      "freeTierConfirmed": true,
      "billingEnabled": false,
      "autoRecharge": false
    }
  }
}
```

Set the file mode to 0600. The server checks the model/account flags, key presence, timestamp and file permissions. OpenRouter additionally rechecks live zero pricing and tool support before every inference. If any check is absent or stale, that connection is disabled. This local attestation is not an independent provider guarantee; if the account terms or billing state cannot be verified, do not add its entry.

## First controlled run

There are no provider calls during `npm run dev:free`. After reviewing the attestation and deciding to spend the providers' free quota, start the office, open `http://127.0.0.1:4748`, and ask Mia to read a file in the isolated StateX workspace, add a short line, and reread it. Approve the Write/Edit request in the UI. Watch the server activity for the selected provider/model, token counts, fallback reason and cooldown expiry. If all candidates are limited, the task ends with `free-agent: free_providers_exhausted` or `free_providers_cooling_down_or_unverified`; it does not continue retrying.

Stop the launcher-owned office with:

```sh
npm run stop:free
```

The existing Python gateway and its files/configuration are untouched. To roll back, stop the TypeScript office, then start it with `STATEX_FREE_ROUTER_BACKEND=python npm run dev:free`; that mode applies the previous launcher's 4141 ownership and health checks.
