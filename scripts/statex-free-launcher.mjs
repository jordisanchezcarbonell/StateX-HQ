#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import net from 'node:net';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SAFE_ENV_KEYS = ['PATH','HOME','USER','LOGNAME','TMPDIR','TEMP','TMP','LANG','LC_ALL','LC_CTYPE','SYSTEMROOT','WINDIR','STATEX_FREE_ROUTER_URL','STATEX_FREE_MAX_REQUESTS','STATEX_FREE_MAX_ITERATIONS','STATEX_FREE_MAX_OUTPUT_TOKENS','STATEX_FREE_MAX_TOTAL_TOKENS','STATEX_FREE_MAX_TOOLS','STATEX_FREE_ROUTER_BACKEND','STATEX_FREE_ROUTER_STATE','STATEX_FREE_ATTESTATION_FILE','GROQ_API_KEY','OPENROUTER_API_KEY'];
const HEALTH_PATH = '/health';

export const launcherPaths = (root = repoRoot) => {
  const stateDir = path.join(root, '.statex-free-dev');
  return { stateDir, officeDir: path.join(stateDir, 'office'), stateFile: path.join(stateDir, 'launcher-state.json') };
};

const defaultDeps = {
  fetch: (...args) => fetch(...args),
  portListening: (port) => new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const finish = (value) => { socket.destroy(); resolve(value); };
    socket.setTimeout(700, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  }),
  spawn: (...args) => spawn(...args),
  build: (root) => {
    const result = spawnSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit' });
    if (result.status !== 0) throw new Error('StateX HQ build failed');
  },
  needsBuild,
  identity: (pid) => {
    try {
      const started = execFileSync('ps', ['-o','lstart=','-p',String(pid)], { encoding:'utf8', timeout:3000, stdio:['ignore','pipe','ignore'], env:{ ...process.env, LC_ALL:'C', LANG:'C' } }).trim();
      const command = execFileSync('ps', ['-o','command=','-p',String(pid)], { encoding:'utf8', timeout:3000, stdio:['ignore','pipe','ignore'], env:{ ...process.env, LC_ALL:'C', LANG:'C' } }).trim();
      const files = execFileSync('lsof', ['-a','-p',String(pid),'-d','cwd','-Fn'], { encoding:'utf8', timeout:3000, stdio:['ignore','pipe','ignore'] });
      const cwd = files.split(/\r?\n/).find(line=>line.startsWith('n'))?.slice(1);
      const executableFiles=execFileSync('lsof',['-a','-p',String(pid),'-d','txt','-Fn'],{encoding:'utf8',timeout:3000,stdio:['ignore','pipe','ignore']});
      const executable=executableFiles.split(/\r?\n/).find(line=>line.startsWith('n'))?.slice(1);
      return started && command && cwd && executable ? { started, cwd, executable, fingerprint: processFingerprint(command,cwd,executable), command } : null;
    } catch { return null; }
  },
  listenerIdentity: (port) => {
    try {
      const output=execFileSync('lsof',['-nP',`-iTCP:${port}`,'-sTCP:LISTEN','-t'],{encoding:'utf8',timeout:3000,stdio:['ignore','pipe','ignore']});
      const pids=[...new Set(output.split(/\s+/).filter(Boolean))];
      if(pids.length!==1)return {inspectionError:pids.length?'multiple listener PIDs reported for this port':'lsof reported no listener PID'};
      if(!/^\d+$/.test(pids[0]))return {inspectionError:'lsof returned an invalid listener PID'};
      const identity=defaultDeps.identity(Number(pids[0]));
      return identity?{pid:Number(pids[0]),...identity}:{inspectionError:`could not read command, start time, or cwd for listener PID ${pids[0]}`};
    } catch { return {inspectionError:'lsof is unavailable or could not inspect the listening process'}; }
  },
  kill: (pid, signal) => process.kill(pid, signal),
  alive: (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } },
  sleep: (ms) => new Promise(resolve => setTimeout(resolve, ms)),
  log: (line) => console.log(line),
  error: (line) => console.error(line),
};

