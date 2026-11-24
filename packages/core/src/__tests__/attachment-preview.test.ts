import {test} from "node:test";
import assert from "node:assert/strict";
import {join} from "node:path";
import {writeFileSync,readFileSync,linkSync,renameSync,symlinkSync,unlinkSync,openSync,ftruncateSync,closeSync} from "node:fs";
import {Sinty} from "../sinty.js";
import {createApp} from "../api/server.js";
import {saveBlob} from "../blobs.js";
import {ATTACHMENT_PREVIEW_MAX} from "../attachment-preview.js";
import {tempHome} from "./helpers.js";
const png=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=","base64");
function seed(s:Sinty,session:string,attachments:unknown[]){return s.journal.append({sessionId:session,type:"message.user",actor:{kind:"human",id:"fixture"},data:{text:"Retained image",attachments} as never})}
const endpoint=(id:string,seq:number,index=0)=>"/v1/sessions/"+id+"/attachments/"+seq+"/"+index;
test("saved user image: authenticated exact session/event/index, sniffed MIME, private headers and no auth token URL",async()=>{
 const {home,cleanup}=tempHome();const s=new Sinty({home});try{const app=createApp(s),headers={authorization:"Bearer "+s.secrets.get("api.token")},session=s.agent.createSession({title:"photo"}),ref=saveBlob(s.paths.data,{bytes:png,mime:"text/html",name:"photo.png"}),event=seed(s,session.id,[ref]),url=endpoint(session.id,event.seq!);
 assert.equal((await app.request(url)).status,401);assert.equal((await app.request(url+"?token="+s.secrets.get("api.token"))).status,401);
 const r=await app.request(url,{headers});assert.equal(r.status,200);assert.equal(r.headers.get("content-type"),"image/png");assert.equal(r.headers.get("cache-control"),"private, no-store");assert.equal(r.headers.get("x-content-type-options"),"nosniff");assert.equal(r.headers.get("cross-origin-resource-policy"),"same-origin");assert.deepEqual(Buffer.from(await r.arrayBuffer()),png);
 const other=s.agent.createSession({title:"different"});seed(s,other.id,[]);assert.equal((await app.request(endpoint(other.id,event.seq!),{headers})).status,404);assert.equal((await app.request(endpoint(session.id,event.seq!,1),{headers})).status,404);assert.equal((await app.request(endpoint(session.id,999),{headers})).status,404);
 }finally{await s.stop();cleanup()}
});
test("session visibility and revoked role grants authorize image reads, not global blob possession",async()=>{
 const {home,cleanup}=tempHome();const s=new Sinty({home});try{const app=createApp(s);s.accounts.setup({email:"root@fixture.invalid",password:"fixture-password"});const role=s.accounts.createRole("no chats"),user=s.accounts.createUser({email:"viewer@fixture.invalid",password:"fixture-password",roleId:role.id}),login=s.accounts.login("viewer@fixture.invalid","fixture-password"),headers={authorization:"Bearer "+login.token},session=s.agent.createSession({title:"private"}),ref=saveBlob(s.paths.data,{bytes:png,mime:"image/png"}),e=seed(s,session.id,[ref]),url=endpoint(session.id,e.seq!);
 assert.equal((await app.request(url,{headers})).status,403);s.accounts.saveGrants(role.id,[{resource:"nav:chats",view:true,add:false,edit:false,delete:false}]);assert.equal((await app.request(url,{headers})).status,200);const hidden=s.journal.createSession("hidden-project-session",{title:"project photo",projectId:"hidden-project"}),hiddenEvent=seed(s,hidden.id,[ref]);assert.equal((await app.request(endpoint(hidden.id,hiddenEvent.seq!),{headers})).status,403,"chat rights do not grant project image access");s.accounts.saveGrants(role.id,[{resource:"nav:chats",view:false,add:false,edit:false,delete:false}]);assert.equal((await app.request(url,{headers})).status,403);
 }finally{await s.stop();cleanup()}
});
test("previews refuse SVG/HTML, tampered hash, oversized sparse file and hardlinks",async()=>{
 const {home,cleanup}=tempHome();const s=new Sinty({home});try{const app=createApp(s),headers={authorization:"Bearer "+s.secrets.get("api.token")},session=s.agent.createSession({title:"unsafe"});const svg=saveBlob(s.paths.data,{bytes:Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),mime:"image/png"}),ref=saveBlob(s.paths.data,{bytes:png,mime:"image/png"}),e=seed(s,session.id,[svg,ref,{blob:"sha256:"+"0".repeat(64),mime:"image/png",bytes:1},{blob:"../../secret.key",mime:"image/png",bytes:1}]);
 assert.equal((await app.request(endpoint(session.id,e.seq!,0),{headers})).status,404);assert.equal((await app.request(endpoint(session.id,e.seq!,3),{headers})).status,404);
 const sparse=join(s.paths.data,"blobs","0".repeat(64)),fd=openSync(sparse,"w");ftruncateSync(fd,ATTACHMENT_PREVIEW_MAX+1);closeSync(fd);assert.equal((await app.request(endpoint(session.id,e.seq!,2),{headers})).status,404);
 const file=join(s.paths.data,"blobs",ref.blob.slice(7));writeFileSync(file,Buffer.concat([png,Buffer.from("tampered")]));assert.equal((await app.request(endpoint(session.id,e.seq!,1),{headers})).status,404);writeFileSync(file,png);linkSync(file,join(home,"second-link"));assert.equal((await app.request(endpoint(session.id,e.seq!,1),{headers})).status,404);
 }finally{await s.stop();cleanup()}
});
test("preview store junction is not followed",async()=>{
 const {home,cleanup}=tempHome();const s=new Sinty({home});let linked=false;const dir=join(s.paths.data,"blobs");try{const app=createApp(s),headers={authorization:"Bearer "+s.secrets.get("api.token")},session=s.agent.createSession({title:"link"}),ref=saveBlob(s.paths.data,{bytes:png,mime:"image/png"}),e=seed(s,session.id,[ref]);renameSync(dir,dir+"-real");symlinkSync(dir+"-real",dir,process.platform==="win32"?"junction":"dir");linked=true;assert.equal((await app.request(endpoint(session.id,e.seq!),{headers})).status,404)}finally{if(linked){unlinkSync(dir);renameSync(dir+"-real",dir)}await s.stop();cleanup()}
});
test("real SQLite history and images survive reopening the same fixture home",async()=>{
 const {home,cleanup}=tempHome();let s=new Sinty({home});try{const session=s.agent.createSession({title:"history"}),ref=saveBlob(s.paths.data,{bytes:png,mime:"image/png",name:"retained.png"}),e=seed(s,session.id,[ref]);await s.stop();s=new Sinty({home});const app=createApp(s),headers={authorization:"Bearer "+s.secrets.get("api.token")};const history=await(await app.request("/v1/sessions/"+session.id+"/events",{headers})).json() as {events:{data:{attachments?:unknown[]}}[]};assert.deepEqual(history.events.find(x=>x.data.attachments)?.data.attachments,[ref]);const r=await app.request(endpoint(session.id,e.seq!),{headers});assert.equal(r.status,200);assert.deepEqual(Buffer.from(await r.arrayBuffer()),png)}finally{await s.stop();cleanup()}
});
