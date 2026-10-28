export type NativeHealth={healthy:boolean;running:boolean;checkedAt?:number;reason?:string;runtimeConfirmed?:boolean};
import {setTimeout as delay} from 'node:timers/promises';
/** Reading startup logs is safe to retry; starting or replacing a container is
 * not. A busy Docker CLI must not turn one lost read into a failed conversation. */
export async function waitNativeStartupToken({readLogs,timeoutMs=60000,now=Date.now,pause=()=>delay(250)}:{readLogs:()=>Promise<string>;timeoutMs?:number;now?:()=>number;pause?:()=>Promise<void>}){
 const end=now()+timeoutMs;
 for(let attempts=0;attempts<100&&now()<end;attempts++){
  try{const token=(await readLogs()).match(/http:\/\/127\.0\.0\.1:3080\/\?token=([^\s]+)/)?.[1];if(token)return token;}
  catch(error:any){
   const message=String(error?.stderr??'')+' '+String(error?.message??'');
   // Docker Desktop can briefly lose its socket while the same container keeps
   // running. Retry only this read; never restart a runtime or replay a task.
   // Permission failures and a definitely missing container are not transient.
   const denied=['EACCES','EPERM','ENOENT'].includes(error?.code)||/permission denied|access denied|operation not permitted|no such container|unauthorized|forbidden/i.test(message);
   const transient=error?.killed||error?.signal||[143,'ETIMEDOUT','ECONNRESET','EPIPE'].includes(error?.code)||/cannot connect to the Docker daemon/i.test(message);
   if(denied||!transient)throw error;
  }
  if(now()<end)await pause();
 }
 return '';
}
type Options={request:()=>Promise<Response>;inspect:()=>Promise<boolean>;now?:()=>number};
/** An unanswered HTTP probe is not proof that a running conversation has stopped. */
export async function probeNativeHealth({request,inspect,now=Date.now}:Options):Promise<NativeHealth>{
 let reason='http_unavailable';
 try{const response=await request();if(response.ok)return {healthy:true,running:true,runtimeConfirmed:true,checkedAt:now()};reason='http_'+response.status;}catch(error){reason=error instanceof Error&&['TimeoutError','AbortError'].includes(error.name)?'http_timeout':'http_unavailable';}
 try{const running=await inspect();return {healthy:false,running,runtimeConfirmed:true,reason:running?reason:'runtime_stopped',checkedAt:now()};}
 catch{return {healthy:false,running:true,runtimeConfirmed:false,reason:'runtime_unconfirmed',checkedAt:now()};}
}

export class NativeProbeCache<T>{
 private values=new Map<string,{at:number;pending:boolean;version:string;value?:T;promise:Promise<T>}>();
 constructor(private ttl:(value:T)=>number,private now=Date.now){}
 async get(key:string,probe:()=>Promise<T>,version=''):Promise<T>{
  const old=this.values.get(key);if(old&&old.version===version&&(old.pending||old.value!==undefined&&this.now()-old.at<this.ttl(old.value)))return old.promise;
  const entry:{at:number;pending:boolean;version:string;value?:T;promise:Promise<T>}={at:this.now(),pending:true,version,promise:undefined as any};
  entry.promise=Promise.resolve().then(probe).then(value=>{entry.value=value;entry.pending=false;entry.at=this.now();return value;},error=>{if(this.values.get(key)===entry)this.values.delete(key);throw error;});this.values.set(key,entry);return entry.promise;
 }
 delete(key:string){this.values.delete(key);}
}
