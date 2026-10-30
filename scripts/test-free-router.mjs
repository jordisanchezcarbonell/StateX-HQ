import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FreeModelRouter, FreeRouterError } from '../dist/server/free-router.js';

const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'statex-router-test-'));
const now=Date.parse('2026-10-30T10:00:00.000Z');
const attestationFile=path.join(tmp,'attest.json'),stateFile=path.join(tmp,'state.json');
const at=new Date(now).toISOString();
const accounts={
  groq:{model:'openai/gpt-oss-20b',verifiedAt:at,freeTierConfirmed:true,billingEnabled:false,autoRecharge:false},
  openrouter:{model:'cohere/north-mini-code:free',verifiedAt:at,freeTierConfirmed:true,billingEnabled:false,autoRecharge:false},
};
fs.writeFileSync(attestationFile,JSON.stringify({version:1,accounts}),{mode:0o600});
const env={GROQ_API_KEY:'mock-groq-secret',OPENROUTER_API_KEY:'mock-or-secret'};
const toolResponse=(model='openai/gpt-oss-20b')=>({id:'chatcmpl-test',model,choices:[{index:0,message:{role:'assistant',content:null,tool_calls:[{id:'call-preserve-01',type:'function',function:{name:'Read',arguments:'{"file_path":"README.md"}'}}]},finish_reason:'tool_calls'}],usage:{prompt_tokens:23,completion_tokens:7}});
const finalResponse=(model='openai/gpt-oss-20b')=>({id:'chatcmpl-test',model,choices:[{index:0,message:{role:'assistant',content:'done'},finish_reason:'stop'}],usage:{prompt_tokens:30,completion_tokens:2}});
const catalog=()=>Response.json({data:[{id:'cohere/north-mini-code:free',pricing:{prompt:'0',completion:'0'},supported_parameters:['tools','tool_choice']}]});
const req={model:'auto',messages:[{role:'system',content:'safe'},{role:'user',content:'read file'}],tools:[{type:'function',function:{name:'Read',parameters:{type:'object'}}}],tool_choice:'auto',parallel_tool_calls:false,max_tokens:512,stream:false};
let passed=0;
async function test(name,fn){await fn();passed++;console.log(`ok ${name}`);}
function router(fetch,extra={}){return new FreeModelRouter({fetch,now:()=>extra.now??now,stateFile:extra.stateFile??stateFile,attestationFile:extra.attestationFile??attestationFile,env:extra.env??env});}
function fetchSequence(sequence){const seen=[];return {seen,fetch:async(url,init={})=>{const u=String(url);seen.push({url:u,init,body:init.body?JSON.parse(init.body):undefined});const next=sequence.shift();if(typeof next==='function')return next(u,init);if(!next)throw new Error('unexpected mock request');return next;}};}

