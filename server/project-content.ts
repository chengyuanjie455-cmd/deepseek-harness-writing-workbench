import {generationInputWithImpact} from './generation-input-impact.ts';
import {privateSkillDefinitionStatus} from './private-skill-definition.ts';
import {AssemblySourceProvenance} from './assembly-source-provenance.ts';
import {applyAssignment,assignmentSet} from '../shared/project-assignments.ts';
import type {NativeAttachments,AttachmentSnapshot} from './native-attachments.ts';
import {setImmediate as yieldTurn} from 'node:timers/promises';
import {basename} from 'node:path';
import {Projects} from './project.ts';
import {Store,hash,id,now,requireThat,type Doc} from './store.ts';
import {documentText} from './document-text.ts';
import {projectSection,assetType,episodeKey,buildStudioCatalogue} from '../shared/project-studio.ts';
import {privateSkillRedactor} from './private-skill-content.ts';
import {fileURLToPath} from 'node:url';
import {adoptedMediaIds} from './media.ts';
import {shotView,shotEntityId,shotRelationship,duplicateShotIdentities} from './shot-identity.ts';
const normalized=(s:string)=>s.normalize('NFC').toLocaleLowerCase();
const sections=['scripts','storyboards','assets','videos','edits','files'];
const INDEX_VERSION=17,chunkSize=4000,overlap=256;
/** A rebuildable read index over existing originals and immutable generation
 * records. File identity is durable; search rows are never a second project
 * source and never authorize generation, adoption or access to another user. */
