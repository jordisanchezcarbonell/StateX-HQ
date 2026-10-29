// Production HTTP/WebSocket server in an isolated test office, with no SDK or subprocess capability.
import {register,syncBuiltinESMExports} from 'node:module';
import cp from 'node:child_process';
register('./no-agent-sdk-loader.mjs',import.meta.url);
for(const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])cp[name]=()=>{throw new Error('SUBPROCESS_FORBIDDEN_IN_FREE_OFFICE');};
syncBuiltinESMExports();
const fetchOriginal=globalThis.fetch;
const base=process.env.STATEX_FREE_ROUTER_URL;
globalThis.fetch=(url,init)=>{
  if(!String(url).startsWith(base+'/'))throw new Error('EXTERNAL_NETWORK_FORBIDDEN_IN_FREE_OFFICE');
  return fetchOriginal(url,init);
};
await import('../../dist/server/index.js');
