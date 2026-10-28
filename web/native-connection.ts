export type NativeApi=(path:string,method?:string,body?:any)=>Promise<any>;
export type ConnectionView={url:string;scope:string;version:number;phase:string;error:string;elapsedMs:number;ready:boolean;blocked:boolean;attempt:number;timings:Record<string,number>};
type Options={api:NativeApi;emit:(state:ConnectionView)=>void;desktop?:(url:string)=>Promise<string>;snapshot:()=>Promise<string>;now?:()=>number};
// Retries open/authentication only; never replays prompts or generation requests.
export class NativeConnection {
 state:ConnectionView={url:'',scope:'',version:0,phase:'connecting',error:'',elapsedMs:0,ready:false,blocked:false,attempt:0,timings:{}};
 private degradedSince:number|undefined;private degradedProbe=0;private degradedSamples=0;
 private ended=false;private opening=false;private checking=false;private sequence=0;private nextAttempt=Infinity;private failures=0;
 private identity?:{serverInstance:string;generation:string};private started=0;private renderedAt=0;private clock:()=>number;
 constructor(private options:Options){this.clock=options.now??Date.now;}
 private publish(values:Partial<ConnectionView>={}){if(this.ended)return;Object.assign(this.state,values);this.options.emit({...this.state,timings:{...this.state.timings}});}
 private failed(error:any){const blocked=[400,401,403,404].includes(error?.status);this.failures++;this.nextAttempt=blocked?Infinity:this.clock()+Math.min(30000,2000*2**Math.min(this.failures-1,4));this.publish({blocked,error:blocked?error.message:'连接暂时中断，正在自动恢复…',phase:blocked?'blocked':'reconnecting'});}
 async open(){
  if(this.ended||this.opening)return;
  const sequence=++this.sequence;this.opening=true;this.nextAttempt=Infinity;this.started=this.clock();
  this.publish({phase:this.state.url?'reconnecting':'connecting',error:'',blocked:false,attempt:this.state.attempt+1,elapsedMs:0});
  try{
   const hash=this.state.url?await this.options.snapshot():'';
   if(this.ended||sequence!==this.sequence)return;
   const data=await this.options.api('/native/open','POST',{});
   if(this.ended||sequence!==this.sequence)return;
   const url=this.options.desktop?await this.options.desktop(data.url):data.url;
   if(this.ended||sequence!==this.sequence)return;
   this.identity={serverInstance:data.serverInstance,generation:data.generation};this.renderedAt=this.clock();
   this.publish({url:url+(hash.startsWith('#')?hash:''),scope:data.scope,version:this.state.version+1,ready:false,phase:'page',timings:{openMs:data.openMs??0,startupMs:data.startupMs??0,reused:data.reused?1:0,...data.steps}});
  }catch(error){if(!this.ended&&sequence===this.sequence)this.failed(error);}
  finally{if(sequence===this.sequence)this.opening=false;}
 }
 loaded(version=this.state.version){if(this.ended||this.opening||this.state.blocked||version!==this.state.version)return;if(!this.state.ready)this.publish({phase:'restoring'});}
 ready(version=this.state.version){if(this.ended||this.opening||this.state.blocked||!this.state.url||version!==this.state.version)return;this.failures=0;this.nextAttempt=Infinity;this.degradedSince=undefined;this.degradedSamples=0;this.publish({ready:true,phase:'ready',error:'',elapsedMs:this.clock()-this.started,timings:{...this.state.timings,pageMs:this.clock()-this.renderedAt,totalMs:this.clock()-this.started}});}
 async check(){
  if(this.ended||this.checking||this.state.blocked)return;this.checking=true;const sequence=this.sequence;
  try{
   const current=await this.options.api('/native/status?connection=1');if(this.ended||sequence!==this.sequence)return;
   if(!this.state.ready)this.publish({elapsedMs:this.clock()-this.started});
   if(this.opening){if(current.state==='starting')this.publish({phase:current.phase,timings:{...current.steps}});return;}
   const replaced=this.identity&&(current.serverInstance!==this.identity.serverInstance||current.state==='ready'&&current.generation!==this.identity.generation);
   if(replaced||current.state==='idle'||current.state==='failed'){
    if(this.nextAttempt===Infinity)this.nextAttempt=this.clock();
   }else if(current.state==='degraded'&&this.state.ready){
    const at=current.health?.checkedAt;
    if(this.degradedSince===undefined)this.degradedSince=this.clock();
    if(typeof at==='number'&&at!==this.degradedProbe){this.degradedProbe=at;this.degradedSamples++;}
    this.publish({phase:'reconnecting',error:'原生界面响应暂慢，当前聊天保留，正在继续检测…'});
    if(this.clock()-this.degradedSince>=15000&&this.degradedSamples>=2&&this.nextAttempt===Infinity)this.failed(new Error());
   }else if(current.state==='unavailable'){
    if(this.nextAttempt===Infinity)this.failed(new Error());
   }else if(this.state.ready&&current.state==='ready'){
    this.failures=0;this.nextAttempt=Infinity;this.degradedSince=undefined;this.degradedSamples=0;this.publish({phase:'ready',error:''});
   }
   if(this.state.url&&!this.state.ready&&this.clock()-this.renderedAt>90000&&this.nextAttempt===Infinity)this.failed(new Error());
   if(this.clock()>=this.nextAttempt)void this.open();
  }catch(error){if(!this.ended&&sequence===this.sequence){if(this.nextAttempt===Infinity)this.failed(error);if(this.clock()>=this.nextAttempt)void this.open();}}
  finally{this.checking=false;}
 }
 retry(){this.state.blocked=false;this.failures=0;void this.open();}
 stop(){this.ended=true;this.sequence++;}
}
