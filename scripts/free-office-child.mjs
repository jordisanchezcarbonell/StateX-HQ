#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const officeDir=process.argv[2];
const port=Number(process.argv[3]);
if(!officeDir||!Number.isInteger(port)||port<1||port>65535) { console.error('[statex-free] invalid office launch arguments');process.exit(2); }
const child=spawn(process.execPath,[path.join(root,'bin','pixel-office.js'),'--dir',officeDir,'--port',String(port),'--no-open'],{cwd:root,env:process.env,stdio:'inherit'});
let stopping=false;
for(const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>{if(stopping)return;stopping=true;try{child.kill(signal);}catch{}});
child.on('error',err=>{console.error(`[statex-free] office process failed to start: ${err.message}`);process.exitCode=1;});
child.on('close',(code,signal)=>{if(signal)process.exitCode=1;else process.exitCode=code??1;});
