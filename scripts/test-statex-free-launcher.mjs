import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startFree, stopFree, launcherPaths, preparePersistentOffice } from './statex-free-launcher.mjs';
import { loadFreeProviderEnv } from './statex-free-launcher.mjs';
import { FreeModelRouter } from '../dist/server/free-router.js';

const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'statex-free-launcher-'));
let passed=0;
async function test(name,fn){await fn();passed++;console.log(`ok ${name}`);}
function harness(label) {
  const root=path.join(scratch,label),ports={router:15411,office:15478},paths=launcherPaths(root),officeDir=paths.officeDir;
  const framework=path.join(root,'python-install','Python.framework','Versions','3.12');
  const frameworkPython=path.join(framework,'bin','python3.12');
  const appPython=path.join(framework,'Resources','Python.app','Contents','MacOS','Python');
  fs.mkdirSync(path.dirname(frameworkPython),{recursive:true});fs.mkdirSync(path.dirname(appPython),{recursive:true});
  fs.writeFileSync(frameworkPython,'offline python fixture');fs.writeFileSync(appPython,'offline macOS app python fixture');
  const venvPython=path.join(root,'free-model-router','.venv','bin','python');fs.mkdirSync(path.dirname(venvPython),{recursive:true});
  fs.symlinkSync(frameworkPython,venvPython);
  const pythonExecutable=process.platform==='darwin'?fs.realpathSync(appPython):fs.realpathSync(venvPython);
  const live=new Map(),foreign=new Map(),proc=new Map(),signals=[],errors=[],spawnEnvs=[];
  let nextPid=70000,builds=0;
  const deps={
    portListening:async port=>live.has(port)||foreign.has(port),
    listenerIdentity:async port=>{const service=live.get(port)||foreign.get(port);const identity=service?.identity??(service?.pid?proc.get(service.pid)?.identity:null);return identity?{pid:service.pid,...identity}:null;},
    fetch:async url=>{
      const u=new URL(url),port=Number(u.port),service=live.get(port)||foreign.get(port);
      if(!service)return new Response('unavailable',{status:503});
      if(service.type==='router'&&u.pathname==='/health')return Response.json(service.good?{status:'ok',policy:'free-only',providers:['openrouter'],groq:'excluded_unverified_free_account'}:{status:'ok',policy:'paid'});
      if(service.type==='office'&&u.pathname==='/api/settings')return Response.json({server:{port,host:'127.0.0.1',mode:'project',root:officeDir,configFile:path.join(officeDir,'.pixel-office','config.json')}});
      if(service.type==='office'&&u.pathname==='/api/providers')return Response.json({providers:[{id:'free-agent',enabled:true,connected:true},{id:'openrouter',enabled:false,connected:false},{id:'claude',enabled:false,connected:false}]});
      return new Response('not found',{status:404});
    },
    spawn:(cmd,args,options)=>{
      spawnEnvs.push(options.env);
      const kind=cmd==='bash'?'router':'office',port=kind==='router'?Number(options.env.SERVER_PORT):Number(args[2]);
      const pid=nextPid++,command=kind==='router'?`${pythonExecutable} -m uvicorn main:app --host 127.0.0.1 --port ${port} --no-access-log`:`${process.execPath} ${path.join(root,'scripts','free-office-child.mjs')} ${officeDir} ${port}`;
      const cwd=fs.realpathSync(kind==='router'?path.join(root,'free-model-router'):root);
      const executable=kind==='router'?pythonExecutable:process.execPath;
      const identity={started:`fake-start-${pid}`,cwd,executable,fingerprint:`fake-hash-${pid}`,command};
      proc.set(pid,{identity,active:true,kind,port});live.set(port,{type:kind,good:true,pid});
      return {pid};
    },
    identity:pid=>proc.get(pid)?.active?proc.get(pid).identity:null,
    alive:pid=>!!proc.get(pid)?.active,
    kill:(pid,signal)=>{signals.push([pid,signal]);const p=proc.get(pid);if(p){p.active=false;live.delete(p.port);}},
    sleep:async()=>{},
    build:()=>{builds++;},needsBuild:()=>false,
    loadProviderEnv:()=>({}),
    log:()=>{},error:line=>errors.push(line),
  };
  return {root,ports,paths,officeDir,live,foreign,proc,signals,errors,spawnEnvs,pythonExecutable,deps,get builds(){return builds;}};
}
function manualRouter(h) {
  const pid=62920, cwd=fs.realpathSync(path.join(h.root,'free-model-router'));
  const command=`${h.pythonExecutable} -m uvicorn main:app --host 127.0.0.1 --port ${h.ports.router} --no-access-log`;
  h.live.set(h.ports.router,{type:'router',good:true,pid,identity:{started:'manual-router-start',cwd,executable:h.pythonExecutable,fingerprint:'manual-router-fingerprint',command}});
}

