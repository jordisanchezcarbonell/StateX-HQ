// Offline tests: globally intercepted fetch, then actual Python Gateway with MockTransport.
// Never import production index.ts, read credentials, or connect to a real provider.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import {createServer} from 'node:net';
import {WebSocket} from 'ws';
import { register } from 'node:module';
register('./fixtures/no-agent-sdk-loader.mjs',import.meta.url);
process.env.STATEX_FREE_ONLY='1';
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'statex-free-agent-'));
process.env.PIXEL_OFFICE_HOME=scratch;
const {WorkspaceTools,FreeAgentError}=await import('../dist/server/free-agent-tools.js');
const {runFreeAgent,FREE_LIMITS,gatewayBase}=await import('../dist/server/free-agent.js');
const {Employee,listConnectors}=await import('../dist/server/employee.js');
const {Store}=await import('../dist/server/store.js');
const {initRuntime}=await import('../dist/server/runtime.js');
const {Translator,loadLocale}=await import('../dist/server/i18n.js');
const {engineOf,initProviders,providerStatuses}=await import('../dist/server/providers.js');
initRuntime({offices:[],taskSessions:true},new Translator(loadLocale('en').data));
const originalFetch=globalThis.fetch;
const checks=[];
const wait=ms=>new Promise(r=>setTimeout(r,ms));
let fixture, officeChild, officeWorkspace, socket;
const ws=path.join(scratch,'workspace');fs.mkdirSync(ws);
const readme=path.join(ws,'README.md');fs.writeFileSync(readme,'# Fixture\n');
const abort=new AbortController();
const approved=[];
const allow=async(name,args)=>{approved.push([name,args]);return true;};
async function test(name,fn){await fn();checks.push(name);}
const options=(extra={})=>({cwd:ws,model:'free-agent:auto',prompt:'Small offline task',system:'Only the fixture',history:[],signal:abort.signal,approve:allow,onText(){},onTool(){},onUsage(){},...extra});
const tools=new WorkspaceTools(ws);
const exec=(name,args,approve=allow,signal=abort.signal)=>tools.execute(name,args,signal,approve);
const response=(message={role:'assistant',content:'done'},extra={})=>({model:'fixture/free',choices:[{message,finish_reason:message.tool_calls?'tool_calls':'stop'}],usage:{prompt_tokens:10,completion_tokens:5,cost:0},...extra});
const tool=(name,args,id='call-1')=>({role:'assistant',content:null,tool_calls:[{id,type:'function',function:{name,arguments:JSON.stringify(args)}}]});
let requests=[];
function mockFetch(replies=[],health={status:'ok',policy:'free-only'}){
  requests=[];globalThis.fetch=async(url,init={})=>{
    assert(String(url).startsWith(gatewayBase()+'/'),'no external traffic');
    if(String(url).endsWith('/health'))return Response.json(health);
    assert(String(url).endsWith('/v1/chat/completions'));requests.push(JSON.parse(init.body));
    const next=replies.shift();if(typeof next==='function')return next(init);
    if(next instanceof Response)return next;
    assert(next,'unexpected inference');return Response.json(next);
  };
}
try {
  await test('strict arguments; no Bash or arbitrary tools',async()=>{
    await assert.rejects(exec('Bash',{command:'x'}),/tool_forbidden/);
    await assert.rejects(exec('Read',{file_path:'README.md',extra:1}),/invalid_tool_arguments/);
    await assert.rejects(exec('Edit',{file_path:'README.md',old_string:''}),/invalid_tool_arguments/);
  });
  await test('real paths: traversal, absolute paths, reserved files, symlink ancestors and hardlinks denied',async()=>{
    const outside=path.join(scratch,'outside');fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,'private'),'untouched');
    fs.symlinkSync(outside,path.join(ws,'escape'));fs.symlinkSync(path.join(outside,'private'),path.join(ws,'link'));
    fs.linkSync(path.join(outside,'private'),path.join(ws,'hardlink'));
    for(const file_path of ['../outside/private',path.join(outside,'private'),'.env','.git/config','escape/private','link','hardlink'])await assert.rejects(exec('Read',{file_path}));
    assert.equal(fs.readFileSync(path.join(outside,'private'),'utf8'),'untouched');
  });
  await test('Read → approved Edit → Read, exact tool contents and verification',async()=>{
    assert.equal(await exec('Read',{file_path:'README.md'}),'# Fixture\n');
    await exec('Edit',{file_path:'README.md',old_string:'# Fixture',new_string:'# Fixture\nStateX HQ Agent Test OK'});
    assert.equal(approved.length,1);assert.match(await exec('Read',{file_path:'README.md'}),/StateX HQ Agent Test OK/);
  });
  await test('read before overwrite; ambiguous edit; denial; read-only; new Write approval',async()=>{
    await assert.rejects(new WorkspaceTools(ws).execute('Write',{file_path:'README.md',content:'x'},abort.signal,allow),/read_before_write/);
    await exec('Write',{file_path:'new.md',content:'abc abc'});await exec('Read',{file_path:'new.md'});
    await assert.rejects(exec('Edit',{file_path:'new.md',old_string:'abc',new_string:'def'}),/unique_match/);
    assert.match(await exec('Write',{file_path:'new.md',content:'denied'},async()=>false),/user_denied/);
    await assert.rejects(tools.execute('Write',{file_path:'new.md',content:'no'},abort.signal,allow,true),/read_only/);
    assert.equal(fs.readFileSync(path.join(ws,'new.md'),'utf8'),'abc abc');
  });
  await test('symlink swapped while awaiting approval cannot modify external file',async()=>{
    fs.writeFileSync(path.join(ws,'swap'),'initial');await exec('Read',{file_path:'swap'});
    await assert.rejects(exec('Edit',{file_path:'swap',old_string:'initial',new_string:'changed'},async()=>{
      fs.unlinkSync(path.join(ws,'swap'));fs.symlinkSync(path.join(scratch,'outside','private'),path.join(ws,'swap'));return true;
    }),/path_forbidden/);
    assert.equal(fs.readFileSync(path.join(scratch,'outside','private'),'utf8'),'untouched');
  });
  await test('changed bytes and symlink parent after approval fail closed',async()=>{
    fs.writeFileSync(path.join(ws,'changed'),'before');await exec('Read',{file_path:'changed'});
    await assert.rejects(exec('Write',{file_path:'changed',content:'after'},async()=>{fs.writeFileSync(path.join(ws,'changed'),'other');return true;}),/changed_since_approval/);
    fs.mkdirSync(path.join(ws,'dir'));await assert.rejects(exec('Write',{file_path:'dir/new',content:'no'},async()=>{
      fs.renameSync(path.join(ws,'dir'),path.join(ws,'old-dir'));fs.symlinkSync(path.join(scratch,'outside'),path.join(ws,'dir'));return true;
    }),/path_forbidden/);assert(!fs.existsSync(path.join(scratch,'outside','new')));
  });
  await test('binary, oversized and special files refused',async()=>{
    fs.writeFileSync(path.join(ws,'binary'),Buffer.from([0,255]));fs.writeFileSync(path.join(ws,'big'),'x'.repeat(65537));
    for(const file_path of ['binary','big','old-dir'])await assert.rejects(exec('Read',{file_path}));
  });
  await test('gateway restricted to loopback, no credential-bearing URL or alternate endpoint',async()=>{
    for(const url of ['https://openrouter.ai','http://localhost:4141','http://user:secret@127.0.0.1:4141','http://127.0.0.1:4141/v1','http://127.0.0.1:4141?key=secret']){
      process.env.STATEX_FREE_ROUTER_URL=url;assert.throws(gatewayBase,/invalid_gateway_url/);
    }delete process.env.STATEX_FREE_ROUTER_URL;
  });
  await test('client cannot force a model; gateway policy required',async()=>{
    mockFetch([]);await assert.rejects(runFreeAgent(options({model:'free-agent:paid/model'})),/model_forbidden/);assert.equal(requests.length,0);
    mockFetch([],{status:'ok',policy:'anything'});await assert.rejects(runFreeAgent(options()),/free_policy_required/);assert.equal(requests.length,0);
  });
  await test('reported nonzero, negative or unknown costs fail before tools; missing cost stays unreported',async()=>{
    for(const cost of [0.01,-1,'unknown',null]){
      mockFetch([response(tool('Write',{file_path:'paid.md',content:'bad'}),{usage:{prompt_tokens:10,completion_tokens:5,cost}})]);
      await assert.rejects(runFreeAgent(options()),/invalid_or_nonfree_response/);assert(!fs.existsSync(path.join(ws,'paid.md')));
    }
    let usage;mockFetch([response(undefined,{usage:{prompt_tokens:10,completion_tokens:5}})]);
    await runFreeAgent(options({onUsage:u=>usage=u}));assert.equal(usage.cost,undefined);
  });
  await test('HTTP gateway errors expose only validated error codes; no retries or body leaks',async()=>{
    for(const [status,code] of [[402,'billing_blocked'],[403,'provider_forbidden'],[429,'rate_limited'],[500,'internal_error'],[503,'free_models_exhausted']]){
      mockFetch([Response.json({error:{code,message:'secret-key-and-private-prompt'}},{status})]);
      await assert.rejects(runFreeAgent(options()),e=>e.message===`free-agent: gateway_http_${status}:${code}`);assert.equal(requests.length,1);
    }
    for(const body of ['{malformed',JSON.stringify({error:{code:'Bearer secret-key'}}),JSON.stringify({error:{code:402}}),JSON.stringify({message:'private prompt'})]){
      mockFetch([new Response(body,{status:503})]);
      await assert.rejects(runFreeAgent(options()),e=>e.message==='free-agent: gateway_http_503');assert.equal(requests.length,1);
    }
    mockFetch([new Response('x'.repeat(9*1024),{status:503})]);
    await assert.rejects(runFreeAgent(options()),e=>e.message==='free-agent: gateway_http_503');assert.equal(requests.length,1);
  });
  await test('stop and tool_calls succeed; harmless OpenAI extensions are tolerated',async()=>{
    mockFetch([response({role:'assistant',content:'done',vendor_metadata:{reasoning_format:'none'}})]);
    assert.equal((await runFreeAgent(options()))[1].content,'done');
    mockFetch([response(tool('Read',{file_path:'README.md'})),response()]);
    assert.equal((await runFreeAgent(options()))[2].role,'tool');
    const extended=tool('Read',{file_path:'README.md'});extended.tool_calls[0].index=0;extended.tool_calls[0].function.provider_metadata={source:'fixture'};
    mockFetch([response(extended),response()]);await runFreeAgent(options());
    const forwarded=requests[1].messages.find(m=>m.role==='assistant').tool_calls[0];
    assert.equal(forwarded.id,'call-1');assert.equal(forwarded.function.arguments,JSON.stringify({file_path:'README.md'}));
    assert.equal('index' in forwarded,false);assert.equal('provider_metadata' in forwarded.function,false);
  });
  await test('tool calls/results preserve IDs; next conversation retains history; no routing override or auth',async()=>{
    let history;mockFetch([response(tool('Read',{file_path:'README.md'},'read-exact-id')),response()]);
    history=await runFreeAgent(options());assert.equal(history[2].tool_call_id,'read-exact-id');assert.equal(history[2].content,fs.readFileSync(readme,'utf8'));
    const previous=JSON.stringify(history);mockFetch([response()]);await runFreeAgent(options({history,prompt:'continue'}));assert.equal(JSON.stringify(history),previous);
    assert.deepEqual(requests[0].messages.slice(1,-1),history);assert.equal(requests[0].max_tokens,1024);assert.equal(requests[0].model,'auto');
    assert(!('provider' in requests[0]));assert.deepEqual(requests[0].tools.map(t=>t.function.name),['Read','Write','Edit']);
  });
  await test('configured request cap can tighten the run to four inferences',async()=>{
    const previous=process.env.STATEX_FREE_MAX_REQUESTS;process.env.STATEX_FREE_MAX_REQUESTS='4';
    try {
      mockFetch(Array.from({length:5},(_,i)=>response(tool('Read',{file_path:'README.md'},`cap-${i}`))));
      await assert.rejects(runFreeAgent(options()),/request_limit_before_tools/);assert.equal(requests.length,4);
    } finally { if(previous===undefined)delete process.env.STATEX_FREE_MAX_REQUESTS;else process.env.STATEX_FREE_MAX_REQUESTS=previous; }
  });
  await test('length is incomplete and executes no tools; malformed response/tool JSON fails closed',async()=>{
    mockFetch(Array.from({length:6},(_,i)=>response(tool('Read',{file_path:'README.md'},`r${i}`))));
    await assert.rejects(runFreeAgent(options()),/request_limit_before_tools/);assert.equal(requests.length,FREE_LIMITS.requests);
    let used=[];mockFetch([response(tool('Write',{file_path:'length.md',content:'must not run'}),{choices:[{message:tool('Write',{file_path:'length.md',content:'must not run'}),finish_reason:'length'}],usage:{prompt_tokens:758,completion_tokens:512,cost:0}})]);
    await assert.rejects(runFreeAgent(options({onTool:n=>used.push(n)})),/incomplete_response/);assert.deepEqual(used,[]);assert(!fs.existsSync(path.join(ws,'length.md')));
    mockFetch([response({role:'assistant',content:'truncated'}, {model:'recursive/flint-v1.0:free',usage:{prompt_tokens:758,completion_tokens:512,cost:0,provider:'openrouter'},choices:[{message:{role:'assistant',content:'truncated',reasoning_details:[]},finish_reason:'length'}]})]);
    await assert.rejects(runFreeAgent(options()),/incomplete_response/);
    const invalid=tool('Read',{});invalid.tool_calls[0].function.arguments='{';mockFetch([response(invalid)]);await assert.rejects(runFreeAgent(options()),/invalid_tool_json/);
    mockFetch([response(undefined,{choices:[{message:{role:'assistant',content:9},finish_reason:'stop'}]})]);
    const warnings=[];const originalWarn=console.warn;console.warn=(...args)=>warnings.push(args.join(' '));
    try { await assert.rejects(runFreeAgent(options()),/invalid_or_nonfree_response/); }
    finally { console.warn=originalWarn; }
    const diagnostic=warnings.find(line=>line.includes('[free-agent] invalid gateway response'));
    assert(diagnostic,'Zod validation failure must be logged before throwing');
    const details=JSON.parse(diagnostic.slice(diagnostic.indexOf('{')));
    assert(details.issues.some(i=>i.path.join('.')==='choices.0.message.content'&&i.code==='invalid_type'));
    assert.equal(details.finish_reason,'stop');assert.equal(details.prompt_tokens,10);assert.equal(details.completion_tokens,5);
  });
  await test('cancellation aborts in-flight HTTP and pending approval, without writing',async()=>{
    const c=new AbortController();mockFetch([init=>new Promise((_,reject)=>init.signal.addEventListener('abort',()=>reject(new Error('private secret'))))]);
    const pending=runFreeAgent(options({signal:c.signal}));await wait(10);c.abort();await assert.rejects(pending,/cancelled_or_timed_out/);
    const d=new AbortController();mockFetch([response(tool('Write',{file_path:'cancel.md',content:'no'}))]);
    const approval=runFreeAgent(options({signal:d.signal,approve:async()=>{d.abort();return true;}}));await assert.rejects(approval,/cancelled_or_timed_out/);assert(!fs.existsSync(path.join(ws,'cancel.md')));
  });
  await test('employee Stop cancels a pending write approval and leaves no file',async()=>{
    mockFetch([response(tool('Write',{file_path:'cancel-employee.md',content:'never'}))]);
    const employee=new Employee({id:'cancel',officeId:'main',name:'Cancel',role:'dev',color:'#fff',look:{},systemPrompt:'-',cwd:ws,model:'free-agent:auto'},new Store(path.join(scratch,'cancel-store')));
    employee.send('write');for(let i=0;i<100&&!employee.pendingAsks.length;i++)await wait(10);
    assert.equal(employee.pendingAsks.length,1);await employee.interrupt({resume:false});
    assert.equal(employee.pendingAsks.length,0);assert.equal(employee.status,'idle');assert(!fs.existsSync(path.join(ws,'cancel-employee.md')));await employee.dispose();
    const c=new AbortController();const pending=exec('Write',{file_path:'cancel-never.md',content:'never'},()=>new Promise(()=>{}),c.signal);
    c.abort();await assert.rejects(pending,/cancelled/);
  });
  await test('history and observed token budgets stop execution before more requests',async()=>{
    mockFetch([]);await assert.rejects(runFreeAgent(options({prompt:'x'.repeat(262145)})),/history_limit/);assert.equal(requests.length,0);
    mockFetch([response(undefined,{usage:{prompt_tokens:24001,completion_tokens:1,cost:0}})]);await assert.rejects(runFreeAgent(options()),/token_limit/);assert.equal(requests.length,1);
  });
  await test('free-only auxiliary transcript and meeting summary do not load Claude',async()=>{
    const {sessionTranscript}=await import('../dist/server/runs.js');assert.deepEqual(await sessionTranscript('free-agent:test',ws),[]);
    const {Meeting}=await import('../dist/server/meeting.js');await assert.rejects(Meeting.prototype.summarize.call({}),/unavailable/);
  });
  await test('free-only provider discovery never calls SDK or CLIs; legacy engine cannot execute',async()=>{
    mockFetch([]);const cfg=path.join(scratch,'config.json');fs.writeFileSync(cfg,JSON.stringify({providers:{'free-agent':{enabled:true}}}));
    // Config loader's real Root shape is obtained from the existing isolated preparer.
    const prepared=JSON.parse(spawnSync(process.execPath,['scripts/prepare-statex-mvp.mjs','--free'],{encoding:'utf8'}).stdout);
    const {resolveRoot}=await import('../dist/server/config.js');
    const root=resolveRoot({dir:prepared.workspace});initProviders(root,path.join(prepared.workspace,'.pixel-office/data'));
    const statuses=await providerStatuses();assert.equal(statuses.find(p=>p.id==='free-agent').connected,true);assert(statuses.filter(p=>p.id!=='free-agent').every(p=>!p.enabled&&!p.connected));
    assert.equal(engineOf('free-agent:auto'),'free-agent');assert.deepEqual(await listConnectors(ws),[]);
    const legacy=new Employee({id:'legacy',officeId:'main',name:'Legacy',role:'dev',color:'#fff',look:{},systemPrompt:'-',cwd:ws,model:'claude-sonnet-5-5'},new Store(path.join(scratch,'legacy-store')));
    const errors=[];legacy.on('message',m=>errors.push(m.text));legacy.send('must not run');await wait(50);assert(errors.some(x=>x.includes('Engine disabled')));await legacy.dispose();
    fs.rmSync(prepared.workspace,{recursive:true,force:true});
  });
  if(process.argv.includes('--unit-only')){
    console.log(JSON.stringify({passed:checks.length,failed:0,checks,realProviderRequests:0},null,2));
  } else {
  // The following test exercises the ACTUAL secure gateway's catalog filtering and max_price guard.
  globalThis.fetch=originalFetch;
  const python=path.resolve('free-model-router/.venv/bin/python');assert(fs.existsSync(python),'Existing router venv is required; no dependency installation is attempted');
  fixture=spawn(python,['scripts/fixtures/free-agent-gateway.py'],{stdio:['ignore','pipe','pipe']});
  let first='';fixture.stdout.on('data',chunk=>first+=chunk);
  let stderr='';fixture.stderr.on('data',chunk=>stderr+=chunk);
  for(let i=0;i<150&&!first.includes('\n')&&fixture.exitCode===null;i++)await wait(50);
  assert(first.includes('\n'),'offline gateway fixture failed to start');
  const port=JSON.parse(first.split('\n')[0]).port;const base=`http://127.0.0.1:${port}`;process.env.STATEX_FREE_ROUTER_URL=base;
  // Only our ephemeral loopback fixture is reachable from the JS test.
  globalThis.fetch=(url,init)=>{assert(String(url).startsWith(base+'/'),'external network forbidden');return originalFetch(url,init);};
  for(let i=0;i<100;i++){try{if((await fetch(base+'/health')).ok)break;}catch{}await wait(30);}
  await test('Mia → actual secure Gateway → simulated free model → Read / approved Edit / Read',async()=>{
    fs.writeFileSync(readme,'# Fixture\n');
    const mia=new Employee({id:'mia',officeId:'main',name:'Mia',role:'Developer',color:'#56dfcd',look:{},systemPrompt:'Use README.md only.',cwd:ws,model:'free-agent:auto',permissionMode:'default'},new Store(path.join(scratch,'mia-store')));
    const asks=[],activity=[],spend=[];
    mia.on('message',m=>activity.push(m));mia.on('spend',s=>spend.push(s));
    let permit;mia.on('ask',q=>{asks.push(q);permit=()=>mia.reply(q.requestId,{allow:true,always:true});});
    mia.send('Read README.md, add StateX HQ Agent Test OK, reread and confirm.');
    for(let i=0;i<100&&!permit;i++)await wait(20);
    assert(permit,'Mia must request approval');assert.equal(mia.status,'waiting');assert.equal(fs.readFileSync(readme,'utf8'),'# Fixture\n');assert.equal(asks[0].toolName,'Edit');assert.equal(asks[0].canAlwaysAllow,false);
    permit();for(let i=0;i<150&&!activity.some(m=>m.role==='assistant'&&m.text.includes('Verified'));i++)await wait(20);
    assert.equal(fs.readFileSync(readme,'utf8'),'# Fixture\nStateX HQ Agent Test OK\n');assert.equal(mia.status,'idle');assert.equal(mia.model,'fixture/free');
    assert(activity.some(m=>m.role==='assistant'&&m.text.includes('Verified')));assert.deepEqual(activity.filter(m=>m.role==='activity'&&/^(Read|Edit):/.test(m.text)).map(m=>m.text.split(':')[0]),['Read','Edit','Read']);
    const stats=await (await fetch(base+'/test/stats')).json();assert.deepEqual(stats.models,['fixture/free','fixture/free','fixture/free','fixture/free']);assert(stats.routing.every(p=>p.allow_fallbacks===false&&p.max_price.prompt===0&&p.max_price.completion===0));
    assert.deepEqual(stats.tool_results.map(t=>t.tool_call_id),['call-0','call-1','call-2']);
    assert.equal(spend.reduce((s,u)=>s+u.tokens.input,0),120);assert.equal(spend.reduce((s,u)=>s+u.tokens.output,0),40);assert(spend.every(u=>u.cost===0&&u.engine==='free-agent'));
    assert(!JSON.stringify(activity).includes('offline-fixture-key'));assert(!stderr.includes('offline-fixture-key'));
    await mia.dispose();
  });
  await test('real office HTTP/WebSocket chat: Mia, Alex and Sam use free-agent without SDK or subprocesses',async()=>{
    const prepared=JSON.parse(spawnSync(process.execPath,['scripts/prepare-statex-mvp.mjs','--free'],{encoding:'utf8'}).stdout);
    officeWorkspace=prepared.workspace;const target=path.join(officeWorkspace,'README.md');fs.writeFileSync(target,'# Fixture\n');
    const reservation=createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));
    const officePort=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
    const officeBase=`http://127.0.0.1:${officePort}`;
    let officeErrors='';
    officeChild=spawn(process.execPath,['scripts/fixtures/free-office-server.mjs'],{stdio:['ignore','pipe','pipe'],env:{PATH:path.dirname(process.execPath),STATEX_FREE_ONLY:'1',STATEX_FREE_ROUTER_URL:base,PIXEL_OFFICE_MODE:'project',PIXEL_OFFICE_ROOT:officeWorkspace,PIXEL_OFFICE_HOME:path.join(scratch,'unused-home'),PORT:String(officePort)}});
    officeChild.stdout.resume();officeChild.stderr.on('data',c=>officeErrors+=c);
    // Test-client reads may target only our two local fixtures.
    globalThis.fetch=(url,init)=>{assert([base,officeBase].some(b=>String(url).startsWith(b+'/')));return originalFetch(url,init);};
    let ready=false;
    for(let i=0;i<150&&officeChild.exitCode===null;i++){try{if((await fetch(officeBase+'/api/options')).ok){ready=true;break;}}catch{}await wait(30);}
    assert(ready,`isolated office did not start: ${officeErrors}`);
    const providers=await (await fetch(officeBase+'/api/providers')).json();assert(providers.extraModels.some(m=>m.id==='free-agent:auto'));assert(providers.providers.filter(p=>p.id!=='free-agent').every(p=>!p.enabled));
    socket=new WebSocket(officeBase.replace('http:','ws:'));const events=[];
    socket.on('message',raw=>events.push(JSON.parse(raw)));
    await new Promise((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject);});
    for(let i=0;i<50&&!events.some(m=>m.type==='init');i++)await wait(20);
    const roster=events.find(m=>m.type==='init').offices[0].employees;
    assert.deepEqual(roster.map(e=>e.name).sort(),['Alex','Mia','Sam']);assert(roster.every(e=>e.engine==='free-agent'));
    socket.send(JSON.stringify({type:'send',office:'main',id:'mia',text:'Read README.md, add the test line, reread and verify.'}));
    for(let i=0;i<150&&!events.some(m=>m.type==='ask');i++)await wait(20);
    const ask=events.find(m=>m.type==='ask');assert(ask,'native chat must receive approval');assert.equal(ask.request.canAlwaysAllow,false);assert.match(ask.request.description,/old_string/);assert.equal(fs.readFileSync(target,'utf8'),'# Fixture\n');
    socket.send(JSON.stringify({type:'reply',office:'main',id:'mia',requestId:ask.request.requestId,allow:true}));
    for(let i=0;i<150&&!events.some(m=>m.type==='result'&&m.id==='mia');i++)await wait(20);
    assert(events.some(m=>m.type==='ask_done'&&m.requestId===ask.request.requestId));
    assert(events.some(m=>m.type==='result'&&m.id==='mia'&&m.model==='fixture/free'&&m.cost===0));
    assert.equal(fs.readFileSync(target,'utf8'),'# Fixture\nStateX HQ Agent Test OK\n');
    assert(events.some(m=>m.type==='message'&&m.id==='mia'&&m.message.role==='assistant'&&m.message.text.includes('Verified')));
    for(const id of ['alex','sam']){
      socket.send(JSON.stringify({type:'send',office:'main',id,text:'Read README.md, add the test line, reread and verify.'}));
      for(let i=0;i<150&&!events.some(m=>m.type==='ask'&&m.id===id);i++)await wait(20);
      const request=events.find(m=>m.type==='ask'&&m.id===id);assert(request,`${id} uses the same approval loop`);
      // The simulated Edit would duplicate a line, so deny it. The model must see the denial.
      socket.send(JSON.stringify({type:'reply',office:'main',id,requestId:request.request.requestId,allow:false}));
      for(let i=0;i<150&&!events.some(m=>m.type==='result'&&m.id===id);i++)await wait(20);
      assert(events.some(m=>m.type==='result'&&m.id===id&&m.model==='fixture/free'));
    }
    assert.equal(fs.readFileSync(target,'utf8'),'# Fixture\nStateX HQ Agent Test OK\n');
    const state=JSON.parse(fs.readFileSync(path.join(officeWorkspace,'.pixel-office/data/main/state.json'),'utf8'));
    assert(state.sessions.mia.startsWith('free-agent:'));
    const saved=state.meta.mia.freeAgentHistory[state.sessions.mia];assert.equal(saved.at(-1).role,'assistant');assert(saved.some(m=>m.role==='tool'&&m.content.includes('StateX HQ Agent Test OK')));
    assert(!officeErrors.includes('SDK_RUNTIME_FORBIDDEN'));assert(!officeErrors.includes('SUBPROCESS_FORBIDDEN'));assert(!officeErrors.includes('offline-fixture-key'));
    socket.close();socket=undefined;
    officeChild.kill('SIGTERM');await new Promise(resolve=>officeChild.once('exit',resolve));
  });
  console.log(JSON.stringify({passed:checks.length,failed:0,checks,realProviderRequests:0,gateway:'Actual Gateway with httpx.MockTransport',sdk:'runtime import denied by test loader'},null,2));
  }
} finally {
  globalThis.fetch=originalFetch;
  socket?.terminate();
  if(officeChild&&officeChild.exitCode===null){officeChild.kill('SIGTERM');await new Promise(resolve=>officeChild.once('exit',resolve));}
  if(officeWorkspace)fs.rmSync(officeWorkspace,{recursive:true,force:true});
  if(fixture&&fixture.exitCode===null){fixture.kill('SIGTERM');await new Promise(resolve=>fixture.once('exit',resolve));}
  fs.rmSync(scratch,{recursive:true,force:true});
}
