// Offline: the cyber team profiles are written once, parse with the real loader and grant only intel tools.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const {preparePersistentOffice}=await import('./statex-free-launcher.mjs');
const {prepareCyberTeam,CYBER_TEAM}=await import('./prepare-statex-cyber.mjs');
const {parseAgentFile}=await import('../dist/server/agents.js');
const {engineOf}=await import('../dist/server/providers.js');
const {isIntelTool}=await import('../dist/server/free-agent-intel.js');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'statex-cyber-'));
try{
  assert.throws(()=>prepareCyberTeam(path.join(dir,'missing')),/No StateX office/);
  const office=path.join(dir,'office');preparePersistentOffice(office);
  const r=prepareCyberTeam(office);
  assert.deepEqual(r.created,Object.values(CYBER_TEAM).map(p=>p.name));
  for(const [id,p] of Object.entries(CYBER_TEAM)){
    const {meta,body}=parseAgentFile(path.join(r.employeesDir,id,'agent.md'));
    assert.equal(meta.model,'free-agent:auto');assert.equal(meta.permissionMode,'default');
    const tools=meta.tools?meta.tools.split(',').map(s=>s.trim()):[];
    assert.deepEqual(tools,p.tools);assert(tools.every(isIntelTool));
    assert.match(body,/out_of_scope/);assert.match(body,/personas concretas/);
  }
  assert(!fs.existsSync(path.join(office,'scope.json')),'never creates a real scope');
  assert(fs.existsSync(path.join(office,'scope.example.json')));
  const roster=['alex','mia','sam','iker','lia','nora','teo','vera'];
  for(const id of roster){
    const {meta}=parseAgentFile(path.join(r.employeesDir,id,'agent.md'));
    assert.equal(meta.model,'free-agent:auto',`${id} configured for StateX Free Agent`);
    assert.equal(engineOf(meta.model),'free-agent',`${id} resolves through the shared runtime`);
  }
  fs.writeFileSync(path.join(r.employeesDir,'nora','agent.md'),'custom');
  const again=prepareCyberTeam(office);
  assert.equal(again.created.length,0);assert.equal(fs.readFileSync(path.join(r.employeesDir,'nora','agent.md'),'utf8'),'custom');
  for(const id of ['mia','alex','sam'])assert(fs.existsSync(path.join(r.employeesDir,id,'agent.md')),'original team kept');
  console.log('StateX cyber team: 8 employees use free-agent; intel tools stay profile-granted; no scope.json created; idempotent');
}finally{fs.rmSync(dir,{recursive:true,force:true});}
