import {Store,hash,id,now,requireThat,type Doc} from './store.ts';
import {Projects,validPath,type Manifest} from './project.ts';
import {documentText} from './document-text.ts';import type {ProjectContent} from './project-content.ts';
import {episodeKey} from '../shared/project-studio.ts';import {assertStoragePath} from './external-storage.ts';
import type {MediaStore} from './media.ts';import {lstatSync} from 'node:fs';
import {assignmentSet,assignmentRefKey} from '../shared/project-assignments.ts';

import {shotEntityId,shotView,duplicateShotIdentities} from './shot-identity.ts';

const DEFAULT_INDEX='资料/补抽索引.json';
const stable=(v:any):any=>Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v;
const string=(v:unknown,name:string,max=1000)=>{requireThat(typeof v==='string'&&v.length>0&&v.length<=max&&!/[\x00-\x1f\x7f]/.test(v),name+'无效');return v as string;};
/** Optional authoring over the existing versioned project index. The native
 * project publish transaction, originals and generation records stay canonical. */
export class ProjectLinks {
 private flights=new Map<string,{digest:string;work:Promise<Doc>}>();
 constructor(public store:Store,public projects:Projects,public content:ProjectContent,private media:MediaStore){}
 check(user:Doc){const current=this.store.get('user',user.id);requireThat(current?.active&&current.role===user.role,'项目关联访问身份已变化',403);assertStoragePath(this.store.root);}
 private path(manifest:Manifest,value?:unknown){if(value!==undefined){const p=validPath(value);requireThat(/(^|\/)补抽索引\.json$/.test(p),'请使用项目已有的补抽索引文件');return p;}
  if(manifest[DEFAULT_INDEX])return DEFAULT_INDEX;const candidates=Object.keys(manifest).filter(p=>/(^|\/)补抽索引\.json$/.test(p));requireThat(candidates.length<=1,'项目有多份关联索引，请按实际路径选择，不合并或覆盖');return candidates[0]??DEFAULT_INDEX;
 }
 private source(user:Doc,args:Doc){this.check(user);const revision=args.revision??this.projects.current().revision,manifest=this.projects.revision(revision).manifest,path=this.path(manifest,args.index_path);let value:Doc={version:1,shots:[]};
  if(manifest[path]){try{value=JSON.parse(this.projects.read(path,revision).toString('utf8'));}catch{requireThat(false,'现有关联索引不是有效 JSON，未覆盖原件',422);}requireThat(value&&typeof value==='object'&&!Array.isArray(value)&&Array.isArray(value.shots),'现有关联索引缺少镜头数组，未覆盖原件',422);}
  return {revision,manifest,path,value,digest:manifest[path]??null};
 }
 read(user:Doc,args:Doc={}){const s=this.source(user,args),offset=args.offset??0,limit=args.limit??50;requireThat(Number.isSafeInteger(offset)&&offset>=0&&Number.isInteger(limit)&&limit>0&&limit<=100,'关联读取范围无效');const rows=args.shot_id?s.value.shots.filter((v:Doc)=>v?.id===args.shot_id||v&&shotEntityId(this.projects.projectId,v)===args.shot_id):s.value.shots,ids=new Set<string>(),duplicates=new Set<string>();for(const row of s.value.shots){const label=row?.id;if(ids.has(label))duplicates.add(label);ids.add(label);}
  const assignments=assignmentSet(s.value.contentAssignments),assigned=args.assignment_id?assignments.items.filter(a=>a.id===args.assignment_id):assignments.items;
  return {project:this.projects.projectId,revision:s.revision,indexPath:s.path,indexSHA256:s.digest,total:rows.length,offset,nextOffset:offset+limit<rows.length?offset+limit:null,shots:rows.slice(offset,offset+limit).map((row:Doc)=>row&&typeof row==='object'&&!Array.isArray(row)?shotView(this.projects.projectId,row):row),assignments:assigned.slice(offset,offset+limit),assignmentTotal:assigned.length,assignmentNextOffset:offset+limit<assigned.length?offset+limit:null,identityNote:'entityId是镜头稳定编号，versionId是本次关联版本。修改显示镜号时，upsert的shot_id填写原镜号或entityId，shot包含原entityId和新id；其余来源按实际要求保留。插镜使用新的镜号，主机分配新entityId。读取不会改写旧索引。',warnings:[...(s.value.shots.some((row:unknown)=>!row||typeof row!=='object'||Array.isArray(row))?['索引有不完整的镜头行，原记录保留，未据此猜测关联。']:[]),...(duplicateShotIdentities(this.projects.projectId,s.value.shots).size?['镜头稳定编号重复，未将这些记录合并为同一镜头。']:[]),...(duplicates.size?['索引包含重复镜头编号；对应镜头需先核对，未猜测合并。']:[]),...assignments.warnings]};
 }
 private async reference(user:Doc,ref:Doc,base:string,reads:Manifest,preserveIdentity=true,retainedMedia?:Doc):Promise<Doc>{
  if(ref?.entityId&&ref.path===undefined&&ref.mediaId===undefined&&ref.attachmentKey===undefined){const items=(await this.content.catalogue(user)).items,matches=items.filter(v=>v.entityId===ref.entityId||v.id===ref.entityId);requireThat(matches.length===1,'内容编号不存在、版本不明确或无权访问，请先检索原件',404);const item=matches[0];ref={...ref,...(item.nativeAttachmentKey?{attachmentKey:item.nativeAttachmentKey}:item.mediaId?{mediaId:item.mediaId}:{path:item.path})};}
  requireThat(ref&&typeof ref==='object'&&!Array.isArray(ref),'资料引用无效');requireThat([ref.path,ref.mediaId,ref.attachmentKey].filter(v=>v!==undefined).length===1,'每项引用须选择一个实际文件、素材编号或聊天附件编号');let result:Doc={};
  if(ref.path!==undefined){const path=validPath(ref.path),revision=ref.revision??base,f=this.projects.fileInfo(path,revision);requireThat(!ref.sha256||ref.sha256===f.digest,'引用的文件版本已变化',409);if(preserveIdentity||ref.entityId)await this.content.ensure();const identities=this.store.all('project-content-file').filter(v=>v.path===path||v.paths?.includes(path)),identity=identities.find(v=>v.state==='current'&&v.path===path)??(identities.length===1?identities[0]:undefined);requireThat(!ref.entityId||identity&&String(ref.entityId).replace(/^file:/,'')===identity.id,'文件内容编号与原路径不一致',409);result={path,revision,sha256:f.digest,...(identity&&preserveIdentity?{entityId:identity.id}:{})};if(revision===base)reads[path]=f.digest;}
  else if(ref.mediaId!==undefined){const media=this.store.get('media',string(ref.mediaId,'素材编号'));
   // Carry an existing, byte-identical descriptor within this shot/field. This
   // is not authority to read, alter or reuse the other member's private media.
   const retained=retainedMedia?.mediaId===ref.mediaId&&retainedMedia?.sha256===media?.sha256&&JSON.stringify(stable(retainedMedia))===JSON.stringify(stable(ref));
   requireThat(media&&(this.media.canRead(media,user)||retained),'素材不存在或无权关联',404);requireThat(!ref.sha256||ref.sha256===media.sha256,'素材原件版本已变化',409);const before=lstatSync(this.media.path(media.id));requireThat(before.isFile(),'素材原件不是普通文件',409);await this.media.verify(media.id,media.sha256);const after=lstatSync(this.media.path(media.id));requireThat(after.isFile()&&[before.dev,before.ino,before.size,before.mtimeMs,before.ctimeMs].join(':')===[after.dev,after.ino,after.size,after.mtimeMs,after.ctimeMs].join(':'),'素材原件在核对期间改变',409);result={mediaId:media.id,sha256:media.sha256};}
  else{requireThat(this.content.attachments,'聊天附件尚未就绪',503);const v=await this.content.attachments.original(user,string(ref.attachmentKey,'聊天附件编号'));requireThat(!ref.sha256||ref.sha256===v.item.sha256,'聊天附件原件版本已变化',409);result={attachmentKey:v.item.nativeAttachmentKey,sha256:v.item.sha256};}
  for(const key of ['id','name','role','kind','type'])if(ref[key]!==undefined)result[key]=string(ref[key],key,200);this.check(user);return result;
 }
 private async body(user:Doc,path:string,revision:string){const digest=this.projects.revision(revision).manifest[path];requireThat(digest,'来源文件不存在',404);let content='',offset=0;do{const p=await documentText(this.store.root,digest,path,offset,32000);this.check(user);requireThat(['text','office_text','pdf_text'].includes(p.extraction),'来源正文尚未核对，未保存猜测摘录',422);content+=p.content;if(p.nextOffset===null)return content;requireThat(p.nextOffset>offset,'来源正文分页未前进');offset=p.nextOffset;}while(true);}
 private result(change:Doc){return {project:this.projects.projectId,state:'committed',changeId:change.id,revision:change.revision,indexPath:change.linksIndexPath,indexSHA256:change.writes[change.linksIndexPath],shotId:change.linksShotId,shotEntityId:change.linksShotEntityId,shotVersionId:change.linksShotVersionId,previousShotId:change.linksPreviousShotId,assignmentId:change.linksAssignmentId,operation:change.linksOperation,note:'已更新项目关联；原文件、原生聊天与生成任务均保留。'};}
 private publish(user:Doc,s:ReturnType<ProjectLinks['source']>,args:Doc,next:Doc,reads:Manifest,requestKey:string,requestDigest:string,target:Doc){
  this.check(user);const candidate=this.projects.candidate(user,s.revision,{[s.path]:JSON.stringify(next,null,2)+'\n'},reads,{source:'project-links',nativeWorkspace:'project-links:'+user.id,linksRequestId:requestKey,linksRequestDigest:requestDigest,linksIndexPath:s.path,...target,linksOperation:args.operation,linksRequestedAt:now()});this.check(user);return this.result(this.projects.publishNative(candidate,user));
 }
 private async classify(user:Doc,args:Doc,s:ReturnType<ProjectLinks['source']>,requestKey:string,requestDigest:string){
  requireThat(s.value.contentAssignments===undefined||Array.isArray(s.value.contentAssignments),'现有资料归类不是数组，未覆盖，请先核对原索引',422);const rows:Doc[]=s.value.contentAssignments??[],reads:Manifest={...(s.digest?{[s.path]:s.digest}:{})};let assignmentId:string,nextRows:Doc[];
  if(args.operation==='unassign'){assignmentId=string(args.assignment_id,'资料归类编号',160);const matches=rows.filter(r=>r?.id===assignmentId);requireThat(matches.length===1,'资料归类不存在或编号重复，未猜测移除',409);nextRows=rows.filter(r=>r?.id!==assignmentId);}
  else{const patch=args.assignment;requireThat(patch&&typeof patch==='object'&&!Array.isArray(patch),'请提供资料归类');requireThat(Object.keys(patch).every(k=>['id','reference','episodes','section','assetType'].includes(k)),'包含无法识别的资料归类字段');requireThat(patch.reference||args.assignment_id||patch.id,'请指定实际资料或已有归类编号');
   const selected=args.assignment_id??patch.id;requireThat(!args.assignment_id||!patch.id||args.assignment_id===patch.id,'资料归类编号不一致');const matches=selected?rows.filter(r=>r?.id===selected):[];requireThat(matches.length<=1,'资料归类编号重复，未覆盖',409);if(selected)requireThat(matches.length===1,'资料归类不存在，请先读取当前记录',404);const reference=await this.reference(user,patch.reference??matches[0].reference,s.revision,reads,true),key=assignmentRefKey(reference)!;assignmentId=selected??'assignment-'+hash(JSON.stringify([this.projects.projectId,key]));
   const current=rows.filter(r=>r?.id===assignmentId);requireThat(current.length<=1,'资料归类编号重复，未覆盖',409);requireThat(!current.length||assignmentRefKey(current[0].reference)===key,'这条归类属于另一份原件，未改写其绑定',409);const row:Doc={...(current[0]??{}),id:assignmentId,reference};
   if(Object.hasOwn(patch,'episodes')){requireThat(Array.isArray(patch.episodes),'集数须为数组，公共资料填写空数组');const episodes=patch.episodes.map((v:unknown)=>episodeKey(v));requireThat(episodes.every(Boolean),'存在无法识别的集数，请按实际集数填写');row.episodes=[...new Set(episodes)];}
   if(Object.hasOwn(patch,'section')){requireThat(['scripts','storyboards','assets','videos','edits','files'].includes(patch.section),'资料分类无效');row.section=patch.section;}
   if(Object.hasOwn(patch,'assetType')){requireThat(['character','scene','prop','other'].includes(patch.assetType),'资产类型无效');row.assetType=patch.assetType;}
   nextRows=current.length?rows.map(r=>r?.id===assignmentId?row:r):[...rows,row];requireThat(assignmentSet(nextRows).items.some(r=>r.id===assignmentId),'资料归类相互冲突，未覆盖，请先核对已有记录',409);
  }
  return this.publish(user,s,args,{...s.value,version:s.value.version??1,contentAssignments:nextRows},reads,requestKey,requestDigest,{linksAssignmentId:assignmentId});
 }
 async update(user:Doc,args:Doc,requestId:string):Promise<Doc>{
  this.check(user);string(requestId,'关联修改请求编号',300);const key=hash(JSON.stringify([this.projects.projectId,user.id,requestId])),digest=hash(JSON.stringify(stable(args))),old=this.flights.get(key);if(old){requireThat(old.digest===digest,'同一次关联修改的内容已改变',409);const result=await old.work;this.check(user);return result;}
  const work=this.mutate(user,args,requestId);this.flights.set(key,{digest,work});try{return await work;}finally{if(this.flights.get(key)?.work===work)this.flights.delete(key);}
 }
 private async mutate(user:Doc,args:Doc,requestId:string){
  this.check(user);string(requestId,'关联修改请求编号',300);requireThat(['upsert','remove','assign','unassign'].includes(args.operation),'关联操作无效');const requestKey=hash(JSON.stringify([this.projects.projectId,user.id,requestId])),requestDigest=hash(JSON.stringify(stable(args)));
  const previous=this.store.all('change',user.id).find(c=>c.linksRequestId===requestKey);if(previous){requireThat(previous.linksRequestDigest===requestDigest,'同一次关联修改的内容已改变',409);if(previous.state==='approved')this.projects.recover();let saved=this.store.get('change',previous.id)!;if(saved.state==='committed')return this.result(saved);requireThat(saved.state==='submitted','此前关联修改存在冲突，请读取当前关联后重新修改',409);saved=this.projects.publishNative(saved,user);return this.result(saved);}
  const s=this.source(user,args);requireThat(Object.hasOwn(args,'expected_index_sha256')&&args.expected_index_sha256===s.digest,'项目关联已变化，请读取最新关联后修改，未覆盖',409);if(['assign','unassign'].includes(args.operation))return this.classify(user,args,s,requestKey,requestDigest);const shotId=string(args.shot_id??args.shot?.id,'镜头编号',80),matches=s.value.shots.filter((v:Doc)=>v?.id===shotId||v&&shotEntityId(this.projects.projectId,v)===shotId);requireThat(matches.length<=1,'这个镜头编号重复，未猜测或覆盖',409);requireThat(args.operation!=='remove'||matches.length===1,'当前索引没有这个镜头关联',404);
  if(matches.length)requireThat(!duplicateShotIdentities(this.projects.projectId,s.value.shots).has(shotEntityId(this.projects.projectId,matches[0])),'这个镜头稳定编号重复，未猜测或覆盖',409);
  const reads:Manifest={...(s.digest?{[s.path]:s.digest}:{})};let row:Doc={};
  if(args.operation==='upsert'){
   const patch=args.shot;requireThat(patch&&typeof patch==='object'&&!Array.isArray(patch),'请提供需要修改的镜头关联');const current=matches[0],entityId=current?shotEntityId(this.projects.projectId,current):'shot:'+id(),label=string(patch.id??current?.id??shotId,'镜头编号',80);requireThat(patch.entityId===undefined||current&&patch.entityId===entityId,'镜头稳定编号不一致，未接管其他镜头',409);requireThat(patch.versionId===undefined||current&&patch.versionId===shotView(this.projects.projectId,current).versionId,'镜头关联版本已变化',409);if(current&&label!==current.id){requireThat(patch.entityId===entityId,'更改镜头编号需保留读取到的稳定编号',409);requireThat(!s.value.shots.some((v:Doc)=>v!==current&&v?.id===label),'新镜头编号已有记录，未覆盖',409);}else if(!current)requireThat(label===shotId,'镜头编号不一致');
   const allowed=['id','entityId','versionId','episode','name','scriptPath','scriptRevision','scriptQuote','scriptAttachment','storyboardPath','storyboardRevision','storyboardQuote','storyboardAttachment','assets','outputs','duration','dayPeriod','kind','framing','visualDescription','characters','dialogue'];requireThat(Object.keys(patch).every(k=>allowed.includes(k)),'包含无法识别的关联字段');const {versionId:expectedVersion,...fields}=patch;row={...(current??{}),...fields,id:label,entityId};
   if(Object.hasOwn(patch,'episode')){const ep=episodeKey(patch.episode);requireThat(ep,'请填写实际集数');row.episode=ep;}
   for(const key of ['name','dayPeriod','kind','framing'])if(patch[key]!==undefined)string(patch[key],key,200);if(patch.duration!==undefined)requireThat(Number.isFinite(patch.duration)&&patch.duration>0,'镜头时长须为正数');
   for(const key of ['visualDescription','scriptQuote','storyboardQuote'])if(patch[key]!==undefined)requireThat(typeof patch[key]==='string','描述与摘录须为文本');for(const key of ['characters','dialogue'])if(patch[key]!==undefined)requireThat(Array.isArray(patch[key]),key+'须为数组');
   for(const key of ['script','storyboard']){
    const pathKey=key+'Path',attachmentKey=key+'Attachment',revisionKey=key+'Revision',shaKey=key+'SHA256',identityKey=key+'EntityId',quoteKey=key+'Quote';
    requireThat(!(patch[pathKey]&&patch[attachmentKey]),'同一来源请选择文件或聊天附件');
    if(Object.hasOwn(patch,pathKey)||Object.hasOwn(patch,revisionKey)){if(patch[pathKey]===null){delete row[pathKey];delete row[revisionKey];delete row[shaKey];delete row[identityKey];delete row[quoteKey];}else{requireThat(row[pathKey],'来源版本缺少实际文件');const ref=await this.reference(user,{path:row[pathKey],revision:patch[revisionKey]},s.revision,reads);row[pathKey]=ref.path;row[revisionKey]=ref.revision;row[shaKey]=ref.sha256;row[identityKey]=ref.entityId;delete row[attachmentKey];}}
    if(Object.hasOwn(patch,attachmentKey)){if(patch[attachmentKey]===null){delete row[attachmentKey];delete row[shaKey];delete row[quoteKey];}else{const ref=await this.reference(user,{attachmentKey:patch[attachmentKey]},s.revision,reads);row[attachmentKey]=ref.attachmentKey;row[shaKey]=ref.sha256;delete row[pathKey];delete row[revisionKey];delete row[identityKey];}}
    if(patch[quoteKey]!==undefined&&patch[quoteKey]!==''){let content:string;if(row[pathKey])content=await this.body(user,row[pathKey],row[revisionKey]??s.revision);else{requireThat(row[attachmentKey]&&this.content.attachments,'摘录缺少可核对的来源');content=(await this.content.attachments.text(user,row[attachmentKey])).content;}requireThat(content.includes(patch[quoteKey]),'摘录不在所选原文版本中，未保存猜测关联',409);}
   }
   for(const key of ['assets','outputs'])if(Object.hasOwn(patch,key)){
    requireThat(Array.isArray(patch[key]),key+'须为资料引用数组');row[key]=[];
    const retainedByValue=new Map<string,Doc>((Array.isArray(matches[0]?.[key])?matches[0][key]:[]).filter((v:Doc)=>v?.mediaId).map((v:Doc)=>[JSON.stringify(stable(v)),v]));
    for(const ref of patch[key])row[key].push(await this.reference(user,ref,s.revision,reads,true,retainedByValue.get(JSON.stringify(stable(ref)))));
   }
  }
  this.check(user);const shots=args.operation==='remove'?s.value.shots.filter((v:Doc)=>v!==matches[0]):matches.length?s.value.shots.map((v:Doc)=>v===matches[0]?row:v):[...s.value.shots,row],next={...s.value,version:s.value.version??1,shots};
  // candidateObjects freezes the request identity in its own existing transaction.
  // A lost reply or a crash before/after publication resumes the same change.
  return this.publish(user,s,args,next,reads,requestKey,requestDigest,{linksShotId:row.id??matches[0]?.id??shotId,linksShotEntityId:matches[0]||row.id?shotEntityId(this.projects.projectId,row.id?row:matches[0]):undefined,linksShotVersionId:row.id?shotView(this.projects.projectId,row).versionId:undefined,...(matches[0]&&row.id&&row.id!==matches[0].id?{linksPreviousShotId:matches[0].id}:{})});
 }
}
