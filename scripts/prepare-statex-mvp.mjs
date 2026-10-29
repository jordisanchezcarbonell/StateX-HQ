// Prepares data for the existing Pixel Office CLI. No server, login or inference.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const free = process.argv.includes('--free');
const selectedModel = free ? 'free-agent:auto' : 'openrouter:cohere/north-mini-code:free';
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'statex-hq-mvp-'));
const configDir = path.join(workspace, '.pixel-office');
const miaDir = path.join(configDir, 'employees', 'mia');
fs.mkdirSync(miaDir, {recursive:true});
fs.mkdirSync(path.join(workspace,'.claude'), {recursive:true});
fs.writeFileSync(path.join(configDir,'config.json'),JSON.stringify({
  locale:'en',host:'127.0.0.1',port:4748,
  dataDir:'.pixel-office/data',memoryFile:'memory.md',
  syncClaudeAgents:false,sickness:false,
  offices:[{id:'main',name:'StateX HQ',cwd:'.',employeesDir:'.pixel-office/employees',theme:'default'}],
  providers: free ? Object.fromEntries(['claude','codex','gemini','openrouter','free-agent'].map(id=>[id,{enabled:id==='free-agent'}])) : {openrouter:{enabled:true,models:['cohere/north-mini-code:free']}}
},null,2)+'\n');
fs.writeFileSync(path.join(workspace,'.claude','settings.json'),JSON.stringify({
  permissions:{deny:['Bash','WebFetch','WebSearch','Agent']}
},null,2)+'\n');
fs.writeFileSync(path.join(miaDir,'agent.md'),`---
name: Mia
role: Software Developer
model: ${selectedModel}
permissionMode: default
color: '#56dfcd'
---
You are Mia, a developer at StateX HQ. For this test, work only on README.md in the current workspace.
Read it, add exactly one line "StateX HQ Agent Test OK", read it again, and report what you verified.
Use Read and Edit/Write tools. Ask for approval when required. Do not use Bash, network tools, delegation or other projects.
Do not create tasks, change office settings or write memory during this test. Stop on an error and report it.
`);
if (free) for (const name of ['Alex','Sam']) {
  const dir=path.join(configDir,'employees',name.toLowerCase());fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,'agent.md'),fs.readFileSync(path.join(miaDir,'agent.md'),'utf8').replaceAll('Mia',name));
}
fs.writeFileSync(path.join(workspace,'README.md'),'# StateX HQ isolated workspace\n\nThis file is a temporary agent fixture.\n');
fs.writeFileSync(path.join(workspace,'TASK.txt'),'Read README.md, add exactly one line "StateX HQ Agent Test OK", read it again and confirm the result. Only modify README.md. Do not use Bash or delegate. Ask before edits when necessary.\n');
console.log(JSON.stringify({workspace,config:path.join(configDir,'config.json'),mia:path.join(miaDir,'agent.md'),
  model:selectedModel,permissionMode:'default',bashDenied:true,
  start:`${free ? 'STATEX_FREE_ONLY=1 ' : ''}npm start -- --dir '${workspace.replaceAll("'", "'\\''")}' --port 4748 --no-open`,
  credentialNotice: free ? 'No keys read or written. Only the trusted local free-only gateway holds provider credentials.' : 'No keys read or written. Native OpenRouter needs an existing OPENROUTER_API_KEY in the server environment, or use your current office without copying its secrets.',
  networkNotice: free ? 'Nothing started. The office checks only local gateway health in free-only mode; submitting a task would use the gateway quota and requires separate authorization.' : 'Nothing started. Starting the real office can probe providers; no real inference is authorized by this script.'},null,2));