function mergeDeps(deps) { return { ...defaultDeps, ...deps }; }
function processFingerprint(command,cwd,executable) { return crypto.createHash('sha256').update(`${command}\0${cwd}\0${executable}`).digest('hex'); }
function canonicalPath(value) { try { return fs.realpathSync(value); } catch { return path.resolve(value); } }
function jsonResponse(ok, body) { return { ok, json: async () => body }; }
function safeEnv(extra = {}) {
  const env = {};
  for (const key of SAFE_ENV_KEYS) if (process.env[key] !== undefined) env[key] = process.env[key];
  return { ...env, ...extra };
}
function readState(file, officeDir) {
  if (!fs.existsSync(file)) return { version:1, officeDir, processes:{} };
  let state;
  try { state = JSON.parse(fs.readFileSync(file,'utf8')); } catch { throw new Error(`Launcher state is unreadable; left untouched: ${file}`); }
  if (state?.version !== 1 || path.resolve(String(state.officeDir ?? '')) !== officeDir || !state.processes || typeof state.processes !== 'object') {
    throw new Error(`Launcher state does not match this office; left untouched: ${file}`);
  }
  return state;
}
function saveState(file, state) {
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const temp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temp,JSON.stringify(state,null,2)+'\n',{mode:0o600});
  fs.renameSync(temp,file);
}
function hasArg(command,name,value) { return new RegExp(`(?:^|\\s)${name}(?:=|\\s+)${value}(?=\\s|$)`).test(command); }
function expectedRouterExecutables(root) {
  try {
    const python=canonicalPath(path.join(root,'free-model-router','.venv','bin','python'));
    const result=new Set([python]);
    // Homebrew's macOS Python may replace the venv symlink argv0 with its
    // framework Python.app executable. Accept only the paired binary from the
    // same exact Python.framework version.
    if(process.platform==='darwin') {
      const match=python.match(/^(.*\/Python\.framework\/Versions\/[^/]+)\/bin\/python(?:\d+(?:\.\d+)*)?$/);
      if(match) {
        const appPython=path.join(match[1],'Resources','Python.app','Contents','MacOS','Python');
        if(fs.existsSync(appPython))result.add(fs.realpathSync(appPython));
      }
    }
    return result;
  } catch { return new Set(); }
}
function uvicornArgsMatch(command,port) {
  return /(?:^|\s)-m\s+uvicorn\s+main:app(?=\s|$)/.test(command??'')
    && hasArg(command,'--host','127\\.0\\.0\\.1')
    && hasArg(command,'--port',String(port))
    && /(?:^|\s)--no-access-log(?=\s|$)/.test(command??'');
}
function routerProcessMatches(identity,root,port) {
  const routerDir=path.join(root,'free-model-router');
  return canonicalPath(identity?.cwd??'')===canonicalPath(routerDir)
    && expectedRouterExecutables(root).has(canonicalPath(identity?.executable??''))
    && uvicornArgsMatch(identity?.command,port);
}
function isOwnedCommand(record, identity, root) {
  const {command,cwd}=identity??{};
  if (record.kind === 'office') return canonicalPath(cwd??'')===canonicalPath(root) && command.includes(path.join(root,'scripts','free-office-child.mjs')) && command.includes(record.officeDir) && new RegExp(`(?:^|\\s)${record.port}(?=\\s|$)`).test(command);
  if (record.kind === 'router') return routerProcessMatches(identity,root,record.port);
  return false;
}
function routerIdentityReason(identity,root,port) {
  if(identity?.inspectionError)return identity.inspectionError;
  if(!identity)return 'the listening PID or its working directory is not readable (lsof/ps may be unavailable or access may be restricted)';
  if(canonicalPath(identity.cwd??'')!==canonicalPath(path.join(root,'free-model-router')))return 'the listener process working directory is not this repository’s free-model-router directory';
  if(!expectedRouterExecutables(root).has(canonicalPath(identity.executable??'')))return 'the executable is not this router venv Python or its verified macOS Python.app binary';
  if(!/(?:^|\s)-m\s+uvicorn\s+main:app(?=\s|$)/.test(identity.command??''))return 'the process arguments are not “-m uvicorn main:app”';
  if(!hasArg(identity.command,'--host','127\\.0\\.0\\.1'))return 'the process arguments do not bind explicitly to 127.0.0.1';
  if(!hasArg(identity.command,'--port',String(port)))return `the listener command does not specify port ${port}`;
  if(!/(?:^|\s)--no-access-log(?=\s|$)/.test(identity.command??''))return 'the process arguments do not match run.sh access-log settings';
  return 'the process identity did not match the expected StateX router';
}
function manualGatewayStop(port,identityReason) {
  return `Gateway identity could not be verified: ${identityReason}. It was left running. Safe manual procedure: return to the terminal that ran free-model-router/run.sh and press Ctrl+C. If that terminal is unavailable, inspect the listener with “lsof -nP -iTCP:${port} -sTCP:LISTEN” and “ps -p <PID> -o pid=,lstart=,command=”, then verify its working directory with “lsof -a -p <PID> -d cwd -Fn”; stop it only through its owning terminal or service manager. stop:free will not stop this service.`;
}
async function recordFor(kind, child, root, port, officeDir, deps, signal, onVerified) {
  if (!Number.isInteger(child?.pid) || child.pid <= 0) throw new Error(`Could not start ${kind}: no process id`);
  let identity,record;
  for(let i=0;i<150;i++) {
    if(signal?.aborted)throw new Error('Startup interrupted');
    if(!deps.alive(child.pid))throw new Error(`The launched ${kind} process exited before its identity and listener were verified`);
    identity=deps.identity(child.pid);
    if(identity&&isOwnedCommand({kind,officeDir,port},identity,root)) {
      if(!record) {
        record={kind,pid:child.pid,port,officeDir,cwd:canonicalPath(identity.cwd),executable:canonicalPath(identity.executable),started:identity.started,fingerprint:identity.fingerprint};
        onVerified(record);
      }
      if(await deps.portListening(port)) {
        if(kind!=='router')return record;
        const listener=await deps.listenerIdentity(port);
        if(listener?.pid===child.pid&&routerProcessMatches(listener,root,port))return record;
      }
    }
    await deps.sleep(100);
  }
  if(!record) {
    const reason=kind==='router'?routerIdentityReason(identity,root,port):'the command or working directory did not match the launched StateX HQ office';
    if(kind==='router')throw new Error(`Could not verify the router process identity (pid ${child.pid}). ${manualGatewayStop(port,reason)}`);
    throw new Error(`Could not verify the ${kind} process identity (pid ${child.pid}): ${reason}; it will not be managed or stopped automatically`);
  }
  throw new Error(`The ${kind} process identity was verified for PID ${child.pid}, but it did not own the listening socket on port ${port} before the startup deadline`);
}
function sameProcess(record, root, deps) {
  if (!record || !Number.isSafeInteger(record.pid) || record.pid <= 0 || !deps.alive(record.pid)) return false;
  const identity=deps.identity(record.pid);
  return !!identity && identity.started===record.started && canonicalPath(identity.cwd)===record.cwd && canonicalPath(identity.executable)===record.executable && identity.fingerprint===record.fingerprint && isOwnedCommand(record,identity,root);
}
function gatewayHealthOk(body) {
  return body?.status==='ok' && body?.policy==='free-only' && Array.isArray(body?.providers) && body.providers.length===1 && body.providers[0]==='openrouter' && body?.groq==='excluded_unverified_free_account';
}
function expandDisplayPath(value) { return String(value).replace(/^~(?=$|[\\/])/,os.homedir()); }
function officeSettingsOk(body, officeDir, port) {
  const s=body?.server;
  return s?.port===port && s?.host==='127.0.0.1' && s?.mode==='project' && path.resolve(expandDisplayPath(s?.root ?? ''))===officeDir && path.resolve(expandDisplayPath(s?.configFile ?? ''))===path.join(officeDir,'.pixel-office','config.json');
}
async function getJson(deps,url,timeout=1200) {
  try { const r=await deps.fetch(url,{signal:AbortSignal.timeout(timeout),redirect:'error'}); if(!r.ok) return null; return await r.json(); } catch { return null; }
}
async function inspectRouterHealth(deps,url) {
  try {
    const response=await deps.fetch(url,{signal:AbortSignal.timeout(1200),redirect:'error'});
    if(!response.ok)return {ok:false,reason:`/health returned HTTP ${response.status}`};
    let body;try{body=await response.json();}catch{return {ok:false,reason:'/health did not return valid JSON'};}
    return gatewayHealthOk(body)?{ok:true}:{ok:false,reason:'/health did not match policy free-only with only OpenRouter enabled and Groq excluded'};
  } catch { return {ok:false,reason:'/health could not be reached'}; }
}
async function officeIsFreeOnly(deps,port) {
  const body=await getJson(deps,`http://127.0.0.1:${port}/api/providers`);
  const providers=body?.providers;
  const free=Array.isArray(providers)?providers.find(p=>p?.id==='free-agent'):null;
  return !!free?.enabled && providers.filter(p=>p?.id!=='free-agent').every(p=>!p?.enabled&&!p?.connected);
}
function configFor(port) {
  return {
    locale:'en',host:'127.0.0.1',port,dataDir:'.pixel-office/data',employeesDir:'.pixel-office/employees',
    memoryFile:'memory.md',syncClaudeAgents:false,sickness:false,taskSessions:true,multiOffice:true,
    offices:[{id:'main',name:'StateX HQ',cwd:'.',employeesDir:'.pixel-office/employees',theme:'default'}],
    providers:Object.fromEntries(['claude','codex','gemini','openrouter','free-agent'].map(id=>[id,{enabled:id==='free-agent'}])),
  };
}
const agentProfiles = {
  mia: `---\nname: Mia\nrole: Software Developer\nmodel: free-agent:auto\npermissionMode: default\ncolor: '#56dfcd'\n---\nYou are Mia, a software developer at StateX HQ. Work only in this isolated workspace. Use the available file tools and request approval for writes. Do not use shell commands, network access, delegation, or other workspaces.\n`,
  alex: `---\nname: Alex\nrole: Personal Assistant\nmodel: free-agent:auto\npermissionMode: default\ncolor: '#9b8cff'\n---\nYou are Alex, a personal assistant at StateX HQ. Work only in this isolated workspace. Use the available file tools and request approval for writes. Do not use shell commands, network access, delegation, or other workspaces.\n`,
  sam: `---\nname: Sam\nrole: Marketing & Ads\nmodel: free-agent:auto\npermissionMode: default\ncolor: '#ffb85c'\n---\nYou are Sam, a marketing specialist at StateX HQ. Work only in this isolated workspace. Use the available file tools and request approval for writes. Do not use shell commands, network access, delegation, or other workspaces.\n`,
};
function writeNew(file, contents) { fs.mkdirSync(path.dirname(file),{recursive:true}); try { fs.writeFileSync(file,contents,{flag:'wx',mode:0o600}); return true; } catch(e) { if(e.code==='EEXIST') return false; throw e; } }
export function preparePersistentOffice(officeDir, port=4748) {
  officeDir=path.resolve(officeDir);
  const existed=fs.existsSync(officeDir);
  if(existed&&!fs.statSync(officeDir).isDirectory()) throw new Error('Persistent office path is not a directory; left untouched');
  if(!existed) fs.mkdirSync(officeDir,{recursive:true});
  const configDir=path.join(officeDir,'.pixel-office');
  const configFile=path.join(configDir,'config.json');
  if(fs.existsSync(configFile)) {
    let config; try { config=JSON.parse(fs.readFileSync(configFile,'utf8')); } catch { throw new Error('Persistent office config is invalid; left untouched'); }
    if(config.host!=='127.0.0.1'||config.port!==port||config.syncClaudeAgents!==false||!Array.isArray(config.offices)||!config.offices.some(o=>o?.id==='main'&&o?.name==='StateX HQ'&&o?.cwd==='.'&&o?.employeesDir==='.pixel-office/employees')) throw new Error('Existing directory is not the StateX Free office; no files were changed');
  } else {
    const entries=fs.readdirSync(officeDir);
    if(entries.length) throw new Error('Persistent office directory has data but no recognized config; no files were changed');
    writeNew(configFile,JSON.stringify(configFor(port),null,2)+'\n');
  }
  for(const [id,profile] of Object.entries(agentProfiles)) writeNew(path.join(configDir,'employees',id,'agent.md'),profile);
  const readme=path.join(officeDir,'README.md');
  writeNew(readme,'# StateX HQ Free Agent Workspace\n\nPersistent, isolated workspace for Alex, Mia, and Sam.\n');
  return {officeDir,configFile,readme};
}
function ensureNoAutomaticWork(officeDir,config) {
  const dataDir=path.resolve(officeDir,String(config.dataDir??'.pixel-office/data'));
  const mainOffice=(config.offices??[]).find(o=>o?.id==='main');
  const multi=config.multiOffice===true;
  const storeDir=multi?path.join(dataDir,'main'):dataDir;
  const boardFile=path.join(storeDir,'board.json');
  const stateFile=path.join(storeDir,'state.json');
  let board={},state={};
  try { if(fs.existsSync(boardFile)) board=JSON.parse(fs.readFileSync(boardFile,'utf8')); if(fs.existsSync(stateFile)) state=JSON.parse(fs.readFileSync(stateFile,'utf8')); }
  catch { throw new Error('Persistent office has unreadable task state; refusing startup to avoid automatic agent work'); }
  const pending=(Array.isArray(board.tasks)?board.tasks:[]).some(t=>t?.status==='doing'||(t?.status==='todo'&&t?.autoStart));
  const cycle=state?.meta?._office?.cycle;
  const employeesDir=path.resolve(officeDir,String(config.employeesDir??'.pixel-office/employees'));
  let autoRefresh=false;
  try { for(const name of fs.readdirSync(employeesDir)){const profile=path.join(employeesDir,name,'agent.md');if(fs.existsSync(profile)&&/^autoRefresh:\s*true\s*$/m.test(fs.readFileSync(profile,'utf8'))){autoRefresh=true;break;}} } catch {}
  if(pending||cycle?.phase==='discovering'||autoRefresh) throw new Error('Persistent office has work or auto-refresh that could call a model on startup; finish or disable it in the office first');
}
function needsBuild(root) {
  const src=path.join(root,'src','server'),dist=path.join(root,'dist','server');
  if(!fs.existsSync(path.join(dist,'index.js'))) return true;
  let newest=0;
  const visit=dir=>{for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())visit(p);else if(e.name.endsWith('.ts'))newest=Math.max(newest,fs.statSync(p).mtimeMs);}};
  visit(src);
  return newest>fs.statSync(path.join(dist,'index.js')).mtimeMs;
}
function startGatewayProcess(root,port,deps) {
  const routerDir=path.join(root,'free-model-router');
  const env=safeEnv({SERVER_HOST:'127.0.0.1',SERVER_PORT:String(port)});
  return deps.spawn('bash',[path.join(routerDir,'run.sh')],{cwd:routerDir,env,detached:true,stdio:'inherit'});
}
function startOfficeProcess(root,officeDir,port,deps,backend='typescript') {
  const env=safeEnv({STATEX_FREE_ONLY:'1',STATEX_FREE_ROUTER_BACKEND:backend==='legacy'?'python':backend,PIXEL_OFFICE_MODE:'project',PIXEL_OFFICE_ROOT:officeDir,PORT:String(port),PIXEL_OFFICE_OPEN:'0'});
  return deps.spawn(process.execPath,[path.join(root,'scripts','free-office-child.mjs'),officeDir,String(port)],{cwd:root,env,detached:true,stdio:'inherit'});
}
async function waitForReady(kind,port,officeDir,deps,signal,timeout=15000) {
  const end=Date.now()+timeout;
  while(Date.now()<end) {
    if(signal?.aborted)throw new Error('Startup interrupted');
    if(kind==='router') { const h=await getJson(deps,`http://127.0.0.1:${port}${HEALTH_PATH}`,1000); if(gatewayHealthOk(h))return true; }
    else { const s=await getJson(deps,`http://127.0.0.1:${port}/api/settings`,1000); if(officeSettingsOk(s,officeDir,port)&&await officeIsFreeOnly(deps,port))return true; }
    await deps.sleep(200);
  }
  return false;
}
async function stopRecords(records,root,state,deps,timeout=5000) {
  const remaining=[];
  for(const record of records) {
    if(!sameProcess(record,root,deps)) continue;
    try { deps.kill(record.pid,'SIGTERM'); } catch(e) { if(e.code!=='ESRCH') { remaining.push(record); continue; } }
    const until=Date.now()+timeout;
    while(Date.now()<until&&sameProcess(record,root,deps)) await deps.sleep(100);
    if(sameProcess(record,root,deps)) {
      try { deps.kill(record.pid,'SIGKILL'); } catch(e) { if(e.code!=='ESRCH') remaining.push(record); }
      const killUntil=Date.now()+1000;
      while(Date.now()<killUntil&&sameProcess(record,root,deps)) await deps.sleep(100);
      if(sameProcess(record,root,deps)&&!remaining.some(r=>r.pid===record.pid))remaining.push(record);
    }
  }
  const still=[];
  for(const record of remaining) if(sameProcess(record,root,deps)) still.push(record);
  state.processes=Object.fromEntries(Object.entries(state.processes).filter(([,r])=>!records.some(x=>x.kind===r?.kind)).concat(still.map(r=>[r.kind,r])));
  return still;
}
export async function stopFree(options={},providedDeps={}) {
  const deps=mergeDeps(providedDeps),root=path.resolve(options.repoRoot??repoRoot),paths=options.paths??launcherPaths(root),officeDir=path.resolve(options.officeDir??paths.officeDir);
  const state=readState(paths.stateFile,officeDir);
  const owned=Object.values(state.processes).filter(r=>r&&sameProcess(r,root,deps));
  const left=await stopRecords(owned,root,state,deps);
  if(left.length) { saveState(paths.stateFile,state); throw new Error(`Could not stop launcher-owned process ids: ${left.map(x=>x.pid).join(', ')}`); }
  state.processes={};
  try { fs.unlinkSync(paths.stateFile); } catch(e) { if(e.code!=='ENOENT') throw e; }
  return {stopped:owned.map(x=>x.kind),left:[]};
}

