import {hash,now,type Store,type Doc} from './store.ts';
const stable=(value:any):any=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;
const normalized=(value:unknown)=>JSON.parse(JSON.stringify(value));
const digest=(value:unknown)=>hash(JSON.stringify(stable(value))??'null');
const textHash=(value:unknown)=>typeof value==='string'?hash(value):null;
const same=(a:unknown,b:unknown)=>digest(a)===digest(b);
const sha=(value:unknown)=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);

/** Byte/version receipts, not copies of prompts or private Skill instructions.
 * A dispatch intent proves what the host prepared, not supplier acceptance. */
export function freezeGenerationInput(store:Store,kind:'video'|'image',plan:Doc,shot?:Doc):Doc {
 const selected=shot??plan,source=selected.source??{},assets:Doc[]=selected.assets??[],template=plan.promptTemplate??plan.template;
 let skill:Doc|undefined;
 if(plan.skillExecution){
  const execution=plan.skillExecution,run=store.get('private-skill-run',execution.id),node=run?.result?.nodes?.[execution.node??0];
  const verified=run?.state==='completed'&&run.owner===plan.owner&&(run.project??'shared')===(plan.project??'shared')&&run.session===plan.nativeSession&&run.videoModelId===plan.model.id&&node?.prompt===selected.prompt&&same(node.params,selected.params)&&['image','video','audio'].every(mediaKind=>same(assets.filter(a=>(a.mediaKind??'image')===mediaKind).map(a=>a.mediaId),node[({image:'referenceMediaIds',video:'referenceVideoIds',audio:'referenceAudioIds'} as Doc)[mediaKind]]??[]))&&sha(run.skill?.sha256);
  skill={runId:execution.id,node:execution.node??0,verified:!!verified,...(verified?{id:run.skill.id,version:run.skill.version,sha256:run.skill.sha256}:{} )};
 }
 const value=normalized({version:1,basis:'frozen_generation_input',kind,project:plan.project??store.projectId??'shared',owner:plan.owner,planId:plan.id,sourceId:source.id,sourceEntityId:source.entityId,sourceVersionId:source.versionId,sourceKind:plan.sourceKind??(kind==='image'?'image_request':'published_project'),projectRevision:plan.base,
  model:{id:plan.model.id,remoteModel:plan.model.remoteModel,revision:plan.model.revision,channelId:plan.model.channelId,channelRevision:plan.channelRevision,capabilityHash:plan.model.capabilityHash},
  template:template?{id:template.id,revision:template.revision,version:template.version,kind:typeof template.body==='string'?'published_template':'builtin_adapter',bodySHA256:textHash(template.body)}:undefined,skill,
  content:{promptSHA256:textHash(selected.prompt??plan.prompt),scriptSHA256:textHash(source.scriptQuote??plan.parsed?.script),storyboardSHA256:textHash(source.storyboardQuote),notesSHA256:textHash(plan.parsed?.notes),paramsSHA256:digest(selected.params??{}),referenceMode:selected.referenceMode??null},
  references:assets.map(a=>({mediaId:a.mediaId,sha256:a.sha256,mime:a.mime,mediaKind:a.mediaKind??'image'})),projectReads:plan.reads??{}});
 return {...value,digest:digest(value)};
}
export function validGenerationInput(value:unknown):value is Doc {
 if(!value||typeof value!=='object'||Array.isArray(value))return false;const {digest:saved,...body}=value as Doc;
 return body.version===1&&body.basis==='frozen_generation_input'&&['image','video'].includes(body.kind)&&typeof body.planId==='string'&&typeof body.owner==='string'&&sha(saved)&&digest(body)===saved;
}
export function dispatchInputIntent(store:Store,kind:'video'|'image',job:Doc,plan:Doc,shot?:Doc){
 const value={version:1,stage:'dispatch_intent',sequence:(job.dispatchInputs?.length??0)+1,at:now(),jobId:job.id,authorizationInputDigest:validGenerationInput(job.authorizedInput)?job.authorizedInput.digest:null,input:freezeGenerationInput(store,kind,plan,shot),requestHash:job.requestHash,requestHashBasis:kind==='video'?'video_adapter_payload_json':'image_plan_and_media_digests'};
 return {...value,digest:digest(value)};
}
export function generationInputSummary(job:Doc):Doc|undefined {
 const original=job.authorizedInput,intents=job.dispatchInputs??[];
 if(!Array.isArray(intents))return {state:'unverified',note:'生成输入回执不是有效数组，未用当前方案补写历史依据。'};
 const last=intents.at(-1),effective=last?.input;
 if(!original&&!intents.length)return undefined;
 const matches=(input:Doc)=>validGenerationInput(input)&&input.planId===job.planId&&input.owner===job.owner&&input.project===(job.project??'shared')&&input.sourceId===job.sourceId;
 const valid=(!original||matches(original))&&Array.isArray(intents)&&intents.every((entry:Doc,index:number)=>{
  if(!entry||typeof entry!=='object')return false;const {digest:saved,...body}=entry;
  return body.version===1&&body.stage==='dispatch_intent'&&body.jobId===job.id&&body.sequence===index+1&&body.authorizationInputDigest===(original?.digest??null)&&matches(body.input)&&sha(saved)&&digest(body)===saved;
 });
 if(!valid)return {state:'unverified',note:'生成输入回执不完整或校验不一致，未用当前方案补写历史依据。'};
 return {state:original?'recorded':'dispatch_only',authorizationDigest:original?.digest??null,dispatchIntentCount:intents.length,...(effective?{dispatchDigest:last.digest,input:effective,stage:'dispatch_intent',acceptance:job.remoteTaskId||job.receipt?'provider_receipt_recorded':'not_proven'}:{input:original,stage:'authorized_input',acceptance:'not_proven'}),note:'记录本任务已冻结的输入和提交意图；供应商接单、成功及原件可用分别以任务状态和回执为准。'};
}
export function assemblyGenerationInputs(store:Store,clips:Doc[],actor?:Doc){
 const jobs=store.all('video-job');return clips.map((clip,clipIndex)=>{
  const matches=clip.jobId?jobs.filter(j=>j.id===clip.jobId):jobs.filter(j=>j.mediaId===clip.mediaId&&j.mediaSHA256===clip.sha256);
  if(matches.length!==1)return {clipIndex,state:'unrecorded'};
  const job=matches[0];if(!actor||job.owner!==actor.id&&actor.role!=='admin')return {clipIndex,state:'private_source'};
  if(clip.mediaId&&(job.mediaId!==clip.mediaId||job.mediaSHA256!==clip.sha256))return {clipIndex,state:'unverified'};
  const receipt=generationInputSummary(job);return normalized({clipIndex,jobId:job.id,planId:job.planId,state:receipt?.state??'unrecorded',...(receipt?{receipt}:{} )});
 });
}
