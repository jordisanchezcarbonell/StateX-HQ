// Verify the prepared Mia profile using the actual upstream configuration loader, offline.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {projectRoot,loadSettings} from '../dist/server/config.js';
import {loadEmployee} from '../dist/server/agents.js';
import {loadLocale,Translator} from '../dist/server/i18n.js';
import {initRuntime} from '../dist/server/runtime.js';
const prepared=JSON.parse(execFileSync(process.execPath,['scripts/prepare-statex-mvp.mjs'],{encoding:'utf8'}));
try {
  const root=projectRoot(prepared.workspace);
  const settings=loadSettings(root);
  initRuntime(settings,new Translator(loadLocale('en').data));
  const mia=loadEmployee(path.dirname(prepared.mia),0,settings.offices[0]);
  assert.equal(settings.offices[0].name,'StateX HQ');
  assert.equal(settings.host,'127.0.0.1');
  assert.equal(mia.name,'Mia');
  assert.equal(mia.model,'openrouter:cohere/north-mini-code:free');
  assert.equal(mia.cwd,prepared.workspace);
  assert.equal(mia.permissionMode,'default');
  assert.equal(mia.allowedTools,undefined,'no tool is pre-approved by this fixture');
  const rules=JSON.parse(fs.readFileSync(path.join(prepared.workspace,'.claude/settings.json'),'utf8'));
  assert(rules.permissions.deny.includes('Bash'),'Bash is denied through native project settings');
  assert(!fs.existsSync(path.join(prepared.workspace,'.env')));
  assert(!fs.existsSync(path.join(root.root,'data/secrets.json')),'no credential files prepared');
  assert.equal(fs.readFileSync(path.join(prepared.workspace,'README.md'),'utf8'),'# StateX HQ isolated workspace\n\nThis file is a temporary agent fixture.\n');
  console.log('StateX MVP: native Mia config, default permissions, Bash denial and credential-free fixture verified');
} finally {fs.rmSync(prepared.workspace,{recursive:true,force:true});}