export async function startFree(options={},providedDeps={}) {
  const deps=mergeDeps(providedDeps),root=path.resolve(options.repoRoot??repoRoot),paths=options.paths??launcherPaths(root);
  const officeDir=path.resolve(options.officeDir??paths.officeDir),routerPort=options.routerPort??4141,officePort=options.officePort??4748;
  const backend=options.backend??process.env.STATEX_FREE_ROUTER_BACKEND??'typescript';
  if(!['typescript','python','legacy'].includes(backend))throw new Error('Unknown free router backend; choose typescript or python');
  const usePython=backend==='python'||backend==='legacy';
  if(options.signal?.aborted)throw new Error('Startup interrupted');
  fs.mkdirSync(paths.stateDir,{recursive:true});
  let state=readState(paths.stateFile,officeDir);
  for(const [kind,record] of Object.entries(state.processes)) if(record&&!sameProcess(record,root,deps)) delete state.processes[kind];
  // Inspect both ports before starting anything so foreign listeners cause a clean abort.
  const routerListening=usePython?await deps.portListening(routerPort):false;
  if(usePython&&routerListening) {
    const health=await inspectRouterHealth(deps,`http://127.0.0.1:${routerPort}${HEALTH_PATH}`);
    if(!health.ok)throw new Error(`Port ${routerPort} is occupied, but the service cannot be reused: ${health.reason}. It was left running. Stop it only from its owning terminal or service manager; stop:free will not kill it.`);
    const identity=await deps.listenerIdentity(routerPort);
    if(!routerProcessMatches(identity,root,routerPort))throw new Error(manualGatewayStop(routerPort,routerIdentityReason(identity,root,routerPort)));
  }
  const officeListening=await deps.portListening(officePort);
  if(officeListening) {
    const settings=await getJson(deps,`http://127.0.0.1:${officePort}/api/settings`);
    if(!officeSettingsOk(settings,officeDir,officePort)||!await officeIsFreeOnly(deps,officePort)) throw new Error(`Port ${officePort} is occupied by a different office or process; nothing was stopped`);
  }
  if(options.signal?.aborted)throw new Error('Startup interrupted');
  const profile=officeListening
    ? {officeDir,configFile:path.join(officeDir,'.pixel-office','config.json')}
    : preparePersistentOffice(officeDir,officePort);
  if(!fs.existsSync(profile.configFile))throw new Error('Verified office config disappeared; nothing was changed');
  const config=JSON.parse(fs.readFileSync(profile.configFile,'utf8'));
  ensureNoAutomaticWork(officeDir,config);
  const started=[],handles=[];
  const checkAbort=()=>{if(options.signal?.aborted)throw new Error('Startup interrupted');};
  const persist=()=>saveState(paths.stateFile,state);
  try {
    checkAbort();
    if(usePython&&!routerListening) {
      const child=startGatewayProcess(root,routerPort,deps);
      handles.push({child,kind:'router'});checkAbort();
      await recordFor('router',child,root,routerPort,officeDir,deps,options.signal,record=>{state.processes.router=record;started.push(record);persist();});
      if(!await waitForReady('router',routerPort,officeDir,deps,options.signal)) throw new Error('StateX Free Router did not become healthy; see its terminal output');
    }
    if(!officeListening) {
      checkAbort();
      if(deps.needsBuild(root)) deps.build(root);
      checkAbort();
      const child=startOfficeProcess(root,officeDir,officePort,deps,backend);
      handles.push({child,kind:'office'});checkAbort();
      await recordFor('office',child,root,officePort,officeDir,deps,options.signal,record=>{state.processes.office=record;started.push(record);persist();});
      if(!await waitForReady('office',officePort,officeDir,deps,options.signal)) throw new Error('StateX HQ did not become ready in free-only mode; see its terminal output');
    }
    persist();
  } catch(error) {
    await stopRecords(started,root,state,deps);
    for(const handle of handles) if(handle.child?.pid&&!started.some(r=>r.pid===handle.child.pid)) {
      deps.error(`[statex-free] Spawned ${handle.kind} PID ${handle.child.pid} was left running because its identity was not recorded. Inspect it with ps/lsof and stop it manually from its owning terminal or service manager; no signal was sent.`);
    }
    persist();
    throw error;
  }
  const owned=Object.values(state.processes).filter(r=>r&&sameProcess(r,root,deps));
  deps.log(usePython?`StateX Free Router (Python legacy): ${routerListening?'reused':'started'} — http://127.0.0.1:${routerPort} (policy: free-only)`:`StateX Free Router: in-process TypeScript (Groq → OpenRouter, free-only)`);
  deps.log(`StateX HQ: ${officeListening?'reused':'started'} — http://127.0.0.1:${officePort} (isolated: ${officeDir})`);
  deps.log(`Persistent office: ${officeDir}`);
  deps.log(`Launcher-controlled processes: ${owned.length?owned.map(x=>`${x.kind} pid=${x.pid}`).join(', '):'none; existing services will not be stopped'}`);
  return {root,paths,officeDir,state,owned,routerListening,officeListening};
}

