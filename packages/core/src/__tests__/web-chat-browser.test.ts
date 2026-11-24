import { test } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { existsSync, realpathSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Sinty } from "../sinty.js";
import { createApp } from "../api/server.js";
import { policySchema } from "../config.js";
import { saveAgent, saveProject } from "../roster.js";
import { type BrowserPilotDriver } from "../browser-pilot.js";
import { tempHome, testConfig, type ScriptStep } from "./helpers.js";
const PNG="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jwN8AAAAASUVORK5CYII=";
async function setup(t: any, script: ScriptStep[], allow=false) {
 const {home}=tempHome(), calls:{tool:string;args:any}[]=[];
 const driver:BrowserPilotDriver={async prepare(args){calls.push({tool:"prepare",args});return{targetId:"synthetic-target",tabId:"synthetic-tab"}},async call(tool,args){calls.push({tool,args});return{url:"https://example.com/",content:[{type:"image",mimeType:"image/png",data:PNG}]}},async close(session){calls.push({tool:"close",args:{session}});return true}};
 const sinty=new Sinty({home,config:testConfig(script,{},["fake-provider","test-tools"]),policy:policySchema.parse({defaults:{external:allow?"allow":"ask"}}),browserPilotDriver:driver});await sinty.start();
 t.after(async()=>{await sinty.stop();await rm(home,{recursive:true,force:true,maxRetries:10,retryDelay:30})});
 const agent=saveAgent(sinty.paths,{name:"Owner selected real agent",plugins:["test-tools"]}),other=saveAgent(sinty.paths,{name:"Wrong metadata agent"}),project=saveProject(sinty.paths,{name:"Ordinary project"});
 const session=sinty.agent.createSession({projectId:project.id,metadata:{agentIds:[other.id],browserExecution:{ownerId:"forged",agentId:other.id},policyTrust:allow}});
 const app=createApp(sinty),headers={authorization:"Bearer "+sinty.secrets.get("api.token"),"content-type":"application/json"},url="http://127.0.0.1:3180/v1/sessions/"+session.id+"/messages";
 return{sinty,calls,agent,other,project,session,app,headers,url};
}
test("ordinary authenticated owner chat reaches public backend lazily, preserves other tools and image journal, uses actual selected UUID not metadata",async t=>{
 const f=await setup(t,[{toolCalls:[{name:"browser__pilot",args:{action:"prepare"}}]},{toolCalls:[{name:"browser__pilot",args:{action:"goto",url:"https://example.com/"}}]},{toolCalls:[{name:"browser__pilot",args:{action:"state"}}]},{toolCalls:[{name:"echo__say",args:{text:"ordinary tools still work"}}]},{text:"done"}]);
 assert.equal(f.calls.length,0);assert.equal(f.sinty.browserPilot.has(f.session.id),false);
 assert.equal((await f.app.request(f.url,{method:"POST",headers:{...f.headers,origin:"https://foreign.example"},body:JSON.stringify({text:"must deny",agentId:f.agent.id})})).status,403);
 assert.equal((await f.app.request(f.url,{method:"POST",headers:f.headers,body:JSON.stringify({text:"unknown",agentId:"nonexistent-agent"})})).status,400);
 const r=await f.app.request(f.url,{method:"POST",headers:f.headers,body:JSON.stringify({text:"synthetic public browser task",agentId:f.agent.id})});assert.equal(r.status,202);const {turnId}=await r.json() as any;
 const ctx=(f.sinty.agent as any).toolCtx(f.session.id,turnId,"synthetic","synthetic");assert.equal(ctx.execution.agentId,f.agent.id);assert.equal(ctx.execution.projectId,f.project.id);
 await f.sinty.agent.idle();assert.equal(f.calls[0]!.args.scope,"public");assert.equal(f.calls[1]!.args.url,"https://example.com/");
 const events=f.sinty.journal.events(f.session.id);assert.ok(events.some(e=>e.type==="tool.call.completed"&&JSON.stringify((e.data as any).result).includes("ordinary tools still work")));
 assert.ok(events.some(e=>e.type==="tool.call.completed"&&(e.data as any).blobs?.length===1));assert.ok(!JSON.stringify(events).includes(PNG));
 const panel=await f.app.request("http://127.0.0.1:3180/v1/browser-pilot",{headers:f.headers});const leases=(await panel.json() as any).leases;assert.equal(leases[0].scope,"public");assert.equal(leases[0].sessionId,f.session.id);assert.equal(leases[0].agentId,f.agent.id);
 assert.notEqual(f.calls[0]!.args.profile.name,f.sinty.browserPilot.profile("local-machine-owner",f.agent.id,f.project.id));
 assert.throws(()=>f.sinty.agent.sendOwnerChat("local-machine-owner",f.session.id,"wrong agent",{agentId:f.other.id}),/Close the current browser/);
});
test("public click requires exact action approval even when external policy is allow and chat trust is true",async t=>{
 const f=await setup(t,[{toolCalls:[{name:"browser__pilot",args:{action:"prepare"}}]},{toolCalls:[{name:"browser__pilot",args:{action:"click",ref:"#synthetic-button"}}]},{text:"done"}],true);
 f.sinty.agent.sendOwnerChat("local-machine-owner",f.session.id,"synthetic",{agentId:f.agent.id});await f.sinty.agent.idle();
 const pending=f.sinty.journal.events(f.session.id).find(e=>e.type==="tool.call.approval_requested");assert.ok(pending);assert.equal(f.calls.filter(c=>c.tool==="browser_click").length,0);
 f.sinty.agent.grantPolicyTrust(f.session.id,{kind:"human",id:"test-owner"});await f.sinty.agent.idle();assert.equal(f.calls.filter(c=>c.tool==="browser_click").length,0);
 const approval="http://127.0.0.1:3180/v1/sessions/"+f.session.id+"/approvals/"+(pending!.data as any).callId;
 assert.equal((await f.app.request(approval,{method:"POST",headers:{...f.headers,origin:"https://foreign.example"},body:JSON.stringify({decision:"approve"})})).status,403);assert.equal(f.calls.filter(c=>c.tool==="browser_click").length,0);
 assert.equal((await f.app.request(approval,{method:"POST",headers:f.headers,body:JSON.stringify({decision:"approve"})})).status,200);await f.sinty.agent.idle();assert.equal(f.calls.filter(c=>c.tool==="browser_click").length,1);
});
test("chat-selected synthetic file is the only upload granted; no arbitrary workspace file is inherited",async t=>{
 const f=await setup(t,[{toolCalls:[{name:"browser__pilot",args:{action:"prepare"}}]},{text:"done"}]);
 const data=Buffer.from("synthetic owner attachment"),hex=createHash("sha256").update(data).digest("hex");mkdirSync(join(f.sinty.paths.data,"blobs"),{recursive:true});writeFileSync(join(f.sinty.paths.data,"blobs",hex),data);
 f.sinty.agent.sendOwnerChat("local-machine-owner",f.session.id,"synthetic attachment",{agentId:f.agent.id,attachments:[{blob:("sha256:"+hex) as `sha256:${string}`,name:"synthetic.txt",mime:"text/plain",bytes:data.length}]});await f.sinty.agent.idle();
 const execution=f.sinty.browserPilot.execution("local-machine-owner",f.session.id);const prepared=await f.sinty.browserPilot.call(execution,{action:"prepare"}) as any;assert.deepEqual(prepared.ownerSelectedUploads,["_inbox/synthetic.txt"]);assert.ok(existsSync(join(execution.workspace,"_inbox","synthetic.txt")));
 await assert.rejects(f.sinty.browserPilot.call(execution,{action:"attach",ref:"input",file:"other.txt"}),/explicitly select/);
});
test("model/chat metadata alone never creates trusted browser execution",async t=>{
 const f=await setup(t,[{toolCalls:[{name:"browser__pilot",args:{action:"prepare"}}]},{text:"done"}]);f.sinty.agent.send(f.session.id,"ordinary untrusted bridge send",{agentId:f.agent.id});await f.sinty.agent.idle();assert.equal(f.calls.length,0);assert.equal(f.sinty.browserPilot.has(f.session.id),false);
});
test("owned close works after lease expiry and persistent config opt-in survives an ordinary startup without launcher flag",async t=>{
 const f=await setup(t,[{toolCalls:[{name:"browser__pilot",args:{action:"prepare"}}]},{text:"done"}]);f.sinty.agent.sendOwnerChat("local-machine-owner",f.session.id,"synthetic",{agentId:f.agent.id});await f.sinty.agent.idle();const execution=f.sinty.browserPilot.execution("local-machine-owner",f.session.id);(f.sinty.browserPilot as any).leases.get(f.session.id).expires=Date.now()-1;assert.deepEqual(await f.sinty.browserPilot.call(execution,{action:"close"}),{mode:"inactive",pending:false,released:true});assert.equal(f.calls.filter(c=>c.tool==="close").length,1);
 const {home}=tempHome();const config=testConfig([],{},["tool-browser"]);const configured=new Sinty({home,config});t.after(async()=>{await configured.stop();await rm(home,{recursive:true,force:true,maxRetries:10,retryDelay:30})});assert.equal(configured.browserPilot.ready,false);await configured.start({background:false});assert.equal(configured.browserPilot.ready,true);
});
