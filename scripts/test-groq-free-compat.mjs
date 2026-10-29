import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createGroqFreeCompatServer, GROQ_FREE_MODEL, GROQ_FREE_MAX_OUTPUT } from './groq-free-compat.mjs';

const baseBody = () => ({
  model: 'auto', stream: false, max_tokens: 512, tool_choice: 'auto', parallel_tool_calls: false,
  messages: [{ role: 'user', content: 'test' }],
  tools: ['Read', 'Write', 'Edit'].map(name => ({ type: 'function', function: { name, parameters: { type: 'object' } } })),
});
const textResponse = () => ({
  id: 'chatcmpl-mock', object: 'chat.completion', created: 1, model: GROQ_FREE_MODEL,
  choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'OK' } }],
  usage: { prompt_tokens: 10, completion_tokens: 2 },
});
const toolResponse = () => ({
  ...textResponse(),
  choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
    tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'Write', arguments: '{"file_path":"hello.txt","content":"ok"}' } }] } }],
});

async function withServer({ upstream, proof = { ok: true, costKnownZero: true }, maxRequests = 4 } = {}, fn) {
  const upstreamCalls = [];
  const proxy = createGroqFreeCompatServer({
    maxRequests, policyProbe: async () => proof,
    fetchImpl: async (url, init) => {
      upstreamCalls.push({ url: String(url), init, payload: JSON.parse(init.body) });
      return typeof upstream === 'function' ? upstream(upstreamCalls.at(-1)) : upstream;
    },
  });
  proxy.server.listen(0, '127.0.0.1');
  await once(proxy.server, 'listening');
  const addr = proxy.server.address();
  try { return await fn(`http://127.0.0.1:${addr.port}`, proxy, upstreamCalls); }
  finally { await new Promise(resolve => proxy.server.close(resolve)); }
}
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
async function post(base, body = baseBody()) {
  return fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

await withServer({ upstream: reply(textResponse()) }, async base => {
  const health = await (await fetch(`${base}/health`)).json();
  assert.equal(health.policy, 'free-only');
  const res = await post(base);
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.model, GROQ_FREE_MODEL);
  assert.equal(json.usage.cost, 0); // derived from fresh free-tier proof; not asserted as Groq-reported cost
  console.log('PASS: health and normal OpenAI-compatible response');
});

await withServer({ upstream: reply(toolResponse()) }, async (base, _proxy, calls) => {
  const res = await post(base);
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.choices[0].finish_reason, 'tool_calls');
  assert.equal(json.choices[0].message.tool_calls[0].id, 'call_1');
  assert.equal(json.choices[0].message.tool_calls[0].function.arguments, '{"file_path":"hello.txt","content":"ok"}');
  assert.equal(calls[0].payload.model, 'groq/openai/gpt-oss-20b');
  assert.equal(calls[0].payload.max_tokens, GROQ_FREE_MAX_OUTPUT);
  console.log('PASS: pinned Groq tool-call request and response preservation');
});

await withServer({ upstream: reply(textResponse()) }, async base => {
  for (const bad of [
    { ...baseBody(), model: 'openai/gpt-oss-20b' },
    { ...baseBody(), max_tokens: 513 },
    { ...baseBody(), stream: true },
    { ...baseBody(), provider: 'openrouter' },
    { ...baseBody(), tools: baseBody().tools.slice(0, 2) },
  ]) assert.equal((await post(base, bad)).status, 400);
  console.log('PASS: client cannot override provider/model/routing/output limits');
});

for (const status of [402, 403, 429, 500, 503]) {
  await withServer({ upstream: new Response('sensitive upstream body', { status }) }, async (base, _proxy, calls) => {
    const res = await post(base);
    const payload = await res.json();
    assert.equal(res.status, status);
    assert.equal(calls.length, 1, 'proxy must not retry or route elsewhere');
    assert.equal(JSON.stringify(payload).includes('sensitive'), false);
  });
}
console.log('PASS: provider errors are sanitized and make exactly one upstream attempt');

await withServer({ upstream: reply({ ...textResponse(), model: 'openai/gpt-oss-120b' }) }, async base => {
  assert.equal((await (await post(base)).json()).error.code, 'model_not_allowed');
});
await withServer({ upstream: reply({ ...textResponse(), usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.0001 } }) }, async base => {
  assert.equal((await (await post(base)).json()).error.code, 'nonzero_or_unknown_cost');
});
await withServer({ upstream: reply(textResponse()), proof: { ok: false, costKnownZero: false } }, async base => {
  assert.equal((await post(base)).status, 503);
});
await withServer({ upstream: reply({ ...textResponse(), choices: [{ ...textResponse().choices[0], finish_reason: 'length' }] }) }, async base => {
  assert.equal((await (await post(base)).json()).choices[0].finish_reason, 'length');
});
console.log('PASS: blocked response model, positive/unknown cost policy, unverified health and truncated response');

await withServer({ upstream: reply(textResponse()), maxRequests: 4 }, async (base, proxy, calls) => {
  for (let i = 0; i < 4; i++) assert.equal((await post(base)).status, 200);
  assert.equal((await post(base)).status, 429);
  assert.equal(proxy.requestsUsed, 4);
  assert.equal(calls.length, 4);
  console.log('PASS: hard cap of four requests and no fifth upstream request');
});

await withServer({ upstream: reply(textResponse()) }, async base => {
  const body = baseBody();
  const secret = 'GROQ_KEY_MOCK_SHOULD_NOT_APPEAR';
  body.messages[0].content = secret;
  const original = console.log;
  let log = '';
  console.log = (...args) => { log += args.join(' '); };
  try { await post(base, body); } finally { console.log = original; }
  assert.equal(log.includes(secret), false);
  console.log('PASS: request content and credential marker are not logged');
});

console.log('All Groq compatibility tests passed offline; provider calls: 0');