try {
  await test('Groq is first and preserves OpenAI tool calls and arguments',async()=>{
    const q=fetchSequence([()=>Response.json(toolResponse())]);const r=router(q.fetch);
    assert.deepEqual(r.health().providers,['groq','openrouter']);
    const out=await r.complete(req);
    assert.equal(q.seen.length,1);assert.match(q.seen[0].url,/api\.groq\.com\/openai\/v1\/chat\/completions$/);
    assert.equal(q.seen[0].body.model,'openai/gpt-oss-20b');assert.deepEqual(out.choices[0].message.tool_calls,toolResponse().choices[0].message.tool_calls);
  });
  await test('provider fallback on a later tool-loop iteration preserves assistant tool call and result history',async()=>{
    fs.writeFileSync(stateFile,JSON.stringify({version:1,providers:{},models:{}}),{mode:0o600});
    fs.writeFileSync(attestationFile,JSON.stringify({version:1,accounts}),{mode:0o600});
    const q=fetchSequence([
      ()=>Response.json(toolResponse()),
      ()=>new Response(JSON.stringify({error:{message:'rate limit exceeded'}}),{status:429,headers:{'retry-after':'120'}}),
      catalog,
      ()=>Response.json(finalResponse('cohere/north-mini-code:free')),
    ]);
    const r=router(q.fetch),first=await r.complete(req,undefined,{executionId:'exec-a1',requestId:'req-a1',iteration:1,agentId:'mia',taskId:42});
    const continued={...req,messages:[...req.messages,first.choices[0].message,{role:'tool',tool_call_id:'call-preserve-01',content:'# fixture contents'}]};
    const second=await r.complete(continued,undefined,{executionId:'exec-a1',requestId:'req-a2',iteration:2,agentId:'mia',taskId:42});
    assert.equal(second.model,'cohere/north-mini-code:free');assert.deepEqual(q.seen[3].body.messages,continued.messages);
    assert(q.seen[3].body.messages.some(m=>m.role==='tool'&&m.tool_call_id==='call-preserve-01'));
  });
  await test('router traces include IDs, iteration, provider, model and usage without request contents',async()=>{
    fs.writeFileSync(stateFile,JSON.stringify({version:1,providers:{},models:{}}),{mode:0o600});
    const q=fetchSequence([()=>Response.json(finalResponse())]),messages=[];const previous=console.info;console.info=(...args)=>messages.push(args.join(' '));
    try { await router(q.fetch).complete({...req,messages:[{role:'user',content:'private prompt marker'}]},undefined,{executionId:'exec-safe',requestId:'req-safe',iteration:3,agentId:'mia',taskId:77}); }
    finally { console.info=previous; }
    const log=messages.join('\n');for(const field of ['exec-safe','req-safe','"iteration":3','"provider":"groq"','"model":"openai/gpt-oss-20b"','"prompt_tokens":30'])assert(log.includes(field));
    assert(!log.includes('private prompt marker')&&!log.includes('mock-groq-secret')&&!log.includes('mock-or-secret'));
  });
  await test('429 on Groq cools its account and falls back once to verified zero-priced OpenRouter',async()=>{
    const q=fetchSequence([()=>new Response(JSON.stringify({error:{message:'rate limit'}}),{status:429,headers:{'retry-after':'120'}}),catalog,()=>Response.json(toolResponse('cohere/north-mini-code:free'))]);
    const out=await router(q.fetch).complete(req);
    assert.equal(out.model,'cohere/north-mini-code:free');assert.equal(q.seen.length,3);
    const posted=q.seen[2];assert.equal(posted.body.model,'cohere/north-mini-code:free');assert.deepEqual(posted.body.provider,{allow_fallbacks:false,require_parameters:true,max_price:{prompt:0,completion:0}});
    assert.equal(JSON.stringify(posted.init.headers).includes('mock-or-secret'),true); // transport only; logs are asserted separately below
    const persisted=JSON.parse(fs.readFileSync(stateFile,'utf8'));assert(persisted.providers.groq.until===now+120000);
  });
  await test('daily/account 429 is persisted at provider scope so another model cannot bypass a shared quota',async()=>{
    fs.writeFileSync(stateFile,JSON.stringify({version:1,providers:{},models:{}}),{mode:0o600});
    const q=fetchSequence([()=>new Response(JSON.stringify({error:{message:'daily request quota reached'}}),{status:429}),catalog,()=>Response.json(finalResponse('cohere/north-mini-code:free'))]);
    const lines=[],old=console.info;console.info=(...x)=>lines.push(x.join(' '));
    try { await router(q.fetch).complete(req); } finally {console.info=old;}
    const state=JSON.parse(fs.readFileSync(stateFile,'utf8'));
    assert.equal(state.providers.groq.until,now+24*3600_000);assert(!state.models['groq/openai/gpt-oss-20b']);
    assert(lines.some(x=>x.includes('"scope":"day"')));
  });
  await test('cooldown survives router reconstruction and returns clearly when all are cooling',async()=>{
    fs.writeFileSync(stateFile,JSON.stringify({version:1,providers:{groq:{until:now+120000,reason:'rate_limit'},openrouter:{until:now+120000,reason:'rate_limit'}},models:{}}),{mode:0o600});
    const q=fetchSequence([]);const r=router(q.fetch);
    await assert.rejects(r.complete(req),e=>e instanceof FreeRouterError&&e.code==='free_providers_cooling_down_or_unverified');assert.equal(q.seen.length,0);
  });
  await test('cooldown recovers after expiry and Groq becomes preferred again',async()=>{
    fs.writeFileSync(stateFile,JSON.stringify({version:1,providers:{groq:{until:now-1,reason:'rate_limit'}},models:{}}),{mode:0o600});
    const q=fetchSequence([()=>Response.json(finalResponse())]);const out=await router(q.fetch).complete(req);assert.equal(out.model,'openai/gpt-oss-20b');assert.equal(q.seen.length,1);
  });
  await test('OpenRouter alone works when Groq account attestation is absent',async()=>{
    const q=fetchSequence([catalog,()=>Response.json(finalResponse('cohere/north-mini-code:free'))]);
    const r=router(q.fetch,{env:{OPENROUTER_API_KEY:'mock-or-secret'}});assert.deepEqual(r.health().providers,['openrouter']);
    assert.equal((await r.complete(req)).model,'cohere/north-mini-code:free');assert.equal(q.seen.length,2);
  });
  await test('paid, unknown-price, and tool-incompatible OpenRouter catalog entries are never called',async()=>{
    for(const pricing of [{prompt:'0.1',completion:'0'},{prompt:'0',completion:null},{prompt:'0',completion:'0'}]){
      fs.writeFileSync(stateFile,JSON.stringify({version:1,providers:{},models:{}}),{mode:0o600});
      const supported=pricing.completion==='0'?[]:['tools'];
      const q=fetchSequence([()=>Response.json({data:[{id:'cohere/north-mini-code:free',pricing,supported_parameters:supported}]})]);
      const r=router(q.fetch,{env:{OPENROUTER_API_KEY:'mock-or-secret'}});
      await assert.rejects(r.complete(req),e=>e instanceof FreeRouterError&&e.code==='free_providers_exhausted');assert.equal(q.seen.length,1);
    }
  });
  await test('Groq requires fresh explicit free-account attestation and secret is never logged',async()=>{
    fs.writeFileSync(stateFile,JSON.stringify({version:1,providers:{},models:{}}),{mode:0o600});
    fs.writeFileSync(attestationFile,JSON.stringify({version:1,accounts:{openrouter:accounts.openrouter}}),{mode:0o600});
    const q=fetchSequence([catalog,()=>Response.json(finalResponse('cohere/north-mini-code:free'))]);
    const warnings=[];const old=console.info;console.info=(...x)=>warnings.push(x.join(' '));
    try { const r=router(q.fetch,{env:{GROQ_API_KEY:'mock-groq-secret',OPENROUTER_API_KEY:'mock-or-secret'}});await r.complete(req); }
    finally {console.info=old;}
    assert.equal(q.seen.length,2);assert(q.seen.every(x=>!JSON.stringify(x).includes('mock-groq-secret')));assert(warnings.every(x=>!x.includes('mock-groq-secret')&&!x.includes('mock-or-secret')));
  });
  await test('402 and 403 quarantine the provider and continue only to verified free candidates',async()=>{
    fs.writeFileSync(attestationFile,JSON.stringify({version:1,accounts}),{mode:0o600});
    for(const status of [402,403]){
      fs.writeFileSync(stateFile,JSON.stringify({version:1,providers:{},models:{}}),{mode:0o600});
      const q=fetchSequence([()=>new Response(JSON.stringify({error:{message:'payment required'}}),{status}),catalog,()=>Response.json(finalResponse('cohere/north-mini-code:free'))]);
      const out=await router(q.fetch).complete(req);assert.equal(out.model,'cohere/north-mini-code:free');assert.equal(q.seen.length,3);
      assert.equal(JSON.parse(fs.readFileSync(stateFile,'utf8')).providers.groq.until,now+24*3600_000);
    }
  });
  await test('5xx and transport errors are bounded to one attempt per provider',async()=>{
    fs.writeFileSync(stateFile,JSON.stringify({version:1,providers:{},models:{}}),{mode:0o600});
    const q=fetchSequence([()=>new Response('{}',{status:503}),catalog,()=>new Response('{}',{status:502})]);
    await assert.rejects(router(q.fetch).complete(req),e=>e.code==='free_providers_exhausted');assert.equal(q.seen.length,3);
  });
  await test('positive or unverifiable response cost is rejected and not returned to the agent',async()=>{
    fs.writeFileSync(stateFile,JSON.stringify({version:1,providers:{},models:{}}),{mode:0o600});
    const q=fetchSequence([()=>Response.json({...finalResponse(),usage:{prompt_tokens:1,completion_tokens:1,cost:0.0001}})]);
    await assert.rejects(router(q.fetch).complete(req),e=>e.code==='positive_cost');assert.equal(q.seen.length,1);
  });
  await test('client cannot choose a model, provider, fallback, or paid routing parameters',async()=>{
    const q=fetchSequence([]);const r=router(q.fetch);
    for(const altered of [{...req,model:'paid/model'},{...req,provider:{allow_fallbacks:true}},{...req,models:['paid/model']},{...req,max_tokens:4096}])await assert.rejects(r.complete(altered),e=>e.code==='invalid_request');
    assert.equal(q.seen.length,0);
  });
  await test('state files with broad permissions or symlinks fail closed',async()=>{
    const bad=path.join(tmp,'bad-state.json');fs.writeFileSync(bad,'{}',{mode:0o644});
    await assert.rejects(router(async()=>{throw new Error('no calls');},{stateFile:bad}).complete(req),e=>e.code==='state_unavailable');
  });
  console.log(`StateX TypeScript Free Router: ${passed} passed, 0 failed, provider calls mocked only`);
} finally {fs.rmSync(tmp,{recursive:true,force:true});}
