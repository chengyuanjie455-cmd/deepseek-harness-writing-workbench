import {assemblyGenerationInputs,validGenerationInput} from './generation-input-provenance.ts';
import {generationInputImpact} from './generation-input-impact.ts';
import {privateSkillDefinitionStatus} from './private-skill-definition.ts';
import {hash,now,type Store,type Doc} from './store.ts';
import type {Projects} from './project.ts';
import {shotEntityId,shotView,duplicateShotIdentities} from './shot-identity.ts';

const stable=(v:any):any=>Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v;
const digest=(v:unknown)=>hash(JSON.stringify(stable(v)));
const validSHA=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
type Context={revision:string;manifest:Doc;indices:Doc[];shots:Map<string,Doc>;ambiguous:Set<string>;errors:boolean;files:Doc[];media:Map<string,Doc>};
type Walk={active:Set<string>;memo:Map<string,Doc>;nodes:number;depth:number};

/** Read-only evidence over the project's existing index. It neither edits that
 * index nor treats current inputs as proof of an old generation's inputs. */
export class AssemblySourceProvenance {
 constructor(private store:Store,private projects:Projects,private currentSkill:()=>Doc=privateSkillDefinitionStatus){}
 context():Context {
  const revision=this.projects.current().revision,manifest=this.projects.revision(revision).manifest,indices:Doc[]=[],rows:Doc[]=[];let errors=false;
  for(const path of Object.keys(manifest).filter(p=>/(^|\/)补抽索引\.json$/.test(p))){
   indices.push({path,sha256:manifest[path]});
   try{const data=JSON.parse(this.projects.read(path,revision).toString('utf8'));if(!Array.isArray(data?.shots))throw Error('invalid index');for(const row of data.shots){
    if(!row||typeof row!=='object'||Array.isArray(row)||typeof row.id!=='string'||!row.id){errors=true;continue;}
    for(const field of ['assets','outputs'])if(row[field]!==undefined){
     if(!Array.isArray(row[field]))errors=true;
     else if(row[field].some((ref:Doc)=>!ref||typeof ref!=='object'||Array.isArray(ref)||[ref.path,ref.mediaId,ref.attachmentKey].filter(v=>typeof v==='string'&&v.length>0).length!==1||ref.sha256!==undefined&&!validSHA(ref.sha256)))errors=true;
    }
    for(const field of ['script','storyboard'])if(row[field+'Path']&&row[field+'Attachment'])errors=true;
    rows.push(row);
   }}
   catch{errors=true;}
  }
  const ambiguous=duplicateShotIdentities(this.projects.projectId,rows),byLabel=new Map<string,Set<string>>();
  for(const row of rows){const values=byLabel.get(row.id)??new Set<string>();values.add(shotView(this.projects.projectId,row).versionId);byLabel.set(row.id,values);}
  for(const row of rows)if(byLabel.get(row.id)!.size>1)ambiguous.add(shotEntityId(this.projects.projectId,row));
  return {revision,manifest,indices,shots:new Map(rows.map(row=>[shotEntityId(this.projects.projectId,row),row])),ambiguous,errors,files:this.store.all('project-content-file'),media:new Map(this.store.all('media').map(m=>[m.id,m]))};
 }
 private file(ref:Doc,context:Context,revision?:string):Doc {
  const path=ref.path,entity=typeof ref.entityId==='string'?ref.entityId.replace(/^file:/,''):undefined;
  if(typeof path!=='string'||ref.sha256!==undefined&&!validSHA(ref.sha256))return {verified:false};
  let declared:unknown;try{declared=this.projects.revision(revision??context.revision).manifest[path];}catch{return {verified:false};}
  let actual=context.manifest[path];
  if(!actual||entity){
   const candidates=context.files.filter(f=>f.state==='current'&&(entity?f.id===entity:f.path===path||f.paths?.includes(path))&&context.manifest[f.path]&&(entity||context.manifest[f.path]===f.digest));
   if(candidates.length===1)actual=context.manifest[candidates[0].path];else if(entity||!actual)actual=undefined;
   // Mirror the catalogue's unambiguous rename proof without updating its
   // cache. A status read can precede the next catalogue refresh.
   if(!actual&&entity){
    const record=context.files.find(f=>f.id===entity),known=new Set(context.files.filter(f=>f.state!=='missing').map(f=>f.path));
    if(record&&!context.manifest[record.path]){
     const removed=context.files.filter(f=>f.state!=='missing'&&!context.manifest[f.path]&&f.digest===record.digest),added=Object.keys(context.manifest).filter(p=>!known.has(p)&&context.manifest[p]===record.digest);
     if(removed.length===1&&added.length===1)actual=record.digest;
    }
   }
  }
  const sha256=ref.sha256??declared??actual;
  return {identity:entity?'file:'+entity:'path:'+path,sha256,observedSHA256:actual??null,verified:validSHA(sha256)&&validSHA(actual),path};
 }
 private descriptor(ref:Doc,context:Context,revision?:string):Doc {
  if(!ref||typeof ref!=='object'||Array.isArray(ref))return {verified:false};
  if(ref.path!==undefined)return this.file(ref,context,ref.revision??revision);
  if(typeof ref.mediaId==='string'){
   const media=context.media.get(ref.mediaId),sha256=ref.sha256??media?.sha256;
   return {identity:'media:'+ref.mediaId,sha256,observedSHA256:media?.sha256??null,verified:validSHA(sha256)&&validSHA(media?.sha256)};
  }
  if(typeof ref.attachmentKey==='string')return {identity:'attachment:'+ref.attachmentKey,sha256:ref.sha256,verified:validSHA(ref.sha256)};
  return {verified:false};
 }
 private reference(ref:Doc,context:Context,revision?:string):Doc {
  const value=this.descriptor(ref,context,revision);return {...value,bindingDigest:digest(Object.fromEntries(['id','role','kind','type','name'].filter(key=>ref&&Object.hasOwn(ref,key)).map(key=>[key,ref[key]])))};
 }
 private row(row:Doc,context:Context):Doc {
  const components:Doc={};
  for(const kind of ['script','storyboard']){
   const path=row[kind+'Path'],attachmentKey=row[kind+'Attachment'];
   components[kind]=path||attachmentKey?this.reference({path,attachmentKey,entityId:row[kind+'EntityId'],sha256:row[kind+'SHA256']},context,row[kind+'Revision']):null;
  }
  for(const kind of ['assets','outputs'])components[kind]=Array.isArray(row[kind])?row[kind].map((ref:Doc)=>this.reference(ref,context)).sort((a:Doc,b:Doc)=>JSON.stringify(stable(a)).localeCompare(JSON.stringify(stable(b)))):[];
  // Display labels, episode grouping, paths and revision labels can change
  // without changing the bytes or the photographed content.
  const content=Object.fromEntries(['duration','dayPeriod','kind','framing','visualDescription','characters','dialogue','scriptQuote','storyboardQuote'].filter(key=>Object.hasOwn(row,key)).map(key=>[key,row[key]]));
  return {entityId:shotEntityId(this.projects.projectId,row),label:row.id,versionId:shotView(this.projects.projectId,row).versionId,contentDigest:digest(content),components};
 }
 private assemblyDigest(job:Doc){return digest({sourceProvenance:job.sourceProvenance??null,resolvedGenerationInputs:job.resolvedGenerationInputs??null,outputSHA256:job.output?.sha256??null});}
 private upstream(clips:Doc[],context:Context,actor?:Doc):Doc[] {
  return clips.flatMap((clip,clipIndex)=>{
   const media=context.media.get(clip.mediaId);if(!media?.assemblyId)return [];
   const base={clipIndex,mediaId:clip.mediaId,sha256:clip.sha256},job=this.store.get('assembly-job',media.assemblyId);
   if(!actor||media.owner!==actor.id&&actor.role!=='admin')return [{...base,state:'private_source'}];
   if(!job||job.owner!==media.owner||job.mediaId!==media.id||job.state!=='ready'||!validSHA(clip.sha256)||media.sha256!==clip.sha256||job.output?.sha256!==clip.sha256||!job.sourceProvenance)return [{...base,state:'unverified'}];
   return [{...base,state:'recorded',assemblyId:job.id,owner:job.owner,baselineDigest:this.assemblyDigest(job)}];
  });
 }
 capture(clips:Doc[],actor?:Doc):Doc {
  try{
   const c=this.context();return {version:1,project:this.projects.projectId,revision:c.revision,indices:c.indices,capturedAt:now(),generationInputs:assemblyGenerationInputs(this.store,clips,actor),upstreamAssemblies:this.upstream(clips,c,actor),clips:clips.map((clip,index)=>{
    const matches=clip.mediaId?[...c.shots.values()].filter(row=>Array.isArray(row.outputs)&&row.outputs.some((ref:Doc)=>ref?.mediaId===clip.mediaId&&(!ref.sha256||ref.sha256===clip.sha256))):[];
    const ambiguous=matches.some(row=>c.ambiguous.has(shotEntityId(this.projects.projectId,row))),shots=matches.filter(row=>!c.ambiguous.has(shotEntityId(this.projects.projectId,row))).map(row=>this.row(row,c));
    return {index,mediaId:clip.mediaId,sha256:clip.sha256,jobId:clip.jobId,state:c.errors||ambiguous?'unknown':shots.length?'linked':'unlinked',shots};
   })};
  }catch{return {version:1,project:this.projects.projectId,capturedAt:now(),state:'unknown',clips:[]};}
 }
 status(snapshot:Doc|undefined,context?:Context,resolvedInputs?:Doc[]):Doc {
  return this.evaluate(snapshot,context,resolvedInputs,{active:new Set(),memo:new Map(),nodes:0,depth:0});
 }
 private evaluate(snapshot:Doc|undefined,context:Context|undefined,resolvedInputs:Doc[]|undefined,walk:Walk):Doc {
  const checkedAt=now(),changes:Doc[]=[],base={checkedAt,baselineRevision:snapshot?.revision,changes};
  if(!snapshot)return {...base,state:'legacy',summary:'历史拼接未留存项目来源快照，不能追认其提交时的来源版本。原片与成片可继续使用。'};
  if(snapshot.version!==1||snapshot.project!==this.projects.projectId||!Array.isArray(snapshot.clips)||snapshot.state==='unknown')return {...base,state:'unknown',summary:'来源版本暂未核实。原片和成片保留，不会自动替换或重新生成。'};
  try{
   const c=context??this.context(),unverifiedSources:Doc[]=[];let unknown=c.errors||snapshot.clips.some((clip:Doc)=>clip.state==='unknown'),linked=0,unlinked=0,inheritedInputs=false;
   for(const clip of snapshot.clips){
    if(!clip.shots?.length){unlinked++;continue;}
    for(const before of clip.shots){
     linked++;const row=c.shots.get(before.entityId),add=(category:string,message:string)=>changes.push({clipIndex:clip.index,shotEntityId:before.entityId,shotLabel:row?.id??before.label,category,message});
     if(c.ambiguous.has(before.entityId)){unknown=true;continue;}
     if(!row){if(!c.errors)add('removed','镜头关联已移除，当前成片仍使用原片。');continue;}
     const after=this.row(row,c),fingerprint=(ref:Doc)=>ref&&digest({identity:ref.identity,sha256:ref.sha256,observedSHA256:ref.observedSHA256,bindingDigest:ref.bindingDigest});
     for(const category of ['script','storyboard','assets','outputs']){
      const a=before.components?.[category],b=after.components[category],refs=(v:any)=>Array.isArray(v)?v:v?[v]:[];
      if([...refs(a),...refs(b)].some((ref:Doc)=>!ref.verified)){unknown=true;continue;}
      const value=(v:any)=>Array.isArray(v)?v.map(fingerprint).sort():fingerprint(v);
      if(digest(value(a))!==digest(value(b)))add(category==='outputs'?'adoption':category,({script:'剧本来源已更新',storyboard:'分镜来源已更新',assets:'参考资产来源已更新',outputs:'当前采用成果已更新'} as Doc)[category]+'，当前成片仍使用原片。');
     }
     if(before.contentDigest!==after.contentDigest)add('shot_content','镜头内容已更新，当前成片仍使用原片。');
    }
   }
   const generationInputs=resolvedInputs??snapshot.generationInputs??[],skill=this.currentSkill();
   for(const entry of generationInputs){
    const receipt=entry.receipt;if(!receipt?.input)continue;const impact=generationInputImpact(this.store,receipt,skill);for(const change of impact.changes)changes.push({clipIndex:entry.clipIndex,...change});if(impact.state==='unknown'||impact.unverified.length)unknown=true;
   }
   const edges=Array.isArray(snapshot.upstreamAssemblies)?snapshot.upstreamAssemblies:[];
   for(const clip of snapshot.clips){
    const matches=edges.filter((edge:Doc)=>edge?.clipIndex===clip.index),edge=matches[0],media=c.media.get(clip.mediaId);
    if(!matches.length&&!media?.assemblyId)continue;
    const unverifiable=(message:string)=>{unknown=true;unverifiedSources.push({clipIndex:clip.index,clipPath:[clip.index],message});};
    if(matches.length!==1){unverifiable('这条片段来自另一份拼接，但提交时未留存唯一的上游来源回执，未用当前资料补写历史。');continue;}
    if(edge.state==='private_source'){unverifiable('复用成果的内部来源属于原作者；当前原件可用，未展开或确认其私有来源。');continue;}
    if(edge.state!=='recorded'||!validSHA(edge.baselineDigest)||!media||media.assemblyId!==edge.assemblyId||media.owner!==edge.owner||media.id!==edge.mediaId||clip.mediaId!==edge.mediaId||!validSHA(edge.sha256)||clip.sha256!==edge.sha256||media.sha256!==edge.sha256){unverifiable('上游成片的身份或版本暂未核实，当前成片保留原片。');continue;}
    const job=this.store.get('assembly-job',edge.assemblyId);
    if(!job||job.id!==edge.assemblyId||job.owner!==edge.owner||job.mediaId!==edge.mediaId||job.output?.sha256!==edge.sha256||this.assemblyDigest(job)!==edge.baselineDigest){unverifiable('上游成片的冻结来源记录缺失或已变化，未将其判为未变化。');continue;}
    // Bounds protect a read from malformed or exceptionally large lineage;
    // they never reject a submission or alter media and generation records.
    if(walk.active.has(job.id)||walk.depth>=64||!walk.memo.has(job.id)&&walk.nodes>=1024){unverifiable('上游来源关联过深、重复循环或过多，部分来源待进一步核对。');continue;}
    let inherited=walk.memo.get(job.id);
    if(!inherited){walk.active.add(job.id);walk.depth++;walk.nodes++;try{inherited=this.evaluate(job.sourceProvenance,c,job.resolvedGenerationInputs,walk);walk.memo.set(job.id,inherited);}finally{walk.active.delete(job.id);walk.depth--;}}
    linked+=inherited.linkedShots??0;inheritedInputs||=Boolean(inherited.hasRecordedGenerationInputs);
    if(inherited.linkedShots&&!clip.shots?.length)unlinked--;
    for(const change of inherited.changes??[])changes.push({...change,clipIndex:clip.index,clipPath:[clip.index,...(change.clipPath??[change.clipIndex])],sourceAssemblyId:job.id});
    for(const item of inherited.unverifiedSources??[])unverifiedSources.push({...item,clipIndex:clip.index,clipPath:[clip.index,...(item.clipPath??[item.clipIndex])]});
    if(['unknown','legacy'].includes(inherited.state)||inherited.hasUnverifiedSources){unknown=true;if(!inherited.unverifiedSources?.length)unverifiedSources.push({clipIndex:clip.index,clipPath:[clip.index],message:'这条片段的上游来源未完整核实，当前原片保留。'});}
   }
   const state=changes.length?'changed':unknown?'unknown':!linked?'unlinked':'current';
   const recordedInputs=inheritedInputs||generationInputs.some((entry:Doc)=>validGenerationInput(entry.receipt?.input));
   const summary=state==='changed'?'来源已更新。当前成片保留原片；需要新版时可在聊天新建一版。'+(unknown?'另有部分来源未核实。':''):state==='unknown'?'部分来源版本暂未核实，原片与成片可继续使用。':state==='unlinked'?recordedInputs?'本任务冻结输入已记录；尚未关联项目镜头，不会猜测对应的项目文件。':'原片已冻结，提交时未找到可核对的项目镜头关联，不能推断其剧本或资产来源。':'已核对的项目来源未变化。'+(unlinked?'另有片段提交时未关联项目镜头。':'');
   return {...base,state,summary,linkedShots:linked,unlinkedClips:unlinked,hasUnverifiedSources:unknown,hasRecordedGenerationInputs:recordedInputs,unverifiedSources};
  }catch{return {...base,state:'unknown',summary:'当前项目来源暂未读取，原片与成片保留，可稍后重试核对。'};}
 }
}
