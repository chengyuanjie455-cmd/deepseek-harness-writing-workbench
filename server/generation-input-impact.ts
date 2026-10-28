import {generationInputSummary,validGenerationInput} from './generation-input-provenance.ts';
import {privateSkillDefinitionStatus} from './private-skill-definition.ts';
import {hash,now,type Store,type Doc} from './store.ts';
const sha=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
/** Compare recorded versions with current configuration. This is not a content
 * quality verdict, a byte check, or authorization to regenerate old work. */
export function generationInputImpact(store:Store,receipt:Doc|undefined,currentSkill?:Doc):Doc {
 const changes:Doc[]=[],unverified:Doc[]=[],base={checkedAt:now(),changes,unverified};
 if(!receipt)return {...base,state:'legacy',summary:'历史任务没有生成输入回执，不用当前配置补写其历史版本。'};
 const input=receipt.input;
 if(!['recorded','dispatch_only'].includes(receipt.state)||!validGenerationInput(input))return {...base,state:'unknown',summary:'生成输入回执暂未核实，原件仍可使用。'};
 const changed=(category:string,message:string)=>changes.push({category,message}),unknown=(category:string,message:string)=>unverified.push({category,message});
 const model=input.model;
 if(!model||typeof model.id!=='string')unknown('model','任务型号版本记录不完整。');
 else{
  const current=store.get(input.kind==='image'?'image-model':'video-model',model.id);
  if(!current)changed('model','当前已不再配置该任务型号，原片仍保留生成时的型号记录。');
  else if(['revision','remoteModel','channelId','capabilityHash'].some(k=>model[k]!==undefined&&current[k]!==model[k]))changed('model','当前型号配置版本已更新；这不表示原片内容失效，也不能据此判定供应商能力有变。');
  if(model.channelId&&model.channelRevision){const channel=store.get('video-channel',model.channelId);if(!channel||channel.revision!==model.channelRevision)changed('channel','当前调用渠道配置版本已更新或不再配置，原任务仍保留原提交记录。');}
 }
 const template=input.template;
 if(template?.kind==='published_template'){
  if(typeof template.id!=='string'||!sha(template.bodySHA256))unknown('template','任务提示词模板版本记录不完整。');
  else{const current=store.get('video-template',template.id);if(!current||current.revision!==template.revision||hash(current.body??'')!==template.bodySHA256)changed('template','当前提示词模板已更新或不再配置，原片仍保留本任务生成时的模板版本。');}
 }
 const skill=input.skill;
 if(skill){
  if(!skill.verified||!sha(skill.sha256))unknown('private_skill','本任务的主机技能执行版本未核实。');
  else {const current=currentSkill??privateSkillDefinitionStatus();if(current.state!=='ready'||current.metadata?.id!==skill.id||!sha(current.metadata?.sha256))unknown('private_skill','主机当前技能定义暂未核实，未将其判为未变化。');
   else if(current.metadata.sha256!==skill.sha256)changed('private_skill','主机技能定义已更新，原片仍使用本任务已记录的执行版本，内部技能原文不下发。');}
 }
 if(!Array.isArray(input.references))unknown('reference','任务参考原件版本记录不完整。');
 else for(const ref of input.references){
  if(!ref||typeof ref.mediaId!=='string'||!sha(ref.sha256)){unknown('reference','有参考原件版本记录不完整。');continue;}
  const current=store.get('media',ref.mediaId);
  if(!current||!sha(current.sha256))unknown('reference','有参考原件的当前台账暂未核实。');
  else if(current.sha256!==ref.sha256)changed('reference','参考原件台账中的版本已变化；实际原件字节仍需按下载校验结果核对。');
 }
 const state=changes.length?'changed':unverified.length?'unknown':'current';
 return {...base,state,summary:state==='changed'?'生成依据的当前配置已有更新，原任务输入和原件保留；需要新版时可在聊天提出。'+(unverified.length?'另有部分版本待核对。':''):state==='unknown'?'部分生成依据的当前版本暂未核实，原任务输入和原件保留。':'已记录的生成依据与当前配置版本一致；这不替代原件字节校验或内容审核。'};
}
export function generationInputWithImpact(store:Store,job:Doc,currentSkill?:Doc):Doc|undefined {
 const receipt=generationInputSummary(job);return receipt?{...receipt,current:generationInputImpact(store,receipt,currentSkill)}:undefined;
}
