import {existsSync,readFileSync,mkdirSync,appendFileSync} from 'node:fs';
import {join,isAbsolute} from 'node:path';
import {CodexClient} from './codex-client.ts';
import {hash,id,now,requireThat,type Doc} from './store.ts';
import {storeRedactor} from './incident-context.ts';
import {teamDefinitions,teamInstructions} from '../native-harness/team-project/index.mjs';
import type {Instance,NativeHarness} from './native-harness.ts';

export type CodexHostConfig={enabled:boolean;command:string;home:string;model?:string;timeoutMs?:number};
const terminal=new Set(['completed','failed','interrupted','cancelled']);
const stable=(v:any):any=>Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v;
const excluded=new Set(['issue_report','codex_run','codex_status','codex_cancel']);
type Live={controller:AbortController;done:Promise<void>;client?:CodexClient;turn?:string;thread?:string};
export class HostCodex {
  private active=new Map<string,Live>();
  private tails=new Map<string,Promise<void>>();
  private closing=false;
  readonly config?:CodexHostConfig;
  constructor(private native:NativeHarness,config?:CodexHostConfig,private clientFactory=(o:{command:string;cwd:string;home:string})=>new CodexClient(o)){
    const path=join(native.store.root,'codex-agent.json');
    this.config=config??(existsSync(path)?JSON.parse(readFileSync(path,'utf8')):undefined);
    for(const run of native.store.all('codex-run'))if(!terminal.has(run.state))native.store.put('codex-run',{...run,state:'interrupted',finished:now(),error:'主机重启中断；保留上下文与已提交任务，未自动重发。'});
  }
  private check(i:Instance){const user=this.native.store.get('user',i.owner);requireThat(user?.active&&this.native.policy(i.project).enabled,'账号不可用',403);return user;}
  private read(i:Instance,runId:string){this.check(i);const run=this.native.store.get('codex-run',runId);requireThat(run&&run.owner===i.owner&&run.project===i.project&&run.instance===i.key,'Codex 任务不存在或无权限',404);return run;}
  card(i:Instance,runId:string){const r=this.read(i,runId);const results=(r.planRefs??[]).map((p:Doc)=>{try{return this.native.team.card(i,p.kind,this.native.team.plan(i,p.kind,p.id));}catch{return null;}}).filter(Boolean);return {kind:'codex',run:{id:r.id,state:r.state,model:r.model,text:r.text,error:r.error,created:r.created,finished:r.finished,sessionId:r.nativeSession,steps:r.steps??[],question:r.question??null,results},sessionId:r.nativeSession};}
  list(i:Instance,sessionId:string){this.check(i);return {configured:!!this.config?.enabled,items:this.native.store.all('codex-run',i.owner).filter(r=>r.project===i.project&&r.nativeSession===sessionId&&r.instance===i.key).sort((a,b)=>b.created.localeCompare(a.created)).slice(0,20).map(r=>this.card(i,r.id))};}
  start(i:Instance,b:Doc){
    this.check(i);requireThat(!this.closing&&this.config?.enabled,'主机尚未配置 Codex 调用',503);
    requireThat(isAbsolute(this.config.command)&&isAbsolute(this.config.home)&&existsSync(this.config.command)&&existsSync(this.config.home),'主机 Codex 路径不可用，请检查安装',503);
    requireThat(typeof b.args?.prompt==='string'&&b.args.prompt.trim()&&b.args.prompt.length<=100000,'请提供 Codex 任务内容',422);
    requireThat(typeof b.sessionId==='string'&&b.sessionId.length>0&&b.sessionId.length<200&&typeof b.sourceMessageId==='string'&&b.sourceMessageId.length>0,'缺少当前聊天和成员消息',422);
    requireThat(b.args.model===undefined||typeof b.args.model==='string','模型名称无效',422);
    const references=b.args.reference_media_ids??[];requireThat(Array.isArray(references)&&references.length<=12&&references.every(v=>typeof v==='string'),'参考图编号无效',422);
    const inputs=this.images(i,references);
    const binding=hash(JSON.stringify([i.key,b.sessionId,'codex']));
    const runId=hash(JSON.stringify([binding,b.sourceMessageId,stable(b.args)]));
    if(this.native.store.get('codex-run',runId))return this.card(i,runId);
    const run={id:runId,owner:i.owner,project:i.project,instance:i.key,nativeSession:b.sessionId,binding,sourceMessageId:b.sourceMessageId,sourceText:b.sourceText??'',prompt:b.args.prompt,model:b.args.model??this.config.model,state:'queued',created:now(),text:'',steps:[],inputMedia:references};
    this.native.store.put('codex-run',run);this.native.store.audit(i.owner,'codex.request',runId,{project:i.project,session:b.sessionId});
    const controller=new AbortController();const before=this.tails.get(binding)??Promise.resolve();
    const live:Live={controller,done:Promise.resolve()};this.active.set(runId,live);
    // A single conversation retains ordered context; other conversations run concurrently.
    live.done=before.catch(()=>{}).then(()=>this.execute(i,runId,inputs,live)).finally(()=>{this.active.delete(runId);if(this.tails.get(binding)===live.done)this.tails.delete(binding);});
    this.tails.set(binding,live.done);return this.card(i,runId);
  }
  private images(i:Instance,ids:string[]){const {pickups}=this.native.workspace(i.project);return ids.map(mediaId=>{const m=pickups.media.get(mediaId);requireThat((m.owner===i.owner||m.scope==='project')&&m.mime.startsWith('image/'),'参考图不属于当前成员或项目',403);return {type:'localImage',path:pickups.media.path(mediaId)};});}
  private update(runId:string,patch:Doc){const prior=this.native.store.get('codex-run',runId)!;return this.native.store.put('codex-run',{...prior,...patch,updated:now()});}
  private async execute(i:Instance,runId:string,images:Doc[],live:Live){
    const run=this.native.store.get('codex-run',runId)!;
    if(live.controller.signal.aborted){this.update(runId,{state:'cancelled',finished:now()});return;}
    const safe=storeRedactor(this.native.store),eventDir=join(this.native.store.root,'codex-agent-events');mkdirSync(eventDir,{recursive:true,mode:0o700});
    const event=(method:string,params:Doc)=>appendFileSync(join(eventDir,runId+'.jsonl'),JSON.stringify({at:now(),method,params:safe.clean(params)})+'\n',{mode:0o600});
    const client=this.clientFactory({command:this.config!.command,home:this.config!.home,cwd:i.work});live.client=client;
    let resolveTurn!:()=>void,rejectTurn!:(e:Error)=>void,text='',lastMessage='',flushTimer:NodeJS.Timeout|undefined;
    const complete=new Promise<void>((resolve,reject)=>{resolveTurn=resolve;rejectTurn=reject;});void complete.catch(()=>{});
    const flush=()=>{clearTimeout(flushTimer);flushTimer=undefined;this.update(runId,{text:safe.text(text)});};
    const stop=()=>rejectTurn(Error('Codex 执行已停止；已提交的生成任务继续独立跟踪'));
    live.controller.signal.addEventListener('abort',stop,{once:true});
    const timer=setTimeout(()=>rejectTurn(Error('Codex 本轮超时，未自动重发，可在原聊天继续')),this.config!.timeoutMs??20*60*1000);
    client.onDisconnect=rejectTurn;
    client.onEvent=(method,p)=>{
      if(p.threadId&&live.thread&&p.threadId!==live.thread)return;
      event(method,p);
      if(method==='item/agentMessage/delta'){if(p.itemId&&p.itemId!==lastMessage){if(text)text+='\n\n';lastMessage=p.itemId;}text+=p.delta??'';if(text.length>1024*1024)throw Error('Codex 本轮回答过大');if(!flushTimer)flushTimer=setTimeout(flush,150);}
      if(method==='item/completed'&&p.item?.type==='agentMessage'&&typeof p.item.text==='string'&&!text)text=p.item.text;
      if(method==='turn/started')live.turn=p.turn?.id;
      if(method==='item/started'||method==='item/completed'){
        const r=this.native.store.get('codex-run',runId)!,item=p.item??{},key=item.id??id(),steps=[...(r.steps??[])],index=steps.findIndex(v=>v.id===key);
        const step={id:key,type:item.type,name:item.tool??item.name??item.type,state:method==='item/started'?'running':item.status??'completed'};
        if(index<0)steps.push(step);else steps[index]=step;this.update(runId,{steps:steps.slice(-100)});
      }
      if(method==='thread/tokenUsage/updated')this.update(runId,{usage:p.tokenUsage});
      if(method==='turn/completed'){flush();if(p.turn?.status==='completed')resolveTurn();else rejectTurn(Error(p.turn?.error?.message??'Codex 本轮未完成'));}
    };
    client.onRequest=async(method,p)=>{
      this.check(i);requireThat(p.threadId===live.thread,'Codex 工具会话不匹配',403);
      if(method!=='item/tool/call')throw Error('本轮需要原生交互：'+method+'，请在聊天补充要求后继续');
      const def=teamDefinitions.find(([name,,action])=>name===p.tool&&!excluded.has(action));
      requireThat(def,'Codex 工具未注册',404);
      event('host/tool-start',{tool:p.tool,callId:p.callId});
      try{
        const value=await this.native.team.tool(i,this.check(i),{action:def[2],args:p.arguments,sessionId:run.nativeSession,callId:'codex:'+runId+':'+p.callId,sourceMessageId:run.sourceMessageId,sourceText:run.sourceText});
        if(['image','video'].includes(value?.kind)&&value?.plan?.id){const refs=this.native.store.get('codex-run',runId)!.planRefs??[];if(!refs.some((v:Doc)=>v.kind===value.kind&&v.id===value.plan.id))this.update(runId,{planRefs:[...refs,{kind:value.kind,id:value.plan.id}]});}
        event('host/tool-result',{tool:p.tool,callId:p.callId,result:value});
        return {success:true,contentItems:[{type:'inputText',text:JSON.stringify(value)}]};
      }catch(error){const message=safe.text(error instanceof Error?error.message:'主机工具失败');event('host/tool-error',{tool:p.tool,error:message});return {success:false,contentItems:[{type:'inputText',text:message}]};}
    };
    i.active++;this.native.touch(i);
    try{
      this.check(i);this.update(runId,{state:'running'});await client.connect();
      let cursor:string|undefined;const models:Doc[]=[];
      do{const page=await client.request('model/list',{limit:100,...(cursor?{cursor}: {})});models.push(...page.data??[]);cursor=page.nextCursor??undefined;}while(cursor);
      if(run.model)requireThat(models.some(m=>m.id===run.model||m.model===run.model),'当前 Codex 账号没有该模型',422);
      const binding=this.native.store.get('codex-binding',run.binding);
      const developerInstructions=teamInstructions+'\n你是当前原生会话委托的 Codex。用户仍在原聊天中查看进度与结果。仅执行本次任务，保持同一上下文。所有主机生成使用提供的 team_* 工具；主机文件操作使用 team_host_files，遵循原有禁止删除规则。视频技能位于 '+join(this.native.codeRoot,'video-skills')+'，可读取技能文件。/workspace 是成员工作区，主机实际路径为 '+i.work+'。生成结果必须返回主机真实任务编号，不能把 queued 写成供应商已收单。';
      const params={cwd:i.work,approvalPolicy:'never',sandbox:'workspace-write',...(run.model?{model:run.model}:{}),developerInstructions};
      const result=binding?.threadId?await client.request('thread/resume',{...params,threadId:binding.threadId}):await client.request('thread/start',{...params,dynamicTools:teamDefinitions.filter(([, ,action])=>!excluded.has(action)).map(([name,description,,properties,required=[]])=>({name,description,inputSchema:{type:'object',properties,required,additionalProperties:false}}))});
      requireThat(typeof result.thread?.id==='string','Codex 未返回会话编号',502);live.thread=result.thread.id;
      requireThat(!binding?.threadId||binding.threadId===live.thread,'Codex 恢复了错误会话',409);
      this.native.store.put('codex-binding',{id:run.binding,owner:i.owner,project:i.project,nativeSession:run.nativeSession,instance:i.key,threadId:live.thread,updated:now()});
      this.update(runId,{threadId:live.thread,model:result.model??run.model});
      live.controller.signal.throwIfAborted();
      const turn=await client.request('turn/start',{threadId:live.thread,input:[{type:'text',text:run.prompt},...images]});live.turn=turn.turn?.id??live.turn;
      await complete;live.controller.signal.throwIfAborted();this.update(runId,{state:'completed',text:safe.text(text),finished:now()});
    }catch(error){
      if(live.thread&&live.turn)await client.request('turn/interrupt',{threadId:live.thread,turnId:live.turn},3000).catch(()=>{});
      this.update(runId,{state:live.controller.signal.aborted?'cancelled':'failed',text:safe.text(text),error:safe.text(error instanceof Error?error.message:'Codex 执行失败'),finished:now()});
    }finally{clearTimeout(timer);clearTimeout(flushTimer);live.controller.signal.removeEventListener('abort',stop);await client.close();i.active--;this.native.touch(i);}
  }
  cancel(i:Instance,runId:string){const run=this.read(i,runId);this.active.get(runId)?.controller.abort();if(run.state==='queued')this.update(runId,{state:'cancelled',finished:now()});return this.card(i,runId);}
  async close(){this.closing=true;for(const r of this.active.values())r.controller.abort();await Promise.allSettled([...this.active.values()].map(r=>r.done));}
}
