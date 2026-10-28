// Isolated read-only adapter for the pinned native persistence format. No agents or model services.
import {projectHistory,pageHistory} from './history-view.mjs';
import {summarizeSubmissions} from './team-project/submissions.mjs';
import {Context} from '/opt/harness/node_modules/@deepseek-ai/cordis/lib/index.js';
import Persistence from '/opt/harness/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js';
import {deriveEventMessage} from '/opt/harness/node_modules/@deepseek-ai/dsh-session/lib/index.js';
import {createInterface} from 'node:readline';
import {existsSync,readFileSync} from 'node:fs';
const stores=new Map();
function repo(key){if(!/^[a-f0-9]{24}$/.test(key))throw Error('Invalid environment');if(!existsSync('/history/'+key+'/state/sessions'))return;
 let value=stores.get(key);if(!value){const ctx=new Context();value={ctx,p:new Persistence(ctx,{root:'/history/'+key+'/state/sessions'}),cache:new Map()};stores.set(key,value);}return value;}
async function inspect(r,item){const old=r.cache.get(item.header.id);if(old?.revision===item.revision)return old.value;
 const handle=await r.p.open(item.header.id,'read');try{const {events}=await handle.read();const value=projectHistory(item.header,events,handle.inheritedEventCount,String(item.revision),deriveEventMessage);
 r.cache.set(item.header.id,{revision:item.revision,value,submissions:summarizeSubmissions(item.header,events,handle.inheritedEventCount)});if(r.cache.size>80)r.cache.delete(r.cache.keys().next().value);return value;
 }finally{await handle.close();}}
async function run(q){const r=repo(q.key);if(!r)return q.session?{missing:true}:{items:[]};
 if(q.purpose==='gallery'||q.purpose==='attachments'){const items=[],errors=[],seen=new Set();for(const item of await r.p.list()){try{const data=await inspect(r,item);for(const row of data.rows)for(const b of row.content??[]){const a=b.attachment;if(!['image','file'].includes(b.type)||!a)continue;const key=[data.id,a.attachmentId,a.name??''].join(':');if(seen.has(key))continue;seen.add(key);items.push({...a,...(q.purpose==='attachments'?{blockType:b.type,seq:row.seq,revision:data.revision}:{}),session:data.id,time:row.time,mime:b.type==='image'?'image/'+(a.mimeType?.split('/')[1]??'png'):a.mimeType});}}catch{errors.push(item.header.id);}}return {items,errors};}
 if(q.purpose==='submissions'){const items=[],errors=[];for(const item of await r.p.list()){try{await inspect(r,item);items.push(...r.cache.get(item.header.id).submissions);}catch{errors.push(item.header.id);}}return {items,errors};}
 if(q.session){const item=await r.p.stat(q.session);if(!item)return {missing:true};if(q.purpose==='evidence'){const handle=await r.p.open(q.session,'read');try{const {events}=await handle.read();return {header:item.header,events,inheritedEventCount:handle.inheritedEventCount,revision:String(item.revision)};}finally{await handle.close();}}const data=await inspect(r,item);return q.window?pageHistory(data,q.window):data;}
 const items=[];for(const item of await r.p.list()){try{const {rows,...meta}=await inspect(r,item);items.push({...meta,messageCount:rows.filter(x=>x.role).length});}catch{items.push({id:item.header.id,title:'聊天记录读取失败',error:true});}}
 let archived=[];try{archived=JSON.parse(readFileSync('/history/'+q.key+'/state/storages/workspace.json','utf8')).global?.archivedSessionIds??[];}catch{}return {items:items.map(v=>({...v,archived:archived.includes(v.id)}))};}
for await(const line of createInterface({input:process.stdin})){let q;try{q=JSON.parse(line);const data=await run(q);process.stdout.write(JSON.stringify({id:q.id,data})+'\n');}catch(e){process.stdout.write(JSON.stringify({id:q?.id,error:e.message})+'\n');}}
for(const r of stores.values())await r.ctx.fiber.dispose();
