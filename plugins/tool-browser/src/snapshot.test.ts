import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserType } from "playwright";
import { WebToolsPilotDriver, publicWebUrl } from "./persistent.js";
async function setup(options: { unstableOnce?: boolean; closed?: boolean } = {}){
 let snapshots=0;
 const root=realpathSync(mkdtempSync(join(tmpdir(),"sinty-public-mock-"))),workspace=join(root,"project");mkdirSync(workspace);let route:any,ws:any,current="about:blank",launches=0;const checked:string[]=[];
 const check=async(raw:string)=>{checked.push(raw);const u=new URL(raw);if(!["example.com","cdn.example.com"].includes(u.hostname))throw Object.assign(Error("synthetic private/mixed DNS blocked"),{code:"net_blocked"})};
 const element={getAttribute:(k:string)=>k==="href"?"https://example.com/next":k==="aria-label"?"Synthetic link":null,innerText:"synthetic"};
 const page={isClosed:()=>!!options.closed,setDefaultTimeout(){},setDefaultNavigationTimeout(){},url:()=>current,goto:async(url:string)=>{current=url},close:async()=>{},title:async()=>"Synthetic public page",screenshot:async()=>Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6SMsAAAAASUVORK5CYII=","base64"),locator:()=>({evaluate:async(fn:any)=>{snapshots++;if(options.closed || options.unstableOnce && snapshots===1)throw Error("Timeout 3000ms exceeded in synthetic DOM snapshot");return fn({ownerDocument:{title:"Synthetic public page"},innerText:"synthetic public text",querySelectorAll:()=>[element]})},all:async()=>{throw Error("sequential live locators must not be used") },innerText:async()=>"synthetic public text",click:async()=>{},fill:async()=>{},selectOption:async()=>{}})};
 const context={route:async(_:string,fn:any)=>{route=fn},routeWebSocket:async(_:string,fn:any)=>{ws=fn},pages:()=>[page],on(){},once(){},close:async()=>{}};
 const driver=new WebToolsPilotDriver({profiles:join(root,"profiles"),checkPublicUrl:check,proxy:async(origin)=>{assert.equal(origin,"");return{server:"http://127.0.0.1:45679",username:"synthetic",password:"synthetic"}},launcher:{launchPersistentContext:async(_dir:any,options:any)=>{launches++;assert.equal(options.proxy.bypass,"<-loopback>");assert.equal(options.serviceWorkers,"block");return context}} as unknown as Pick<BrowserType,"launchPersistentContext">});
 const args={allow_launch:true as const,scope:"public" as const,profile:{mode:"isolated_named" as const,name:"sinty-"+"b".repeat(48)},session:"synthetic-public",workspace},target=await driver.prepare(args,new AbortController().signal),base={session:args.session,target_id:target.targetId,tab_id:target.tabId};
 return{driver,base,checked,snapshots:()=>snapshots,launches:()=>launches,route:async(url:string,method="GET")=>{let result="";await route({request:()=>({url:()=>url,method:()=>method}),continue:async()=>{result="continue"},abort:async()=>{result="abort"}});return result},ws:async()=>{let closed=false;await ws({close:()=>{closed=true}});return closed},cleanup:async()=>{await driver.stop();rmSync(root,{recursive:true,force:true})}};
}

test("single bounded DOM snapshot timeout is typed and retry succeeds in the same owned context",async()=>{const s=await setup({unstableOnce:true});try{await assert.rejects(s.driver.call("get_browser_state",s.base,new AbortController().signal),{code:"snapshot_timeout"});const state=await s.driver.call("get_browser_state",s.base,new AbortController().signal) as any;assert.equal(state.controls.length,1);assert.equal(s.snapshots(),2);assert.equal(s.launches(),1)}finally{await s.cleanup()}});
test("a closed browser is never misreported as a recoverable healthy snapshot",async()=>{const s=await setup({closed:true});try{await assert.rejects(s.driver.call("get_browser_state",s.base,new AbortController().signal),(e:any)=>e.code!=="snapshot_timeout"&&e.code!=="snapshot_unstable")}finally{await s.cleanup()}});