async function supervise(ctx,deps=mergeDeps({})) {
  let closing=false;
  return new Promise(resolve=>{
    const finish=async(code)=>{
      if(closing)return;closing=true;
      process.off('SIGINT',onInt);process.off('SIGTERM',onTerm);
      clearInterval(timer);
      if(code!==0) { try { await stopFree({repoRoot:ctx.root,paths:ctx.paths,officeDir:ctx.officeDir},deps); } catch(e) { deps.error(e.message); } }
      resolve(code);
    };
    const onInt=()=>{deps.log('Stopping StateX Free services started by this launcher…');void stopFree({repoRoot:ctx.root,paths:ctx.paths,officeDir:ctx.officeDir},deps).then(()=>finish(0),e=>{deps.error(e.message);void finish(1);});};
    const onTerm=onInt;
    process.on('SIGINT',onInt);process.on('SIGTERM',onTerm);
    const timer=setInterval(()=>{
      const current=readState(ctx.paths.stateFile,ctx.officeDir);
      const records=Object.values(current.processes).filter(Boolean);
      if(!records.length)return void finish(0);
      const lost=records.find(r=>!sameProcess(r,ctx.root,deps));
      if(lost) { deps.error(`Launcher-controlled ${lost.kind} process exited or changed identity; stopping remaining controlled services.`);void stopFree({repoRoot:ctx.root,paths:ctx.paths,officeDir:ctx.officeDir},deps).then(()=>finish(1),()=>finish(1)); }
    },1000);timer.unref();
  });
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const command=process.argv[2]??'start';
  try {
    if(command==='stop') {
      const result=await stopFree();
      console.log(result.stopped.length?`Stopped launcher-owned services: ${result.stopped.join(', ')}`:'No launcher-owned services to stop; pre-existing services were left running.');
    } else if(command==='start') {
      const aborter=new AbortController(),cancel=()=>aborter.abort();
      process.on('SIGINT',cancel);process.on('SIGTERM',cancel);
      let ctx;
      try { ctx=await startFree({signal:aborter.signal}); }
      finally { process.off('SIGINT',cancel);process.off('SIGTERM',cancel); }
      if(aborter.signal.aborted) {
        try { await stopFree(); } catch(error) { console.error(`[statex-free] ${error.message}`); }
        process.exitCode=130;
      } else process.exitCode=await supervise(ctx);
    } else throw new Error('Usage: node scripts/statex-free-launcher.mjs [start|stop]');
  } catch(error) { console.error(`[statex-free] ${error.message}`); process.exitCode=1; }
}