export class ProjectContent {
 private initialized=false;private closing=false;private flight?:Promise<void>;private attachmentFlights=new Map<string,Promise<void>>();
 constructor(public store:Store,public projects:Projects,private extract:typeof documentText=documentText,public attachments?:NativeAttachments,private currentSkill:()=>Doc=privateSkillDefinitionStatus){}
 private schema(){if(this.initialized)return;this.store.db.exec(`
 CREATE TABLE IF NOT EXISTS project_content_entities(project TEXT NOT NULL,id TEXT NOT NULL,owner TEXT NOT NULL,signature TEXT NOT NULL,metadata TEXT NOT NULL,PRIMARY KEY(project,id));
 CREATE TABLE IF NOT EXISTS project_content_passages(id INTEGER PRIMARY KEY,project TEXT NOT NULL,entity TEXT NOT NULL,body TEXT NOT NULL,start INTEGER NOT NULL,search_text TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS project_content_passage_owner ON project_content_passages(project,entity);
 CREATE VIRTUAL TABLE IF NOT EXISTS project_content_fts USING fts5(text,tokenize='trigram');`);this.initialized=true;}
 private check(user?:Doc){requireThat(!this.closing,'项目检索正在关闭，请稍后重试',503);if(user){const current=this.store.get('user',user.id);requireThat(current?.active&&current.role===user.role,'登录身份已变更',403);}requireThat(this.store.get('project',this.projects.projectId),'项目不存在',404);}
 private input(){const project=this.projects.current(),revision=project.revision,projectName=project.name,ownerNames=Object.fromEntries(this.store.all('user').map(u=>[u.id,u.name])),files=this.projects.files(revision),media=this.store.all('media'),plans=[...this.store.all('pickup'),...this.store.all('image-plan')],jobs=[...this.store.all('video-job'),...this.store.all('image-job')],checks=this.store.all('media-check'),sharedMedia=[...adoptedMediaIds(this.store)];return {revision,projectName,ownerNames,files,media,plans,jobs,checks,sharedMedia,observedAt:now(),stamp:hash(JSON.stringify({schema:INDEX_VERSION,sharedMedia,revision,projectName,ownerNames,checks:checks.map(c=>[c.id,c.sha256,c.result?.frames?.map((f:Doc)=>f.mediaId)]),media:media.map(m=>[m.id,m.owner,m.scope,m.name,m.mime,m.bytes,m.sha256,m.attachmentPath,m.generated,m.internalDerived,m.derivedFrom,m.assemblyId,m.episode,m.sourceMediaIds]),plans:plans.map(p=>[p.id,p.owner,p.nativeSession,p.prompt,p.script,p.notes,p.parsed,p.shots]),jobs:jobs.filter(j=>j.mediaId).map(j=>[j.id,j.owner,j.plan,j.planId,j.pickup,j.mediaId,j.sourceId,j.prompt,j.round,j.state,j.technicalQA?.frames])}))};}
 async ensure(){this.check();this.schema();if(this.flight)return this.flight;const work=(async()=>{for(let n=0;n<3;n++){const source=this.input(),old=this.store.get('project-content-index',this.projects.projectId);let healthy=false;if(old?.stamp===source.stamp&&old.schemaVersion===INDEX_VERSION){try{const e=this.store.db.prepare("SELECT COUNT(*) n FROM project_content_entities WHERE project=? AND id NOT LIKE 'attachment:%'").get(this.projects.projectId) as Doc,p=this.store.db.prepare("SELECT COUNT(*) n FROM project_content_passages WHERE project=? AND entity NOT LIKE 'attachment:%'").get(this.projects.projectId) as Doc,f=this.store.db.prepare("SELECT COUNT(*) n FROM project_content_fts JOIN project_content_passages p ON p.id=project_content_fts.rowid WHERE p.project=? AND p.entity NOT LIKE 'attachment:%'").get(this.projects.projectId) as Doc;healthy=e.n===old.items&&p.n===old.passages&&f.n===old.passages;}catch(error:any){if(!/no such table: project_content/.test(error.message))throw error;this.initialized=false;this.schema();}}if(healthy)return;await this.rebuild(source,old?.stamp===source.stamp);if(this.projects.current().revision===source.revision)return;}throw Error('项目资料仍在更新，请稍后重试；原件未改变');})();this.flight=work;try{await work;}finally{if(this.flight===work)this.flight=undefined;}}
 private async rebuild(source:ReturnType<ProjectContent['input']>,force=false){
  const project=this.projects.projectId,registry=this.store.all('project-content-file'),byPath=new Map(registry.filter(r=>r.state!=='missing').map(r=>[r.path,r])),paths=new Set(source.files.map(f=>f.path));
  const removed=registry.filter(r=>r.state!=='missing'&&!paths.has(r.path)),newByDigest=new Map<string,Doc[]>();for(const f of source.files)if(!byPath.has(f.path))newByDigest.set(f.digest,[...(newByDigest.get(f.digest)??[]),f]);
  const records:Doc[]=[],fileIds=new Map<string,Doc>();
  for(const f of source.files){let old=byPath.get(f.path)??registry.find(r=>r.state==='missing'&&r.path===f.path);const candidates=removed.filter(r=>r.digest===f.digest);
   if(!old&&candidates.length===1&&newByDigest.get(f.digest)?.length===1)old=candidates[0];
   const entityId=old?.id??id(),record={...old,id:entityId,project,path:f.path,digest:f.digest,state:'current',paths:[...new Set([...(old?.paths??[]),f.path])],created:old?.created??now(),updated:now()};records.push(record);fileIds.set(f.path,record);
  }
  // An optional existing index enriches links; it is never required to upload,
  // search, chat or generate. Corrupt/ambiguous data stays explicitly unlinked.
  const warnings:string[]=[],indexShots:Doc[]=[],indexAssignments:Doc[]=[];
  for(const f of source.files.filter(f=>/(^|\/)补抽索引\.json$/.test(f.path))){try{let text='',offset=0;do{const p=await this.extract(this.store.root,f.digest,f.path,offset,32000);this.check();text+=p.content;if(p.nextOffset===null)break;requireThat(p.nextOffset>offset,'关联索引分页未前进');offset=p.nextOffset;}while(true);const index=JSON.parse(text);requireThat(Array.isArray(index.shots),'镜头关联信息缺失');const assigned=assignmentSet(index.contentAssignments);indexAssignments.push(...assigned.items);warnings.push(...assigned.warnings);indexShots.push(...index.shots.filter((s:unknown)=>s&&typeof s==='object'&&!Array.isArray(s)));if(indexShots.length!==index.shots.length)warnings.push('索引中有不完整的镜头行，已保留资料，未据此建立关联。');}catch{warnings.push('部分已有镜头索引未能读取；相关资料仍可按正文检索，未猜测关联。');}}
  const definitions=new Map<string,Set<string>>();for(const s of indexShots)if(s.id)definitions.set(s.id,new Set([...(definitions.get(s.id)??[]),JSON.stringify(s)]));const ambiguous=new Set([...definitions].filter(([,v])=>v.size>1).map(([key])=>key));if(ambiguous.size)warnings.push('存在重复且内容不同的镜头编号，未合并这些关联。');
  // Resolve only the read projection. Frozen project-index paths/revisions and
  // already submitted generation inputs remain unchanged. An identity plus
  // exact bytes survives a rename; equal bytes in ambiguous copies do not.
  const resolveReference=(ref:Doc,shotId:unknown):Doc=>{
   if(!ref||typeof ref.path!=='string')return ref;
   // A file descriptor's logical asset id is not an additional file path.
   // Preserve it in the frozen source, but never use that alias to bind copies.
   const projection={...ref,id:undefined,file:undefined};
   const named=ref.entityId===undefined?undefined:String(ref.entityId).replace(/^file:/,'');
   if(named===undefined&&ref.sha256===undefined)return {...projection,path:fileIds.has(ref.path)?ref.path:undefined};
   const candidates=records.filter(r=>(named!==undefined?r.id===named:r.path===ref.path||r.paths.includes(ref.path))&&(!ref.sha256||r.digest===ref.sha256));
   if(candidates.length===1)return {...projection,path:candidates[0].path};
   warnings.push(candidates.length>1?'镜头 '+String(shotId)+' 的来源对应多份原件，未猜测关联。':'镜头 '+String(shotId)+' 的来源绑定了已有版本，未将新文件冒充为原关联版本。');
   return {...projection,path:undefined};
  };
  const duplicateEntities=duplicateShotIdentities(project,indexShots);if(duplicateEntities.size)warnings.push('镜头稳定编号重复，未将这些原件关联到不明确的镜头。');
  const reliableShots=[...new Map(indexShots.filter(s=>!ambiguous.has(s.id)&&!duplicateEntities.has(shotEntityId(project,s))).map(s=>[shotEntityId(project,s),s])).values()].map(s=>{
   const row=shotView(project,s);for(const kind of ['script','storyboard'])if(row[kind+'Path']){const ref=resolveReference({path:row[kind+'Path'],sha256:row[kind+'SHA256'],entityId:row[kind+'EntityId']},row.id);row[kind+'Path']=ref.path;}
   for(const field of ['assets','outputs'])if(Array.isArray(row[field]))row[field]=row[field].map((ref:Doc)=>resolveReference(ref,row.id));return row;
  });
  const assignmentInfo=assignmentSet(indexAssignments),assignments=assignmentInfo.items;warnings.push(...assignmentInfo.warnings);for(const a of assignments)if(a.reference.path){const f=records.find(r=>a.reference.entityId?r.id===a.reference.entityId:r.path===a.reference.path);if(!f||f.digest!==a.reference.sha256)warnings.push('有资料归类绑定了旧版原件，未将当前新文件冒充该版本。');}
  const boundFile=(s:Doc,path:string,digest:string)=>(s.scriptPath===path&&(!s.scriptSHA256||s.scriptSHA256===digest))||(s.storyboardPath===path&&(!s.storyboardSHA256||s.storyboardSHA256===digest))||[...(s.assets??[]),...(s.outputs??[])].some((a:Doc)=>a.path===path&&(!a.sha256||a.sha256===digest));
  const rows=buildStudioCatalogue(source.files.map(f=>({...f,entityId:fileIds.get(f.path)!.id})),[],[],{shots:reliableShots,contentAssignments:assignments},source.projectName),items:Doc[]=rows.map(v=>{const f=fileIds.get(v.path)!;return {...v,id:'file:'+f.id,entityId:f.id,versionId:hash(JSON.stringify([f.id,v.digest])),revision:source.revision,sha256:v.digest,scope:'project',owner:'',relationships:reliableShots.filter(s=>boundFile(s,v.path,v.digest)).map(s=>shotRelationship(project,s)),episodeEvidence:v.episodeEvidence==='explicit'||reliableShots.some(s=>boundFile(s,v.path,v.digest))?'explicit':v.episodes.length?'filename_hint':'unassigned'};});
  const planById=new Map(source.plans.map(p=>[p.id,p])),byMedia=new Map<string,Doc>(),frames=new Set<string>(),used=new Set<string>();
  for(const job of source.jobs){for(const frame of job.technicalQA?.frames??[])frames.add(frame.mediaId);if(job.mediaId)byMedia.set(job.mediaId,job);}
  for(const check of source.checks)for(const frame of check.result?.frames??[])frames.add(frame.mediaId);
  for(const p of source.plans)for(const shot of p.shots??[p])for(const a of shot.assets??[])if(a.mediaId)used.add(JSON.stringify([p.owner,a.mediaId]));for(const shot of reliableShots)for(const a of shot.assets??[]){const m=source.media.find(m=>m.id===a.mediaId);if(m)used.add(JSON.stringify([m.owner,m.id]));}
  for(const m of source.media){if((m.internalDerived==='video_qa_frame'||frames.has(m.id))&&!used.has(JSON.stringify([m.owner,m.id])))continue;if(m.attachmentPath&&this.projects.revision(source.revision).manifest[m.attachmentPath]!==m.sha256)continue;
   const job=byMedia.get(m.id),candidate=job?planById.get(job.plan??job.planId??job.pickup):undefined,p=candidate&&candidate.owner===job!.owner?candidate:undefined,shot=p?(Array.isArray(p.shots)?p.shots.find((s:Doc)=>s.source?.id===job?.sourceId):p):undefined;
   const attached=m.attachmentPath?items.find(v=>v.id.startsWith('file:')&&v.path===m.attachmentPath&&v.sha256===m.sha256):undefined;if(attached&&!job&&m.scope==='project'){attached.mediaId=m.id;continue;}
   const explicit=reliableShots.filter(s=>[...(s.assets??[]),...(s.outputs??[])].some((a:Doc)=>a.mediaId===m.id&&(!a.sha256||a.sha256===m.sha256))),explicitEpisodes=[...new Set(explicit.map(s=>episodeKey(s.episode??s.id)).filter(Boolean))];const generated=!!job,kind=m.mime?.startsWith('image/')?'image':m.mime?.startsWith('video/')?'video':'document',origin=shot?.source??{},episode=episodeKey(m.episode??origin.episode??origin.id),shared=m.scope==='project'&&!job;
   const item:Doc={id:'media:'+m.id,entityId:'media:'+m.id,versionId:m.sha256,mediaId:m.id,name:m.name??m.id,kind,mime:m.mime,bytes:m.bytes,sha256:m.sha256,scope:shared?'project':'private',owner:shared?'':m.owner,ownerName:source.ownerNames[m.owner],section:projectSection({name:m.name,kind}),assetType:assetType(m.name),episodes:explicitEpisodes.length?explicitEpisodes:episode?[episode]:[],episodeEvidence:explicit.length?'explicit':episode?'generation_source':'unassigned',sourceIds:explicit.map(s=>s.id),...(m.assemblyId?{assemblyId:m.assemblyId}:{}),source:m.assemblyId?'本机拼接':generated?'生成结果':shared?'项目素材':'聊天素材',src:'/api/media/'+m.id,download:'/api/media/'+m.id+'?download=1',poster:kind==='video'?'/api/media/'+m.id+'/preview?variant=thumb':undefined,
    ...(p?{planId:p.id,jobId:job!.id,nativeSession:p.nativeSession,prompt:job!.prompt??shot?.prompt??p.prompt,script:p.parsed?.script??p.script,notes:p.parsed?.notes??p.notes,sourceId:job!.sourceId,...(origin.entityId?{sourceEntityId:origin.entityId,...(typeof origin.versionId==='string'&&/^[a-f0-9]{64}$/.test(origin.versionId)?{sourceVersionId:origin.versionId}:{})}:{}),scriptPath:origin.scriptPath,storyboardPath:origin.storyboardPath,assets:shot?.assets??p.assets??[],round:job!.round,state:job!.state}:{}),...(m.attachmentPath?{path:m.attachmentPath,revision:source.revision}:{})};
   Object.assign(item,applyAssignment(item,assignments));
   item.relationships=[...explicit.map(s=>shotRelationship(project,s)),...(m.sourceMediaIds??[]).map((mediaId:string)=>({kind:'source_clip',mediaId})),...(item.scriptPath?[{kind:'script',path:item.scriptPath}]:[]),...(item.storyboardPath?[{kind:'storyboard',path:item.storyboardPath}]:[]),...(item.assets??[]).map((a:Doc)=>({kind:'asset',mediaId:a.mediaId,path:a.path,sha256:a.sha256}))].map((r:Doc)=>({...r,...(r.path&&fileIds.has(r.path)?{entityId:fileIds.get(r.path)!.id}:r.mediaId?{entityId:'media:'+r.mediaId}:{})}));
   item.displayName=[item.episodes.join(' / ')||'公共',item.sourceId,item.source,item.name].filter(Boolean).join(' · ');items.push(item);
   if(source.sharedMedia.includes(m.id)||m.scope==='project'&&generated){
    // The owner keeps the full private search row. Peers get a separate public
    // projection whose FTS passages cannot contain the conversation's inputs.
    const {planId,jobId,nativeSession,prompt,script,notes,assets,scriptPath,storyboardPath,sourceId,sourceEntityId,sourceVersionId,generationInput,...summary}=item;
    const published={...summary,id:'shared-media:'+m.id,entityId:item.entityId,owner:'',scope:'project',sharedProjection:true,originalOwner:m.owner,source:'已采用成果',episodes:explicitEpisodes,sourceIds:explicit.map(s=>s.id),relationships:explicit.map(s=>shotRelationship(project,s)),displayName:[explicitEpisodes.join(' / ')||'公共','已采用成果',m.name].join(' · ')};
    items.push(published);
   }
  }
  const redactor=privateSkillRedactor(fileURLToPath(new URL('..',import.meta.url)),this.store.root),existing=new Map((this.store.db.prepare("SELECT id,signature FROM project_content_entities WHERE project=? AND id NOT LIKE 'attachment:%'").all(project) as Doc[]).map(v=>[v.id,v.signature])),changes:Doc[]=[];
  for(const item of items){this.check();const signature=hash(JSON.stringify([INDEX_VERSION,{...item,revision:undefined,state:undefined}]));if(!force&&existing.get(item.id)===signature){changes.push({item,signature});continue;}
   let text='',extraction='metadata',note='仅检索名称和已留存的生成输入，未识别媒体画面或声音。';
   if(item.path&&item.id.startsWith('file:')){let offset=0;do{const d=await this.extract(this.store.root,item.digest,item.path,offset,32000);this.check();text+=d.content;extraction=d.extraction;note=d.note;if(d.nextOffset===null)break;requireThat(d.nextOffset>offset,'正文分页未前进');offset=d.nextOffset;await yieldTurn();}while(true);}
   else text=[item.prompt,item.script,item.notes].filter(Boolean).join('\n');
   text=redactor.redact(text).value;item.extraction=extraction;item.extractionNote=note;const chunks=[];if(!text)chunks.push({body:'',start:0});else for(let start=0;start<text.length;start+=chunkSize-overlap)chunks.push({body:text.slice(start,start+chunkSize),start});changes.push({item,signature,chunks});await yieldTurn();
  }
  this.check();this.store.tx(()=>{
   const keep=new Set(items.map(v=>v.id));for(const oldId of existing.keys())if(!keep.has(oldId))this.removeIndex(project,oldId);
   for(const {item,signature,chunks} of changes){if(chunks){this.removeIndex(project,item.id);for(const chunk of chunks){const search=normalized([item.name,item.path,item.sourceId,item.ownerName,...item.episodes,chunk.body].filter(Boolean).join('\n')),result=this.store.db.prepare('INSERT INTO project_content_passages(project,entity,body,start,search_text) VALUES(?,?,?,?,?)').run(project,item.id,chunk.body,chunk.start,search);this.store.db.prepare('INSERT INTO project_content_fts(rowid,text) VALUES(?,?)').run(result.lastInsertRowid,search);}}
    else{const old=this.store.db.prepare('SELECT metadata FROM project_content_entities WHERE project=? AND id=?').get(project,item.id) as Doc|undefined;if(old){const value=JSON.parse(old.metadata);item.extraction=value.extraction;item.extractionNote=value.extractionNote;}}
    this.store.db.prepare('INSERT INTO project_content_entities(project,id,owner,signature,metadata) VALUES(?,?,?,?,?) ON CONFLICT(project,id) DO UPDATE SET owner=excluded.owner,signature=excluded.signature,metadata=excluded.metadata').run(project,item.id,item.owner??'',signature,JSON.stringify(item));
   }
   const currentIds=new Set(records.map(r=>r.id));for(const r of registry)if(!currentIds.has(r.id)&&r.state!=='missing')this.store.put('project-content-file',{...r,state:'missing',updated:now()});for(const r of records)this.store.put('project-content-file',r);
   this.store.put('project-content-index',{id:project,project,stamp:source.stamp,revision:source.revision,schemaVersion:INDEX_VERSION,shots:reliableShots,assignments,sourceObservedAt:source.observedAt,items:items.length,passages:(this.store.db.prepare("SELECT COUNT(*) n FROM project_content_passages WHERE project=? AND entity NOT LIKE 'attachment:%'").get(project) as Doc).n,updated:now(),warnings});
  });
 }
 private removeIndex(project:string,entity:string){this.store.db.prepare('DELETE FROM project_content_fts WHERE rowid IN (SELECT id FROM project_content_passages WHERE project=? AND entity=?)').run(project,entity);this.store.db.prepare('DELETE FROM project_content_passages WHERE project=? AND entity=?').run(project,entity);this.store.db.prepare('DELETE FROM project_content_entities WHERE project=? AND id=?').run(project,entity);}
 private async ensureAttachments(user:Doc){
  if(!this.attachments)return;this.check(user);const request='request:'+user.id+':'+user.role,old=this.attachmentFlights.get(request);if(old)return old;
  const work=(async()=>{for(const snapshot of await this.attachments!.snapshots(user)){this.check(user);const key='owner:'+snapshot.owner,existing=this.attachmentFlights.get(key);if(existing){await existing;continue;}const job=this.indexAttachments(user,snapshot);this.attachmentFlights.set(key,job);try{await job;}finally{if(this.attachmentFlights.get(key)===job)this.attachmentFlights.delete(key);}}})();this.attachmentFlights.set(request,work);try{await work;}finally{if(this.attachmentFlights.get(request)===work)this.attachmentFlights.delete(request);}
 }
 private async indexAttachments(user:Doc,snapshot:AttachmentSnapshot){
  const savedIndex=this.store.get('project-content-index',this.projects.projectId),shots:Doc[]=savedIndex?.shots??[],assignments:Doc[]=savedIndex?.assignments??[],items=snapshot.items.map(raw=>{const bound=shots.filter(s=>(s.scriptAttachment===raw.nativeAttachmentKey&&(!s.scriptSHA256||s.scriptSHA256===raw.sha256))||(s.storyboardAttachment===raw.nativeAttachmentKey&&(!s.storyboardSHA256||s.storyboardSHA256===raw.sha256))||[...(s.assets??[]),...(s.outputs??[])].some((a:Doc)=>a.attachmentKey===raw.nativeAttachmentKey&&(!a.sha256||a.sha256===raw.sha256)));if(!bound.length)return applyAssignment(raw,assignments);const episodes=[...new Set(bound.map(s=>episodeKey(s.episode??s.id)).filter(Boolean))],asset=bound.flatMap(s=>s.assets??[]).find(a=>a.attachmentKey===raw.nativeAttachmentKey),section=bound.some(s=>s.scriptAttachment===raw.nativeAttachmentKey)?'scripts':bound.some(s=>s.storyboardAttachment===raw.nativeAttachmentKey)?'storyboards':asset?'assets':raw.section;return applyAssignment({...raw,episodes,episodeEvidence:'explicit',section,assetType:asset?assetType(asset.kind??asset.type??asset.role):raw.assetType,sourceIds:bound.map(s=>s.id),relationships:bound.map(s=>shotRelationship(this.projects.projectId,s)),displayName:[episodes.join(' / ')||'公共',raw.ownerName,raw.name].join(' · ')},assignments);});
  const project=this.projects.projectId,stateId=hash(JSON.stringify([project,snapshot.owner])),protection=privateSkillRedactor(fileURLToPath(new URL('..',import.meta.url)),this.store.root).sourceDigests,stamp=hash(JSON.stringify([INDEX_VERSION,protection,items,snapshot.complete])),old=this.store.get('native-attachment-index',stateId);
  const saved=this.store.db.prepare("SELECT id,signature,metadata FROM project_content_entities WHERE project=? AND owner=? AND id LIKE 'attachment:%'").all(project,snapshot.owner) as Doc[],existing=new Map(saved.map(r=>[r.id,r.signature])),retry=new Set(saved.filter(r=>JSON.parse(r.metadata).extraction==='unavailable').map(r=>r.id));
  const p=this.store.db.prepare("SELECT COUNT(*) n FROM project_content_passages p JOIN project_content_entities e ON e.project=p.project AND e.id=p.entity WHERE e.project=? AND e.owner=? AND e.id LIKE 'attachment:%'").get(project,snapshot.owner) as Doc,f=this.store.db.prepare("SELECT COUNT(*) n FROM project_content_fts JOIN project_content_passages p ON p.id=project_content_fts.rowid JOIN project_content_entities e ON e.project=p.project AND e.id=p.entity WHERE e.project=? AND e.owner=? AND e.id LIKE 'attachment:%'").get(project,snapshot.owner) as Doc;
  const repair=old?existing.size!==old.items||p.n!==old.passages||f.n!==p.n:existing.size>0;if(old?.stamp===stamp&&!repair&&!retry.size)return;
  const changed:Doc[]=[];for(const raw of items){this.check(user);const {fileStamp,...item}=raw,signature=hash(JSON.stringify([INDEX_VERSION,protection,raw]));if(!repair&&!retry.has(item.id)&&existing.get(item.id)===signature){changed.push({item,signature});continue;}
   let text='',extraction='unavailable',note='附件正文暂未核对，原会话与原件未改动。';try{const value=await this.attachments!.text(user,item.nativeAttachmentKey,item);text=value.content;extraction=value.extraction;note=value.note;}catch{this.check(user);}
   item.extraction=extraction;item.extractionNote=note;const chunks=[];if(!text)chunks.push({body:'',start:0});else for(let start=0;start<text.length;start+=chunkSize-overlap)chunks.push({body:text.slice(start,start+chunkSize),start});changed.push({item,signature,chunks});await yieldTurn();
  }
  this.check(user);this.store.tx(()=>{
   const keep=new Set(snapshot.items.map(v=>v.id));if(snapshot.complete)for(const id of existing.keys())if(!keep.has(id))this.removeIndex(project,id);
   for(const {item,signature,chunks}of changed){if(chunks){this.removeIndex(project,item.id);for(const chunk of chunks){const content=normalized([item.name,item.ownerName,...item.episodes,chunk.body].join('\n')),r=this.store.db.prepare('INSERT INTO project_content_passages(project,entity,body,start,search_text) VALUES(?,?,?,?,?)').run(project,item.id,chunk.body,chunk.start,content);this.store.db.prepare('INSERT INTO project_content_fts(rowid,text) VALUES(?,?)').run(r.lastInsertRowid,content);}}
    else{const r=this.store.db.prepare('SELECT metadata FROM project_content_entities WHERE project=? AND id=?').get(project,item.id) as Doc;const prior=JSON.parse(r.metadata);item.extraction=prior.extraction;item.extractionNote=prior.extractionNote;}
    this.store.db.prepare('INSERT INTO project_content_entities(project,id,owner,signature,metadata) VALUES(?,?,?,?,?) ON CONFLICT(project,id) DO UPDATE SET owner=excluded.owner,signature=excluded.signature,metadata=excluded.metadata').run(project,item.id,item.owner,signature,JSON.stringify(item));
   }
   this.store.put('native-attachment-index',{id:stateId,owner:snapshot.owner,project,stamp,complete:snapshot.complete,warnings:snapshot.warnings,updated:now(),items:(this.store.db.prepare("SELECT COUNT(*) n FROM project_content_entities WHERE project=? AND owner=? AND id LIKE 'attachment:%'").get(project,snapshot.owner) as Doc).n,passages:(this.store.db.prepare("SELECT COUNT(*) n FROM project_content_passages p JOIN project_content_entities e ON e.project=p.project AND e.id=p.entity WHERE e.project=? AND e.owner=? AND e.id LIKE 'attachment:%'").get(project,snapshot.owner) as Doc).n});
  });
 }
 private warnings(user:Doc){return [...(this.store.get('project-content-index',this.projects.projectId)?.warnings??[]),...this.store.all('native-attachment-index').filter(s=>user.role==='admin'||s.owner===user.id).flatMap(s=>s.warnings??[])];}
 async readAttachments(user:Doc,args:Doc){this.check(user);requireThat(this.attachments,'原生附件读取尚未就绪',503);requireThat(Array.isArray(args.attachment_ids)&&args.attachment_ids.length>0&&args.attachment_ids.length<=16,'请提供附件检索返回的编号');const files=[];for(const key of args.attachment_ids){requireThat(typeof key==='string','附件编号无效');files.push(await this.attachments.read(user,key,args.offset??0,args.limit??8000));this.check(user);}return {project:this.projects.projectId,files,content:files.map(v=>'--- '+v.name+' ---\n'+v.note+'\n'+v.content+(v.nextOffset===null?'':'\n后续正文 offset='+v.nextOffset)).join('\n')};}
 async attachOriginals(user:Doc,args:Doc){this.check(user);requireThat(this.attachments,'原生附件读取尚未就绪',503);requireThat(Array.isArray(args.attachment_ids)&&args.attachment_ids.length>0&&args.attachment_ids.length<=8,'请提供附件检索返回的编号');const files=[];for(const key of args.attachment_ids){requireThat(typeof key==='string','附件编号无效');files.push(await this.attachments.preview(user,key));this.check(user);}return {project:this.projects.projectId,files};}
 private assemblySources(items:Doc[]){
  const assemblies=items.some(item=>item.assemblyId);if(!assemblies&&!items.some(item=>item.jobId))return items;
  const skill=this.currentSkill(),provenance=assemblies?new AssemblySourceProvenance(this.store,this.projects,()=>skill):undefined;let context:ReturnType<AssemblySourceProvenance['context']>|undefined;if(provenance)try{context=provenance.context();}catch{}
  return items.map(raw=>{
   let item=raw;if(item.jobId&&!item.sharedProjection){const job=this.store.get('video-job',item.jobId)??this.store.get('image-job',item.jobId);item={...item,generationInput:job&&job.owner===item.owner&&job.mediaId===item.mediaId?generationInputWithImpact(this.store,job,skill):undefined};}
   if(!item.assemblyId)return item;const job=this.store.get('assembly-job',item.assemblyId);if(!job||job.mediaId!==item.mediaId)return item;const status=provenance!.status(job.sourceProvenance,context,job.resolvedGenerationInputs);return {...item,assemblySources:item.sharedProjection?{state:status.state,summary:status.summary,changeCount:status.changes?.length??0,checkedAt:status.checkedAt}:status};
  });
 }
 private visible(user:Doc){return user.role==='admin'?{sql:"json_extract(e.metadata,'$.sharedProjection') IS NOT 1",params:[]}: {sql:"(e.owner=? OR (e.owner='' AND (json_extract(e.metadata,'$.sharedProjection') IS NOT 1 OR json_extract(e.metadata,'$.originalOwner')<>?)))",params:[user.id,user.id]};}
 async catalogue(user:Doc){this.check(user);await this.ensure();await this.ensureAttachments(user);this.check(user);const v=this.visible(user),items=(this.store.db.prepare('SELECT e.metadata FROM project_content_entities e WHERE e.project=? AND '+v.sql+' ORDER BY e.id').all(this.projects.projectId,...v.params) as Doc[]).map(v=>JSON.parse(v.metadata));return {project:this.projects.projectId,revision:this.projects.current().revision,sourceObservedAt:this.store.get('project-content-index',this.projects.projectId)?.sourceObservedAt,items:this.assemblySources(items),warnings:this.warnings(user)};}
 async page(user:Doc,args:Doc={}){
  this.check(user);const requested=args.page??1,size=args.limit??48,section=args.section??'all',episode=args.episode??'all',type=args.assetType??'all',query=args.query??'';
  requireThat(Number.isSafeInteger(requested)&&requested>0&&Number.isSafeInteger(size)&&size>0&&size<=100,'资料分页无效');
  requireThat(section==='all'||sections.includes(section),'资料分类无效');requireThat(typeof episode==='string'&&episode.length<=100,'集数筛选无效');requireThat(['all','character','scene','prop','other'].includes(type),'资产分类无效');requireThat(typeof query==='string'&&query.length<=200,'检索内容不能超过200字');
  await this.ensure();await this.ensureAttachments(user);this.check(user);
  const revision=this.projects.current().revision;requireThat(!args.revision||args.revision===revision,'资料版本已变化，请刷新后继续浏览',409);
  const v=this.visible(user),scope='e.project=? AND '+v.sql,scopeValues=[this.projects.projectId,...v.params];
  // Counts and episode navigation obey exactly the same visibility predicate
  // as cards. They must not reveal another member's private media or uploads.
  const groups=this.store.db.prepare("SELECT json_extract(e.metadata,'$.section') section,COUNT(*) total FROM project_content_entities e WHERE "+scope+" GROUP BY section").all(...scopeValues) as Doc[];
  const episodes=this.store.db.prepare("SELECT DISTINCT j.value episode FROM project_content_entities e,json_each(json_extract(e.metadata,'$.episodes')) j WHERE "+scope+" ORDER BY episode").all(...scopeValues) as Doc[];
  const summary={total:groups.reduce((n,g)=>n+g.total,0),sections:Object.fromEntries(groups.map(g=>[g.section,g.total])),episodes:episodes.map(v=>v.episode)};
  const conditions=[scope],values:any[]=[...scopeValues];
  if(section!=='all'&&section!=='files'){conditions.push("json_extract(e.metadata,'$.section')=?");values.push(section);}
  if(episode!=='all'){if(episode==='unassigned')conditions.push("json_array_length(json_extract(e.metadata,'$.episodes'))=0");else{conditions.push("EXISTS (SELECT 1 FROM json_each(json_extract(e.metadata,'$.episodes')) WHERE value=?)");values.push(episode);}}
  if(type!=='all'){conditions.push("json_extract(e.metadata,'$.assetType')=?");values.push(type);}
  let items:Doc[],total:number,page=requested,coverage:unknown;
  if(query.trim()){
   let result=await this.search(user,{query,section:section==='files'?'all':section,episode,assetType:type,offset:(page-1)*size,limit:size});total=result.total;page=Math.min(page,Math.max(1,Math.ceil(total/size)));
   if(page!==requested)result=await this.search(user,{query,section:section==='files'?'all':section,episode,assetType:type,offset:(page-1)*size,limit:size});
   items=result.items;coverage=result.coverage;
  }else{
   const where=conditions.join(' AND ');total=(this.store.db.prepare('SELECT COUNT(*) total FROM project_content_entities e WHERE '+where).get(...values) as Doc).total;page=Math.min(page,Math.max(1,Math.ceil(total/size)));
   items=(this.store.db.prepare("SELECT e.metadata FROM project_content_entities e WHERE "+where+" ORDER BY CASE WHEN e.id LIKE 'file:%' THEN 0 ELSE 1 END,coalesce(json_extract(e.metadata,'$.path'),json_extract(e.metadata,'$.name')) COLLATE NOCASE,e.id LIMIT ? OFFSET ?").all(...values,size,(page-1)*size) as Doc[]).map(row=>JSON.parse(row.metadata));
  }
  this.check(user);requireThat(this.projects.current().revision===revision,'资料版本已变化，请刷新后继续浏览',409);
  return {project:this.projects.projectId,revision,sourceObservedAt:this.store.get('project-content-index',this.projects.projectId)?.sourceObservedAt,query,items:this.assemblySources(items),summary,coverage,pagination:{page,size,pages:Math.max(1,Math.ceil(total/size)),total,from:total?(page-1)*size+1:0,to:Math.min(total,page*size)},warnings:this.warnings(user)};
 }
 async search(user:Doc,args:Doc){this.check(user);requireThat(typeof args.query==='string'&&args.query.trim()&&args.query.length<=200,'请输入1–200字的检索内容');const limit=args.limit??20,offset=args.offset??0;requireThat(Number.isSafeInteger(limit)&&limit>=1&&limit<=100&&Number.isSafeInteger(offset)&&offset>=0,'检索分页无效');const section=args.section??'all';requireThat(section==='all'||sections.includes(section),'资料分类无效');
  await this.ensure();await this.ensureAttachments(user);this.check(user);const terms=normalized(args.query).trim().split(/\s+/),long=terms.filter(t=>[...t].length>=3),v=this.visible(user),conditions=['e.project=?',v.sql],values:any[]=[this.projects.projectId,...v.params];
  for(const t of terms){conditions.push('instr(p.search_text,?)>0');values.push(t);}if(section!=='all'){conditions.push("json_extract(e.metadata,'$.section')=?");values.push(section);}
  if(args.episode&&args.episode!=='all'){if(args.episode==='unassigned')conditions.push("json_array_length(json_extract(e.metadata,'$.episodes'))=0");else{conditions.push("EXISTS (SELECT 1 FROM json_each(json_extract(e.metadata,'$.episodes')) WHERE value=?)");values.push(args.episode);}}
  if(args.assetType&&args.assetType!=='all'){requireThat(['character','scene','prop','other'].includes(args.assetType),'资产分类无效');conditions.push("json_extract(e.metadata,'$.assetType')=?");values.push(args.assetType);}
  if(long.length){conditions.push('project_content_fts MATCH ?');values.push(long.map(t=>'"'+t.replaceAll('"','""')+'"').join(' AND '));}
  const join=long.length?'JOIN project_content_fts ON project_content_fts.rowid=p.id':'',rows=this.store.db.prepare('SELECT e.id,e.metadata,MIN(p.id) AS passage FROM project_content_entities e JOIN project_content_passages p ON p.project=e.project AND p.entity=e.id '+join+' WHERE '+conditions.join(' AND ')+' GROUP BY e.id ORDER BY e.id').all(...values) as Doc[];
  const ranked=rows.map(row=>{const item=JSON.parse(row.metadata);return {...item,passage:row.passage,nameMatch:terms.every(t=>normalized(item.name+' '+(item.path??'')).includes(t))};}).sort((a,b)=>Number(b.nameMatch)-Number(a.nameMatch)||a.name.localeCompare(b.name)||a.id.localeCompare(b.id));
  const hits=ranked.slice(offset,offset+limit).map(({passage,...item})=>{const p=this.store.db.prepare('SELECT body,start FROM project_content_passages WHERE id=? AND project=?').get(passage,this.projects.projectId) as Doc,at=p.body.toLocaleLowerCase().indexOf(terms[0]),start=Math.max(0,at-80);return {...item,match:{text:p.body.slice(start,start+320),offset:p.start+start,limit:Math.min(320,p.body.length-start),extraction:item.extraction,note:item.extractionNote}};});
  const coverage=this.store.db.prepare(`SELECT COUNT(*) AS items,SUM(CASE WHEN json_extract(e.metadata,'$.extraction') IN ('text','office_text','pdf_text') THEN 1 ELSE 0 END) AS textIndexed,SUM(CASE WHEN json_extract(e.metadata,'$.extraction') IN ('pdf_text','no_text','unavailable','unsupported') THEN 1 ELSE 0 END) AS limitedOrUnavailable FROM project_content_entities e WHERE e.project=? AND ${v.sql}`).get(this.projects.projectId,...v.params);

  this.check(user);return {project:this.projects.projectId,revision:this.projects.current().revision,sourceObservedAt:this.store.get('project-content-index',this.projects.projectId)?.sourceObservedAt,query:args.query,total:ranked.length,coverage,offset,nextOffset:offset+limit<ranked.length?offset+limit:null,items:this.assemblySources(hits),warnings:this.warnings(user)};
 }
 async close(){this.closing=true;await Promise.allSettled([...(this.flight?[this.flight]:[]),...this.attachmentFlights.values()]);}
}
