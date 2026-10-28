import {freezeGenerationInput} from './generation-input-provenance.ts';
import {hash,now,requireThat,type Doc} from './store.ts';
import {mediaKind,validateVideoReferences} from './media-capabilities.ts';
import {text} from './video-catalog.ts';
import {validParams,renderTemplate} from './pickup-input.ts';
import {storyboardEnabled,storyboardSkill,videoFamily} from './video-storyboard.ts';
import type {Pickups} from './pickups.ts';
import {projectSharedMedia} from './media.ts';

// Conversation inputs are frozen as their own source, never fabricated as quotes
// from the administrator's published script index. Revisions retain source/round.
export const CONVERSATION_TEMPLATE='team-conversation-v1';
export function prepareConversation(pickups:Pickups,task:Doc,b:Doc):Doc {
 const {store,projects}=pickups,existing=store.get('pickup',task.id);if(existing)return existing;
 const user=store.get('user',task.owner)!;
 const model=pickups.catalog.models(user).find(m=>m.id===b.model_id&&(m.status==='published'||m.status==='testing'&&(user.role==='admin'||m.memberAccess)));
 requireThat(model,'请从项目开放的视频模型目录选择模型',422);
 const channel=store.get('video-channel',model.channelId);requireThat(channel?.enabled&&channel.verified&&channel.revision===model.channelRevision,'渠道已改变，请管理员核对',409);
 let previous:Doc|undefined;
 if(b.previous_plan_id){previous=pickups.get(String(b.previous_plan_id),user);requireThat(previous.owner===user.id&&previous.shots.length===1,'只能修正本人的聊天补抽方案',403);}
 const finalPrompt=b.final_prompt===undefined?undefined:text(b.final_prompt,'智能体整理后的最终提示词',16000);
 requireThat(!storyboardEnabled(store)||!videoFamily(model)||finalPrompt,'请在当前聊天读取 video-storyboard 技能，整理并核对后将最终提示词放入 final_prompt',422);
 const script=text(b.script??previous?.parsed.script,'剧本片段或画面要求',8000),notes=text(b.notes,'补抽意见',6000);
 const storyboard=text(b.storyboard??previous?.shots[0].source.storyboardQuote??script,'分镜画面',8000);
 const seconds=Number(b.params?.seconds??previous?.shots[0].params.seconds??4);
 requireThat(Number.isFinite(seconds)&&seconds>=4&&seconds<=120,'请输入模型支持的时长',422);
 const inherited=previous&&previous.model.id===model.id?previous.shots[0].params:{};
 const params=validParams(model,{...inherited,...b.params},seconds);
 const refLists=[['image',b.reference_media_ids],['video',b.reference_video_ids],['audio',b.reference_audio_ids]] as const;
 const supplied=refLists.some(([,v])=>v!==undefined);
 const entries=supplied?refLists.flatMap(([kind,list])=>{requireThat(Array.isArray(list??[])&&(list??[]).length<=30,'参考媒体列表无效');return (list??[]).map((mediaId:string)=>({mediaId,kind}));}):previous?.shots[0].assets.map((a:Doc)=>({mediaId:a.mediaId,kind:a.mediaKind??'image'}))??[];
 requireThat(new Set(entries.map((a:Doc)=>a.mediaId)).size===entries.length,'参考媒体重复');
 const assets=entries.map(({mediaId,kind}:Doc,index:number)=>{const m=pickups.media.get(mediaId);requireThat((projectSharedMedia(store,m)||m.owner===user.id)&&mediaKind(m.mime)===kind,'只能使用当前项目或本人对应类型的媒体',403);return {id:'reference-'+(index+1),mediaId:m.id,sha256:m.sha256,mime:m.mime,mediaKind:kind,role:`${kind} ${index+1}：${m.name}`};});
 const referenceMode=validateVideoReferences(model,assets,b.reference_mode??(previous&&previous.model.id===model.id?previous.shots[0].referenceMode:undefined));
 requireThat(!assets.length||store.get('video-storage','active')?.enabled||channel.adapter==='xiaopei'&&pickups.adapter.upload,'参考图托管尚未配置',409);
 const sourceId=previous?.shots[0].source.id??'chat-'+hash(JSON.stringify([user.id,task.session,task.id])).slice(0,24);
 const source={id:sourceId,episode:'项目聊天',scriptQuote:script,storyboardQuote:storyboard,duration:seconds,origin:'member_conversation',characters:[],dialogue:[],assets};
 const references=assets.length?assets.map((a:Doc)=>a.role).join('\n'):'无参考图；依据剧本描述生成。';
 const structure=model.referenceMode==='first_frame'?'以第一张原图作为首帧，延续主体与环境。':assets.length?'按编号绑定参考图；身份、服装及道具归属保持一致。':'按剧本独立构图。';
 const selectedTemplate=!finalPrompt&&store.all('video-template').filter(t=>t.nativeEnabled&&t.projectId===projects.projectId&&t.status==='published'&&(!t.modelIds.length||t.modelIds.includes(model.id))).sort((a,b)=>Number(!!b.default)-Number(!!a.default)||String(b.created).localeCompare(String(a.created)))[0];
 const promptTemplate=selectedTemplate?{id:selectedTemplate.id,revision:selectedTemplate.revision,version:selectedTemplate.version??1,title:selectedTemplate.name,body:selectedTemplate.body,rendered:renderTemplate(selectedTemplate.body,{script,storyboard,notes,assets:references,dayPeriod:'按剧本',duration:String(seconds),dialogue:'按剧本原文',wardrobe:'保持参考资产一致',visualDescription:storyboard})}:undefined;
 const prompt=finalPrompt??`生成一条 ${seconds} 秒短剧镜头。\n模型参数：${JSON.stringify(params)}\n参考方式：${structure}\n剧本原文：\n${script}\n分镜与动作：\n${storyboard}\n本次修改意见：\n${notes}\n参考资产：\n${references}\n按上述时长完成连贯动作，保持人物、道具与空间连续性。不得添加剧本之外的字幕、水印或额外对白。${promptTemplate?`\n项目提示词模板（版本 ${promptTemplate.version}）：\n${promptTemplate.rendered}`:''}`;
 const previousPath=`成果/补抽/${sourceId}/当前采用.json`;
 const shot={source,assets,params,prompt,referenceMode,modelId:model.id,remoteModel:model.remoteModel,channelName:channel.name,templateName:'项目聊天 · 模型结构适配',estimate:{amount:model.pricePerSecond==null?null:model.pricePerSecond*seconds,currency:model.currency,status:'estimate_not_bill'},previousPath,previousDigest:projects.revision(task.base).manifest[previousPath]??null};
 const plan:Doc={id:task.id,task:task.id,owner:user.id,session:task.session,nativeSession:task.nativeSession,project:projects.projectId,base:task.base,sourceKind:'conversation',...(finalPrompt?{...(videoFamily(model)?{skill:storyboardSkill()}:{}),promptOrigin:b.skill_run_id?'host-private-skill':'native-agent',...(b.skill_run_id?{skillExecution:{id:b.skill_run_id,node:b.skill_node??0}}:{})}:{}),...(promptTemplate?{promptTemplate}:{}),previousPlanId:previous?.id??null,originalInput:task.prompt,created:now(),state:'awaiting_confirmation',parsed:{script,notes,model:model.name,params},model,template:{id:CONVERSATION_TEMPLATE,revision:CONVERSATION_TEMPLATE},channelRevision:channel.revision,storageRevision:store.get('video-storage','active')?.revision??null,reads:previous?.reads??{},shots:[shot],issues:[]};
 const frozen=freezeGenerationInput(store,'video',plan,shot);if(frozen.skill?.verified)plan.skill={id:frozen.skill.id,version:frozen.skill.version,sha256:frozen.skill.sha256};else if(plan.skillExecution)plan.promptOrigin='native-agent';
 store.put('pickup',{...plan,digest:hash(JSON.stringify(plan))});store.audit(user.id,'native.pickup.prepare',plan.id,{nativeSession:task.nativeSession,previousPlanId:plan.previousPlanId});return store.get('pickup',plan.id)!;
}
