import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {hash,requireThat,type Store,type Doc} from './store.ts';
import {generationLinks,sameScope,nativeSessionFor} from './generation-links.ts';
import {summarizeSubmissions} from '../native-harness/team-project/submissions.mjs';
const working=new Set(['queued','preparing','submitting','running','downloading','checking']);
const attention=new Set(['failed','blocked','submission_unknown','download_failed','qa_failed','interrupted','termination_unconfirmed']);
export function memberSubmissions(store:Store,user:Doc,query=new URLSearchParams(),history:{items:Doc[];warnings?:string[]}={items:[]}) {
 const users=store.all('user').filter(u=>user.role==='admin'||u.id===user.id),projects=store.all('project');
 const permitted=new Set(users.map(u=>u.id)),links=generationLinks(store),items:Doc[]=[],native=new Map<string,Doc>();let indexedAt=0;
 const keyOf=(t:Doc)=>JSON.stringify([t.owner,t.project??'shared',t.session,t.messageId]);
 const addNative=(t:Doc)=>{if(!permitted.has(t.owner)||!projects.some(p=>p.id===t.project)||!t.messageId)return;native.set(keyOf(t),{...t,id:hash(keyOf(t)),source:'native',nativeSession:t.session});};
 for(const u of users)for(const p of projects){
  const key=hash(JSON.stringify([u.id,p.id])).slice(0,24),file=join(store.root,'native-harness',key,'state/team-submissions.json');
  if(!existsSync(file))continue;
  try{const index=JSON.parse(readFileSync(file,'utf8'));if(index.version!==1||!Array.isArray(index.items))continue;indexedAt=Math.max(indexedAt,index.at);
   for(const t of index.items)addNative({...t,messageId:t.id,owner:u.id,project:p.id,state:working.has(t.state)&&Date.now()-index.at>15000?'unconfirmed':t.state});
  }catch{}
 }
 // Official persistence summaries also cover sleeping accounts and missing indexes.
 for(const t of history.items)addNative(t);
 const tasks=store.all('task').filter(t=>permitted.has(t.owner)),legacyMessages=new Set<string>();
 for(const t of tasks){const saved=t.session?store.get('harness',t.session):undefined;if(saved?.events){for(const message of summarizeSubmissions({...saved.header,id:nativeSessionFor(store,t)},saved.events))legacyMessages.add(keyOf({owner:t.owner,project:t.project??'shared',session:nativeSessionFor(store,t),messageId:message.id}));}
  items.push({id:t.id,owner:t.owner,project:t.project??'shared',session:t.session,nativeSession:nativeSessionFor(store,t),prompt:t.prompt??'提交任务',created:t.created,state:t.state,source:'legacy',change:t.change});
 }
 // A generation receipt can recover its actual human source, but a tool call
 // without a source message never becomes an invented member submission.
 for(const a of links.audits){if(!permitted.has(a.owner)||native.has(keyOf(a))||legacyMessages.has(keyOf(a))||!a.prompt)continue;
  addNative({...a,state:'unconfirmed',recoveredFrom:'generation-receipt'});
 }
 items.push(...[...native].filter(([key])=>!legacyMessages.has(key)).map(([,t])=>t));
 const assigned=new Map(items.map(t=>[t.id,[] as Doc[]]));
 for(const job of links.jobs){if(!permitted.has(job.owner))continue;const plan=links.planFor(job),scope=items.filter(t=>sameScope(t,job));
  const sources=links.audits.filter(a=>a.planId===(job.plan??job.planId??job.pickup)&&sameScope(a,job));
  // Prefer a precise native source message; fall back to the original task on
  // the plan. Each job is assigned once, including retries and revisions.
  const target=scope.find(t=>t.source==='native'&&sources.some(a=>a.session===t.session&&a.messageId===t.messageId))
   ??scope.find(t=>t.source==='legacy'&&(t.id===job.task||t.id===plan?.task));
  if(target)assigned.get(target.id)!.push(job);
 }
 for(const item of items){const owner=users.find(u=>u.id===item.owner),p=projects.find(p=>p.id===item.project);item.ownerName=owner?.name??'成员';item.username=owner?.username;item.projectName=p?.name??'项目';
  const related=assigned.get(item.id)!;
  item.results=related.map(j=>{const plan=links.planFor(j);const shot=plan?.shots?.find((s:Doc)=>s.source?.id===j.sourceId);const measured=Number(j.technicalQA?.duration),requested=Number(shot?.params?.seconds??plan?.params?.seconds);
   return {id:j.id,kind:j.kind,state:j.state,mediaId:j.mediaId,model:j.model?.name??j.modelName??plan?.model?.name,created:j.created,round:j.round,seconds:j.kind==='video'?(Number.isFinite(measured)&&measured>0?measured:Number.isFinite(requested)&&requested>0?requested:null):null,durationSource:Number.isFinite(measured)&&measured>0?'measured':'requested'};});
  item.chatState=item.state;
  if(related.length){
   if(related.some(j=>attention.has(j.state)))item.state='attention';
   else if(related.some(j=>working.has(j.state)))item.state=related.some(j=>j.state!=='queued'&&working.has(j.state))?'running':'queued';
   else if(related.every(j=>j.state==='cancelled'))item.state='cancelled';
   else if(related.every(j=>['ready','adopted'].includes(j.state)))item.state='completed';
   else if(related.every(j=>['ready','adopted','cancelled'].includes(j.state)))item.state='partial';
   else item.state='unconfirmed';
  }
 }
 const videoSummary=(rows:Doc[])=>{const videos=[...new Map(rows.flatMap(t=>t.results).filter(r=>r.kind==='video'&&r.mediaId).map(r=>[r.id,r])).values()];return {videoCount:videos.length,videoSeconds:Math.round(videos.reduce((n,r)=>n+(r.seconds??0),0)*100)/100,unknownDurations:videos.filter(r=>r.seconds==null).length};};
 const q=(query.get('q')??'').trim().toLowerCase(),owner=query.get('owner')??'',state=query.get('state')??'all';
 requireThat(['all','active','completed','attention','cancelled','partial'].includes(state),'任务筛选无效');
 const filtered=items.filter(t=>(!owner||t.owner===owner)&&(!q||[t.prompt,t.ownerName,t.projectName].join(' ').toLowerCase().includes(q))&&(state==='all'||['cancelled','partial'].includes(state)&&t.state===state||state==='active'&&working.has(t.state)||state==='completed'&&['completed','committed','approved'].includes(t.state)||state==='attention'&&(attention.has(t.state)||['attention','unconfirmed','conflict'].includes(t.state)))).sort((a,b)=>String(a.ownerName).localeCompare(String(b.ownerName),'zh-CN')||String(b.created).localeCompare(String(a.created))||a.id.localeCompare(b.id));
 const counts={total:items.length,active:items.filter(t=>working.has(t.state)).length,completed:items.filter(t=>['completed','committed','approved'].includes(t.state)).length,cancelled:items.filter(t=>t.state==='cancelled').length,partial:items.filter(t=>t.state==='partial').length,attention:items.filter(t=>attention.has(t.state)||['attention','unconfirmed','conflict'].includes(t.state)).length};
 const page=Number(query.get('page')??1),pageSize=30;requireThat(Number.isInteger(page)&&page>0,'页码无效');
 return {warnings:history.warnings??[],summary:{...counts,...videoSummary(items)},indexedAt,groups:users.map(u=>({id:u.id,name:u.name,active:u.active,...videoSummary(items.filter(t=>t.owner===u.id)),total:items.filter(t=>t.owner===u.id).length,running:items.filter(t=>t.owner===u.id&&working.has(t.state)).length})).filter(g=>g.total>0),items:filtered.slice((page-1)*pageSize,page*pageSize),pagination:{page,pageSize,total:filtered.length,pages:Math.max(1,Math.ceil(filtered.length/pageSize))}};
}
