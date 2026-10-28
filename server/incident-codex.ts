import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {mkdirSync,writeFileSync,readFileSync,existsSync,readdirSync,lstatSync,copyFileSync,symlinkSync,realpathSync,chmodSync,rmSync} from 'node:fs';
import {join,resolve,relative,sep} from 'node:path';
import {hash,requireThat,type Doc} from './store.ts';
import {redactor} from './incident-context.ts';
export type Decision={action:'recover'|'code_fix'|'needs_info'|'blocked'|'verify';message:string;kind:string;jobId:string};
export type CodexInput={workspace:string;evidence:string;thread?:string;prompt:string;signal:AbortSignal;onEvent:(v:Doc)=>void};
export interface IncidentRunner { run(input:CodexInput):Promise<Decision> }
export type CodexOptions={command:string;home:string;model?:string;timeoutMs?:number};
const schema={type:'object',additionalProperties:false,required:['action','message','kind','jobId'],properties:{action:{type:'string',enum:['recover','code_fix','needs_info','blocked','verify']},message:{type:'string'},kind:{type:'string',enum:['','video-job','image-job']},jobId:{type:'string'}}};
export function parseDecision(value:any):Decision{
 requireThat(value&&Object.keys(value).sort().join(',')==='action,jobId,kind,message'&&schema.properties.action.enum.includes(value.action)&&typeof value.message==='string'&&value.message.length>0&&value.message.length<=16000&&schema.properties.kind.enum.includes(value.kind)&&typeof value.jobId==='string','Codex 未返回有效的结构化处理结果',502);
 return value;
}
export function codexArgs(input:CodexInput,options:CodexOptions,schemaPath:string,output:string){
 if(input.thread)requireThat(/^[a-f0-9-]{36}$/.test(input.thread),'Codex 会话编号无效');
 return ['exec','--sandbox','workspace-write','--cd',input.workspace,'--ignore-user-config','--ignore-rules','-c','approval_policy="never"','-c','sandbox_workspace_write.network_access=false',
  ...(input.thread?['resume',input.thread]:[]),'--json','--skip-git-repo-check','--output-schema',schemaPath,'--output-last-message',output,...(options.model?['--model',options.model]:[]),'-'];
}
/** One process per active incident. No shell interpolation, desktop automation or global --last. */
export class CodexExec implements IncidentRunner {
 constructor(public options:CodexOptions){}
 async run(input:CodexInput){
  input.signal.throwIfAborted();requireThat(existsSync(this.options.command)&&existsSync(this.options.home),'Codex 可执行文件或专用配置目录未配置',503);
  const output=join(input.workspace,'codex-result.json');rmSync(output,{force:true});const schemaPath=join(input.workspace,'codex-result.schema.json');writeFileSync(schemaPath,JSON.stringify(schema),{mode:0o600});
  // Auth is inherited from the explicitly configured Codex home, not copied into a report.
  const env:NodeJS.ProcessEnv={PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:join(input.workspace,'.tmp'),LANG:'en_US.UTF-8',CODEX_HOME:this.options.home};mkdirSync(env.TMPDIR!,{recursive:true,mode:0o700});
  const safe=redactor();const child=spawn(this.options.command,codexArgs(input,this.options,schemaPath,output),{cwd:input.workspace,env,stdio:['pipe','pipe','pipe'],detached:process.platform!=='win32'});
  let failure:Error|undefined,completed=false,bytes=0,stderr='';
  const kill=()=>{try{if(process.platform!=='win32'&&child.pid)process.kill(-child.pid,'SIGTERM');else child.kill('SIGTERM');}catch{}};
  const abort=()=>{failure=Error('Codex 处理已停止，可继续原故障');kill();hardTimer=setTimeout(()=>{try{if(child.pid&&process.platform!=='win32')process.kill(-child.pid,'SIGKILL');else child.kill('SIGKILL');}catch{}},1500);};input.signal.addEventListener('abort',abort,{once:true});
  let hardTimer:ReturnType<typeof setTimeout>|undefined;
  const timeout=setTimeout(()=>{failure=Error('Codex 本轮处理超时，保留会话和证据');kill();hardTimer=setTimeout(()=>{try{if(child.pid&&process.platform!=='win32')process.kill(-child.pid,'SIGKILL');else child.kill('SIGKILL');}catch{}},1500);},this.options.timeoutMs??600000);
  const lines=createInterface({input:child.stdout});
  lines.on('line',line=>{
   bytes+=Buffer.byteLength(line);if(bytes>32*1024*1024){failure=Error('Codex 事件超过单轮记录容量');kill();return;}
   try{const event=JSON.parse(line);if(event.type==='turn.failed')failure=Error(safe.text(JSON.stringify(event)));if(event.type==='turn.completed')completed=true;input.onEvent(safe.clean(event));}catch(e){failure=Error('Codex 事件格式或会话绑定无效');kill();}
  });
  child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-4000);});child.stdin.on('error',()=>{});child.stdin.end(input.prompt+'\n');
  try{
   await new Promise<void>((resolve,reject)=>{child.once('error',reject);child.once('close',code=>code===0?resolve():reject(failure??Error('Codex 退出 '+code+'：'+safe.text(stderr))));});
   if(failure)throw failure;requireThat(completed,'Codex 本轮未完成，未认定修复成功',502);input.signal.throwIfAborted();requireThat(!lstatSync(output).isSymbolicLink()&&lstatSync(output).isFile(),'Codex 结果必须是普通文件');return parseDecision(JSON.parse(readFileSync(output,'utf8')));
  }finally{clearTimeout(timeout);clearTimeout(hardTimer);input.signal.removeEventListener('abort',abort);lines.close();}
 }
}
const excluded=new Set(['.git','node_modules','dist','out','outputs','work','data','.codex','.dsh','.DS_Store']);
export function sourceManifest(root:string){
 const files:Record<string,string>={};const walk=(dir:string)=>{for(const e of readdirSync(dir,{withFileTypes:true})){
  // Only the root data directory is private runtime data. server/data contains
  // versioned provider contracts that are required to run the real application.
  if(excluded.has(e.name)&&(e.name!=='data'||dir===root)||dir===join(root,'desktop')&&['runtime','ui'].includes(e.name)||e.name.startsWith('.env')||/\.(key|pem|p12|pfx)$/.test(e.name))continue;
  const p=join(dir,e.name);if(e.isSymbolicLink())continue;if(e.isDirectory())walk(p);else if(e.isFile())files[relative(root,p)]=hash(readFileSync(p));
 }};walk(root);return files;
}
export function prepareRepairWorkspace(source:string,target:string,evidence:string){
 requireThat(resolve(target)!==resolve(source)&&!resolve(source).startsWith(resolve(target)+sep),'修复副本不能覆盖应用源目录');
 mkdirSync(target,{recursive:true,mode:0o700});const destination=join(target,'source');
 if(!existsSync(join(target,'baseline.json'))){
  const manifest=sourceManifest(source);mkdirSync(destination,{mode:0o700});
  for(const name of Object.keys(manifest)){const to=join(destination,name);mkdirSync(join(to,'..'),{recursive:true});copyFileSync(join(source,name),to);}
  writeFileSync(join(target,'baseline.json'),JSON.stringify(manifest),{mode:0o600,flag:'wx'});
  // Dependencies are read-only by convention; the Codex write sandbox doesn't include this target.
  if(existsSync(join(source,'node_modules')))symlinkSync(realpathSync(join(source,'node_modules')),join(destination,'node_modules'),'dir');
 }
 const evidenceTarget=join(target,'evidence',evidence.split(sep).at(-1)!);mkdirSync(evidenceTarget,{recursive:true,mode:0o700});
 const copy=(from:string,to:string)=>{for(const e of readdirSync(from,{withFileTypes:true})){const a=join(from,e.name),b=join(to,e.name);if(e.isDirectory()){mkdirSync(b,{recursive:true,mode:0o700});copy(a,b);}else if(e.isFile()&&!existsSync(b)){copyFileSync(a,b);chmodSync(b,0o600);}}};copy(evidence,evidenceTarget);
 return {workspace:target,evidence:relative(target,evidenceTarget)};
}
export function repairChanges(workspace:string,currentSource:string,trustedBaseline?:Record<string,string>){
 requireThat(!lstatSync(join(workspace,'source')).isSymbolicLink(),'修复源目录不能是符号链接');
 const before=trustedBaseline??JSON.parse(readFileSync(join(workspace,'baseline.json'),'utf8')),after=sourceManifest(join(workspace,'source')),current=sourceManifest(currentSource);
 const changes=[...new Set([...Object.keys(before),...Object.keys(after)])].filter(p=>before[p]!==after[p]).map(path=>({path,before:before[path]??null,after:after[path]??null}));
 return {changes,baseUnchanged:JSON.stringify(Object.entries(before).sort())===JSON.stringify(Object.entries(current).sort()),workspace,autoDeploy:false};
}
