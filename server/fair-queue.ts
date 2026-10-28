import {Problem,requireThat} from './store.ts';
import {concurrencyValue,MAX_PENDING_TASKS} from './concurrency.ts';
type Entry={owner:string;label:string;at:number;resolve:(release:()=>void)=>void;reject:(e:unknown)=>void;signal?:AbortSignal;abort:()=>void};
/** Fill all free slots immediately. Round-robin applies only to overflow. */
export class FairQueue {
 private waiting=new Map<string,Entry[]>(); private owners:string[]=[]; private live=new Map<symbol,{owner:string;label:string;at:number}>(); private closed=false;
 peak=0;completed=0;cancelled=0;
 constructor(public limit:number,public capacity=MAX_PENDING_TASKS){concurrencyValue(limit);}
 get pending(){return [...this.waiting.values()].reduce((n,q)=>n+q.length,0);}
 get active(){return this.live.size;}
 setLimit(limit:number){this.limit=concurrencyValue(limit);this.pump();}
 acquire(owner:string,signal?:AbortSignal,label=''):Promise<()=>void>{
  if(this.closed)return Promise.reject(new Problem(503,'服务正在停止，请稍后继续当前会话'));
  if(signal?.aborted)return Promise.reject(signal.reason);
  if(this.pending>=this.capacity)return Promise.reject(new Problem(429,'等待队列已满，本次请求尚未发送，请稍后继续'));
  return new Promise((resolve,reject)=>{const entry:Entry={owner,label,at:Date.now(),resolve,reject,signal,abort:()=>{const q=this.waiting.get(owner);if(!q)return;const at=q.indexOf(entry);if(at<0)return;q.splice(at,1);this.cancelled++;this.removeEmpty(owner);reject(signal?.reason??new Problem(499,'请求已取消'));}};
   if(!this.waiting.has(owner)){this.waiting.set(owner,[]);this.owners.push(owner);}this.waiting.get(owner)!.push(entry);signal?.addEventListener('abort',entry.abort,{once:true});this.pump();
  });
 }
 private removeEmpty(owner:string){if(this.waiting.get(owner)?.length)return;this.waiting.delete(owner);this.owners=this.owners.filter(v=>v!==owner);}
 private pump(){while(!this.closed&&this.active<this.limit&&this.owners.length){const owner=this.owners.shift()!,q=this.waiting.get(owner)!,e=q.shift()!;if(q.length)this.owners.push(owner);else this.waiting.delete(owner);e.signal?.removeEventListener('abort',e.abort);if(e.signal?.aborted){e.reject(e.signal.reason);continue;}const token=Symbol();this.live.set(token,{owner,label:e.label,at:Date.now()});this.peak=Math.max(this.peak,this.active);let released=false;e.resolve(()=>{if(released)return;released=true;this.live.delete(token);this.completed++;this.pump();});}}
 snapshot(){const queued=[...this.waiting.values()].flat();return {limit:this.limit,active:this.active,queued:queued.length,queueCapacity:this.capacity,oldestWaitMs:queued.length?Date.now()-Math.min(...queued.map(e=>e.at)):0,peak:this.peak,completed:this.completed,cancelled:this.cancelled,members:[...new Set([...this.live.values()].map(v=>v.owner).concat(queued.map(e=>e.owner)))].map(owner=>({owner,active:[...this.live.values()].filter(v=>v.owner===owner).length,queued:queued.filter(e=>e.owner===owner).length}))};}
 close(){this.closed=true;for(const q of this.waiting.values())for(const e of q){e.signal?.removeEventListener('abort',e.abort);e.reject(new Problem(503,'服务重启，本次排队请求尚未发送'));}this.waiting.clear();this.owners=[];}
}
