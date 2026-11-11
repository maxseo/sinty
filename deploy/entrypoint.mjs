import fs from 'node:fs';
import p from 'node:path';
import {Sinty,Accounts,resolvePaths,startServer} from '@sinty/core';
const paths=resolvePaths(),required=[paths.config,paths.policy,paths.secretKey];
if(required.some(f=>!fs.existsSync(f))){console.error('Sinty home is not initialized; run the documented offline bootstrap first.');process.exit(2);}
const accounts=new Accounts(paths.accounts),ready=accounts.hasUsers();accounts.close();
if(!ready){console.error('No staff administrator exists; run the documented offline bootstrap before exposing the proxy.');process.exit(2);}
const origin=process.env.SINTY_PUBLIC_ORIGIN;
if(!origin||new URL(origin).protocol!=='https:'){console.error('SINTY_PUBLIC_ORIGIN must be the HTTPS app subdomain.');process.exit(2);}
// Existing home/config is authoritative. No plugin enable list or user credentials are imported.
const sinty=new Sinty({log:(level,message)=>{if(level==='error'||level==='warn')console.error(`[${level}] ${message}`);}});
let stopping=false;async function stop(){if(stopping)return;stopping=true;await sinty.stop();process.exit(0);}
process.once('SIGTERM',()=>void stop());process.once('SIGINT',()=>void stop());
try{const started=await sinty.start();const {server}=await startServer(sinty,{host:'0.0.0.0',port:3180});console.log(`Sinty 0.5.1 ready; ${started.failedPlugins.length} plugin startup failures; no login/API token is printed.`);process.once('SIGTERM',()=>server.close());process.once('SIGINT',()=>server.close());}catch{console.error('Sinty startup failed; inspect private home/config and dependencies.');process.exitCode=1;await sinty.stop();}
