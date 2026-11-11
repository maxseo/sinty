import fs from 'node:fs';
import p from 'node:path';
import readline from 'node:readline/promises';
import {initHome,Accounts,resolvePaths} from '@sinty/core';
if(!process.stdin.isTTY||!process.stdout.isTTY){console.error('Bootstrap requires an interactive terminal; no passwords via argv/env/logs.');process.exit(2);}
const paths=resolvePaths();
// initHome is idempotent and does not start Sinty, agents, plugins or model calls.
initHome(paths.home);
const bundled=p.join(process.env.SINTY_INSTALL_ROOT,'skills');let conflicts=0;
function seed(a,z){for(const e of fs.readdirSync(a,{withFileTypes:true})){const x=p.join(a,e.name),y=p.join(z,e.name);if(e.isDirectory())seed(x,y);else if(fs.existsSync(y)){if(!fs.readFileSync(x).equals(fs.readFileSync(y)))conflicts++;}else{fs.mkdirSync(p.dirname(y),{recursive:true});fs.copyFileSync(x,y);}}}seed(bundled,paths.skills);
const accounts=new Accounts(paths.accounts);if(accounts.hasUsers()){accounts.close();console.log(`Existing accounts kept. Skill conflicts not overwritten: ${conflicts}.`);process.exit(0);}
const rl=readline.createInterface({input:process.stdin,output:process.stdout});const email=(await rl.question('Administrator login/email: ')).trim();rl.close();
async function hidden(prompt){process.stdout.write(prompt);process.stdin.setRawMode(true);process.stdin.resume();return new Promise((resolve,reject)=>{let text='';function done(error){process.stdin.off('data',onData);process.stdin.setRawMode(false);process.stdin.pause();process.stdout.write('\n');error?reject(error):resolve(text);}function onData(buf){for(const c of buf.toString()){if(c==='\u0003')return done(Error('cancelled'));if(c==='\r'||c==='\n')return done();if(c==='\u007f'||c==='\b')text=text.slice(0,-1);else if(c>=' ')text+=c;}}process.stdin.on('data',onData);});}
try{const password=await hidden('Password (hidden): '),again=await hidden('Repeat password: ');if(password!==again)throw Error('passwords differ');accounts.setup({email,password});console.log(`Administrator created locally. Skill conflicts not overwritten: ${conflicts}. No API tokens were printed.`);}catch{console.error('Bootstrap not completed; existing files were kept. Retry interactively.');process.exitCode=2;}finally{accounts.close();}
