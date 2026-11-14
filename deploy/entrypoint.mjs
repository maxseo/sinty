import fs from 'node:fs';
import p from 'node:path';
import {Sinty,Accounts,resolvePaths,startServer,initHome} from '@sinty/core';
const paths=resolvePaths();
// Idempotent: creates config/policy/secret only when missing. Never prints the machine API token.
initHome(paths.home);
const bundled=p.join(process.env.SINTY_INSTALL_ROOT||'','skills');
if(process.env.SINTY_INSTALL_ROOT&&fs.existsSync(bundled)){
  function seed(a,z){for(const e of fs.readdirSync(a,{withFileTypes:true})){const x=p.join(a,e.name),y=p.join(z,e.name);if(e.isDirectory())seed(x,y);else if(!fs.existsSync(y)){fs.mkdirSync(p.dirname(y),{recursive:true});fs.copyFileSync(x,y);}}}
  seed(bundled,paths.skills);
}
const origin=process.env.SINTY_PUBLIC_ORIGIN;
if(!origin||new URL(origin).protocol!=='https:'){console.error('SINTY_PUBLIC_ORIGIN must be the HTTPS app subdomain.');process.exit(2);}
const accounts=new Accounts(paths.accounts),ready=accounts.hasUsers();accounts.close();
// Existing home/config is authoritative. No plugin enable list or user credentials are imported.
const sinty=new Sinty({log:(level,message)=>{if(level==='error'||level==='warn')console.error(`[${level}] ${message}`);}});
let stopping=false;async function stop(){if(stopping)return;stopping=true;await sinty.stop();process.exit(0);}
process.once('SIGTERM',()=>void stop());process.once('SIGINT',()=>void stop());
try{
  const started=await sinty.start();
  const {server}=await startServer(sinty,{host:'0.0.0.0',port:3180});
  if(!ready)console.log('Sinty ready; first-run setup is open until one superadmin is created; no login/API token is printed.');
  else console.log(`Sinty ready; ${started.failedPlugins.length} plugin startup failures; no login/API token is printed.`);
  process.once('SIGTERM',()=>server.close());
  process.once('SIGINT',()=>server.close());
}catch(e){console.error('Sinty startup failed; inspect private home/config and dependencies.');if(e instanceof Error&&e.message)console.error(e.message);process.exitCode=1;await sinty.stop();}
