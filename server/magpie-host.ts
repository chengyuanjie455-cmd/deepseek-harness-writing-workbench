import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {createInterface} from 'node:readline';
import {existsSync,mkdtempSync,mkdirSync,chmodSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes,createHash} from 'node:crypto';
import type {ModelConnection} from './model.ts';
import {modelProtocol} from './model-directory.ts';

export const MAGPIE_COMMIT='ba319a7587923fc7a4ea3859658244d591261a59';
const defaultBinary=fileURLToPath(new URL(`../runtime/magpie-host-${process.platform}-${process.arch}`,import.meta.url));
const unavailable=()=>Object.assign(Error('内置 Magpie 未就绪，请检查主机运行模块；没有改用其他引擎发送。'),{code:'MAGPIE_UNAVAILABLE'});
/** One private Magpie process per host. Secrets travel only over its inherited
 * pipe and a mode-0700 transient state directory, never browser configuration. */
export class MagpieHost {
 private child?:ChildProcessWithoutNullStreams;
 private directory?:string;private directories=new Set<string>();
 private url='';private token='';private closed=false;
 private sequence=0;private serial:Promise<unknown>=Promise.resolve();
 private providers=new Map<string,Record<string,unknown>>();
 private pending=new Map<string,{resolve:(v:any)=>void;reject:(e:Error)=>void;timer:NodeJS.Timeout}>();
 constructor(private root:string,private binary=defaultBinary){}
 status(){return {engine:'magpie',sourceCommit:MAGPIE_COMMIT,available:existsSync(this.binary),running:!!this.child&&!!this.url};}
 private async configure(c:ModelConnection){
  if(this.closed||!existsSync(this.binary))throw unavailable();
  const protocol=c.protocol??modelProtocol(c.provider,c.model),field=({chat:'chat',responses:'responses',messages:'anthropic',google:'gemini',systemone:undefined} as Record<string,string|undefined>)[protocol];
  if(!field)throw Object.assign(Error('此协议尚未接入内置 Magpie'),{code:'MAGPIE_UNAVAILABLE'});
  const providerId='wawu-'+createHash('sha256').update(c.configId).digest('hex').slice(0,24);
  const provider={id:providerId,name:providerId,key:c.apiKey,[field]:c.baseURL.replace(/\/$/,''),models:[c.model],baseAPI:field,affinity:'off'};
  // The outer workbench router owns exact-model and pre-output fallback. Each
  // Magpie provider has exactly one model/key and no hidden fallback group.
  const changed=JSON.stringify(this.providers.get(providerId))!==JSON.stringify(provider);
  this.providers.set(providerId,provider);
  if(this.child&&this.url&&!changed)return providerId;
  if(!this.child){
   const parent=join(this.root,'magpie-private');mkdirSync(parent,{recursive:true,mode:0o700});chmodSync(parent,0o700);
   this.directory=mkdtempSync(join(parent,'run-'));this.directories.add(this.directory);chmodSync(this.directory,0o700);this.token=randomBytes(32).toString('hex');
   const child=spawn(this.binary,[],{stdio:['pipe','pipe','pipe'],env:{PATH:process.env.PATH,TMPDIR:process.env.TMPDIR,XDG_CONFIG_HOME:join(this.directory,'config'),XDG_CACHE_HOME:join(this.directory,'cache'),MAGPIE_NO_ACCOUNTS:'1',DO_NOT_TRACK:'1'}});
   this.child=child;
   const cleanup=()=>{if(this.child!==child)return;this.child=undefined;this.url='';for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(unavailable());}this.pending.clear();};
   child.once('error',cleanup);child.once('exit',cleanup);child.stderr.resume();
   const lines=createInterface({input:child.stdout});lines.on('line',line=>{let v:any;try{v=JSON.parse(line);}catch{return;}const p=this.pending.get(v.id);if(!p)return;this.pending.delete(v.id);clearTimeout(p.timer);if(v.error)p.reject(unavailable());else p.resolve(v);});
  }
  const id=String(++this.sequence),child=this.child!;
  const result=await new Promise<any>((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(unavailable());},15000);this.pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({id,token:this.token,providers:[...this.providers.values()]})+'\n',error=>{if(error){clearTimeout(timer);this.pending.delete(id);reject(unavailable());}});});
  if(result.url){const u=new URL(result.url);if(u.hostname!=='127.0.0.1'||u.protocol!=='http:'||u.pathname!=='/v1')throw unavailable();this.url=result.url;}
  return providerId;
 }
 async fetch(c:ModelConnection,body:Record<string,any>,signal:AbortSignal,_store?:unknown,scope=''){
  signal.throwIfAborted();
  const configured=this.serial.then(()=>this.configure(c));this.serial=configured.catch(()=>{});
  const providerId=await configured;signal.throwIfAborted();if(this.closed||!this.url)throw unavailable();
  const response=await fetch(this.url+'/chat/completions',{method:'POST',headers:{Authorization:'Bearer '+this.token,'Content-Type':'application/json','X-Magpie-Session':createHash('sha256').update(scope).digest('hex')},body:JSON.stringify({...body,model:providerId+'/'+c.model}),signal,redirect:'error'});
  // Magpie's route names, internals and credentials are host-only. Native
  // streaming remains OpenAI Chat and the router reports the real selection.
  const headers=new Headers();for(const key of ['content-type','retry-after'])if(response.headers.has(key))headers.set(key,response.headers.get(key)!);
  headers.set('X-Team-Model-Engine','magpie');
  return new Response(response.body,{status:response.status,headers});
 }
 async close(){
  this.closed=true;const child=this.child;
  if(child){await new Promise<void>(resolve=>{const timer=setTimeout(()=>{child.kill('SIGKILL');},3000);child.once('exit',()=>{clearTimeout(timer);resolve();});child.stdin.end();if(child.exitCode!==null){clearTimeout(timer);resolve();}});}
  for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(unavailable());}this.pending.clear();
  for(const directory of this.directories)rmSync(directory,{recursive:true,force:true});this.directories.clear();this.providers.clear();this.url='';this.token='';
 }
}