try {
  await test('loads only protected provider keys from a private file and enables attested Groq offline',async()=>{
    const dir=path.join(scratch,'provider-env');fs.mkdirSync(dir,{recursive:true,mode:0o700});
    const envFile=path.join(dir,'free-providers.env');
    fs.writeFileSync(envFile,'GROQ_API_KEY=fixture-groq-secret\nOPENROUTER_API_KEY=fixture-openrouter-secret\nUNRELATED=value\n',{mode:0o600});
    // An unsupported entry fails closed; no provider credentials are read from the real home directory.
    assert.throws(()=>loadFreeProviderEnv(envFile),/unsupported or malformed/);
    fs.writeFileSync(envFile,'GROQ_API_KEY=fixture-groq-secret\nOPENROUTER_API_KEY=fixture-openrouter-secret\n',{mode:0o600});
    const loaded=loadFreeProviderEnv(envFile);
    assert.deepEqual(Object.keys(loaded).sort(),['GROQ_API_KEY','OPENROUTER_API_KEY']);
    const attestationFile=path.join(dir,'attestations.json');
    fs.writeFileSync(attestationFile,JSON.stringify({version:1,accounts:{groq:{model:'openai/gpt-oss-20b',freeTierConfirmed:true,billingEnabled:false,autoRecharge:false,verifiedAt:new Date().toISOString()}}}),{mode:0o600});
    const router=new FreeModelRouter({env:loaded,attestationFile,stateFile:path.join(dir,'state.json')});
    assert.deepEqual(router.health().providers,['groq']);
    assert.equal(router.health().status,'ok');
  });
  await test('provider environment file rejects insecure modes, symlinks and duplicate keys',async()=>{
    const dir=path.join(scratch,'provider-env-security');fs.mkdirSync(dir,{recursive:true,mode:0o700});
    const envFile=path.join(dir,'free-providers.env');fs.writeFileSync(envFile,'GROQ_API_KEY=fixture-secret\n',{mode:0o600});
    fs.chmodSync(envFile,0o644);assert.throws(()=>loadFreeProviderEnv(envFile),/private, owner-owned/);
    fs.chmodSync(envFile,0o600);const link=path.join(dir,'link.env');fs.symlinkSync(envFile,link);
    assert.throws(()=>loadFreeProviderEnv(link),/could not be opened safely/);
    fs.writeFileSync(envFile,'GROQ_API_KEY=one\nGROQ_API_KEY=two\n',{mode:0o600});
    assert.throws(()=>loadFreeProviderEnv(envFile),/duplicate provider key/);
  });
  await test('dev:free forwards protected provider keys to its office child without logging them',async()=>{
    const h=harness('provider-env-forward'),opts={repoRoot:h.root,paths:h.paths,officeDir:h.officeDir,routerPort:h.ports.router,officePort:h.ports.office,backend:'typescript'};
    h.deps.loadProviderEnv=()=>({GROQ_API_KEY:'fixture-groq-secret',OPENROUTER_API_KEY:'fixture-openrouter-secret'});
    await startFree(opts,h.deps);
    const childEnv=h.spawnEnvs.find(x=>x.STATEX_FREE_ROUTER_BACKEND==='typescript');
    assert.equal(childEnv.GROQ_API_KEY,'fixture-groq-secret');assert.equal(childEnv.OPENROUTER_API_KEY,'fixture-openrouter-secret');
    assert(!h.errors.join('\n').includes('fixture-'));await stopFree(opts,h.deps);
  });
  await test('occupied router port with a non-StateX service aborts without killing it',async()=>{
    const h=harness('foreign-router');h.foreign.set(h.ports.router,{type:'router',good:false});
    await assert.rejects(startFree({repoRoot:h.root,paths:h.paths,officeDir:h.officeDir,routerPort:h.ports.router,officePort:h.ports.office,backend:'python'},h.deps),/health did not match policy free-only/);
    assert.equal(h.signals.length,0);assert.equal(h.live.size,0);
  });
  await test('occupied office port with another process aborts before starting the router',async()=>{
    const h=harness('foreign-office');h.foreign.set(h.ports.office,{type:'alien'});
    await assert.rejects(startFree({repoRoot:h.root,paths:h.paths,officeDir:h.officeDir,routerPort:h.ports.router,officePort:h.ports.office,backend:'python'},h.deps),/different office or process/);
    assert.equal(h.live.size,0);assert.equal(h.signals.length,0);assert(!fs.existsSync(h.officeDir));
  });
  await test('existing verified services are reused and stop leaves them running',async()=>{
    const h=harness('reuse');preparePersistentOffice(h.officeDir,h.ports.office);
    const customProfile=path.join(h.officeDir,'.pixel-office','employees','mia','agent.md');fs.writeFileSync(customProfile,'preserve while reusing');
    manualRouter(h);h.live.set(h.ports.office,{type:'office',good:true});
    const ctx=await startFree({repoRoot:h.root,paths:h.paths,officeDir:h.officeDir,routerPort:h.ports.router,officePort:h.ports.office,backend:'python'},h.deps);
    assert(ctx.routerListening&&ctx.officeListening);assert.equal(ctx.owned.length,0);assert.equal(fs.readFileSync(customProfile,'utf8'),'preserve while reusing');
    const result=await stopFree({repoRoot:h.root,paths:h.paths,officeDir:h.officeDir},h.deps);
    assert.deepEqual(result.stopped,[]);assert.equal(h.live.size,2);assert.equal(h.signals.length,0);
  });
  await test('regression PID 62920: macOS Python.app argv from run.sh is verified and reused; stop leaves manual gateway running',async()=>{
    const h=harness('manual-router'),opts={repoRoot:h.root,paths:h.paths,officeDir:h.officeDir,routerPort:h.ports.router,officePort:h.ports.office,backend:'python'};
    manualRouter(h);
    const ctx=await startFree(opts,h.deps);
    assert(ctx.routerListening&&!ctx.officeListening);assert.deepEqual(ctx.owned.map(x=>x.kind),['office']);
    const result=await stopFree(opts,h.deps);
    assert.deepEqual(result.stopped,['office']);assert.equal(h.live.has(h.ports.router),true);
    assert.equal(h.signals.some(([pid])=>pid===62920),false);
  });
  await test('default TypeScript backend ignores 4141 and starts only the office without provider requests',async()=>{
    const h=harness('typescript-default'),opts={repoRoot:h.root,paths:h.paths,officeDir:h.officeDir,routerPort:h.ports.router,officePort:h.ports.office,backend:'typescript'};
    h.foreign.set(h.ports.router,{type:'foreign'});
    const ctx=await startFree(opts,h.deps);
    assert.equal(ctx.routerListening,false);assert.equal(h.live.has(h.ports.office),true);assert.equal(h.foreign.has(h.ports.router),true);
    assert.deepEqual(ctx.owned.map(x=>x.kind),['office']);
    await stopFree(opts,h.deps);assert.equal(h.foreign.has(h.ports.router),true);assert.equal(h.signals.length,1);
  });
  await test('free-only health without verifiable listener identity is left running with manual inspection steps',async()=>{
    const h=harness('unverified-router'),opts={repoRoot:h.root,paths:h.paths,officeDir:h.officeDir,routerPort:h.ports.router,officePort:h.ports.office,backend:'python'};
    h.live.set(h.ports.router,{type:'router',good:true});
    await assert.rejects(startFree(opts,h.deps),/lsof\/ps.*Ctrl\+C.*stop:free will not stop this service/);
    assert.equal(h.signals.length,0);assert.equal(h.live.has(h.ports.router),true);assert(!fs.existsSync(h.officeDir));
  });
  await test('launched router with unverifiable identity is not signalled and reports safe manual handling',async()=>{
    const h=harness('unverifiable-launched-router'),opts={repoRoot:h.root,paths:h.paths,officeDir:h.officeDir,routerPort:h.ports.router,officePort:h.ports.office,backend:'python'};
    const spawn=h.deps.spawn;
    h.deps.spawn=(...args)=>{const child=spawn(...args);const entry=h.proc.get(child.pid);if(entry.kind==='router')entry.identity={...entry.identity,cwd:path.join(h.root,'other-dir')};return child;};
    await assert.rejects(startFree(opts,h.deps),/Could not verify the router process identity.*Ctrl\+C.*lsof.*stop:free will not stop this service/);
    assert.equal(h.signals.length,0);assert.equal(h.live.has(h.ports.router),true);
    assert.match(h.errors.join('\n'),/was left running because its identity was not recorded/);
  });
  await test('waits through run.sh exec and listener startup race before recording router identity',async()=>{
    const h=harness('startup-race'),opts={repoRoot:h.root,paths:h.paths,officeDir:h.officeDir,routerPort:h.ports.router,officePort:h.ports.office,backend:'python'};
    const identity=h.deps.identity,portListening=h.deps.portListening;let identityReads=0,routerProbes=0;
    h.deps.identity=pid=>{
      const value=identity(pid);
      if(value&&h.proc.get(pid)?.kind==='router'&&identityReads++===0)return {...value,command:`/bin/bash ${path.join(h.root,'free-model-router','run.sh')}`};
      return value;
    };
    h.deps.portListening=async port=>{
      if(port===h.ports.router&&routerProbes++<2)return false;
      return portListening(port);
    };
    const ctx=await startFree(opts,h.deps);
    assert.deepEqual(ctx.owned.map(x=>x.kind).sort(),['office','router']);
    assert(identityReads>=2&&routerProbes>=3);
    await stopFree(opts,h.deps);
  });
  await test('starts gateway and isolated office, then stop only signals verified owned PIDs',async()=>{
    const h=harness('start-stop'),opts={repoRoot:h.root,paths:h.paths,officeDir:h.officeDir,routerPort:h.ports.router,officePort:h.ports.office,backend:'python'};
    const ctx=await startFree(opts,h.deps);
    assert.deepEqual(ctx.owned.map(x=>x.kind).sort(),['office','router']);assert.equal(h.live.size,2);assert.equal(h.builds,0);
    const state=JSON.parse(fs.readFileSync(h.paths.stateFile,'utf8'));assert.deepEqual(Object.keys(state.processes).sort(),['office','router']);
    const config=JSON.parse(fs.readFileSync(path.join(h.officeDir,'.pixel-office','config.json'),'utf8'));
    assert.equal(config.port,h.ports.office);assert.equal(config.host,'127.0.0.1');
    for(const employee of ['alex','mia','sam'])assert.match(fs.readFileSync(path.join(h.officeDir,'.pixel-office','employees',employee,'agent.md'),'utf8'),/model: free-agent:auto/);
    const alexPrompt=fs.readFileSync(path.join(h.officeDir,'.pixel-office','employees','alex','agent.md'),'utf8');
    const miaPrompt=fs.readFileSync(path.join(h.officeDir,'.pixel-office','employees','mia','agent.md'),'utf8');
    assert.match(alexPrompt,/delegate_task when that coordination tool is explicitly available/);
    assert.doesNotMatch(alexPrompt,/Do not use .*delegation/);
    assert.match(miaPrompt,/submit_task_result is available/);
    assert.doesNotMatch(miaPrompt,/Do not use .*delegation/);
    const marker=path.join(h.officeDir,'user-data.txt');fs.writeFileSync(marker,'preserve me');
    const stopped=await stopFree(opts,h.deps);assert.deepEqual(stopped.stopped.sort(),['office','router']);assert.equal(h.live.size,0);assert(!fs.existsSync(h.paths.stateFile));assert.equal(fs.readFileSync(marker,'utf8'),'preserve me');
  });
  await test('restart reuses persistent files without overwriting user data',async()=>{
    const h=harness('restart'),opts={repoRoot:h.root,paths:h.paths,officeDir:h.officeDir,routerPort:h.ports.router,officePort:h.ports.office,backend:'python'};
    await startFree(opts,h.deps);const profile=path.join(h.officeDir,'.pixel-office','employees','mia','agent.md');fs.writeFileSync(profile,'custom Mia profile');
    await stopFree(opts,h.deps);await startFree(opts,h.deps);
    assert.equal(fs.readFileSync(profile,'utf8'),'custom Mia profile');assert.equal(h.live.size,2);
    await stopFree(opts,h.deps);
  });
  await test('PID reuse or changed process identity is never signalled',async()=>{
    const h=harness('pid-reuse'),opts={repoRoot:h.root,paths:h.paths,officeDir:h.officeDir,routerPort:h.ports.router,officePort:h.ports.office,backend:'python'};
    await startFree(opts,h.deps);const state=JSON.parse(fs.readFileSync(h.paths.stateFile,'utf8'));
    h.proc.get(state.processes.router.pid).identity={started:'later-process',fingerprint:'different',command:'unrelated process'};
    const result=await stopFree(opts,h.deps);
    assert.equal(h.signals.length,1);assert.equal(h.signals[0][0],state.processes.office.pid);assert.deepEqual(result.stopped,['office']);
    assert(h.live.has(h.ports.router));
  });
  await test('startup refuses a workspace with work Pixel Office could auto-resume',async()=>{
    const h=harness('pending-work'),opts={repoRoot:h.root,paths:h.paths,officeDir:h.officeDir,routerPort:h.ports.router,officePort:h.ports.office,backend:'python'};
    preparePersistentOffice(h.officeDir,h.ports.office);
    const boardDir=path.join(h.officeDir,'.pixel-office','data','main');fs.mkdirSync(boardDir,{recursive:true});
    fs.writeFileSync(path.join(boardDir,'board.json'),JSON.stringify({tasks:[{status:'doing'}]}));
    await assert.rejects(startFree(opts,h.deps),/could call a model on startup/);assert.equal(h.live.size,0);
  });
  await test('an already-cancelled start creates no office files',async()=>{
    const h=harness('cancel-start'),controller=new AbortController();controller.abort();
    await assert.rejects(startFree({repoRoot:h.root,paths:h.paths,officeDir:h.officeDir,routerPort:h.ports.router,officePort:h.ports.office,backend:'python',signal:controller.signal},h.deps),/Startup interrupted/);
    assert(!fs.existsSync(h.paths.stateDir));assert.equal(h.live.size,0);
  });
  console.log(`StateX Free launcher: ${passed} passed, 0 failed, providerRequests=0`);
} finally { fs.rmSync(scratch,{recursive:true,force:true}); }
