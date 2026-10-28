import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {id,now,type Store} from './store.ts';
const key=(kind:string,jobId:string)=>kind+':'+jobId;
/** Durable ownership only; it never authorizes or resubmits a provider request. */
export function executionActive(store:Store,kind:string,jobId:string){
 const claim=store.global.get('media-execution',key(kind,jobId));if(!claim)return false;
 try{const owner=JSON.parse(readFileSync(join(store.root,claim.role==='media-worker'?'media-worker.lock':'writer.lock'),'utf8'));if(owner.instance!==claim.instance||owner.pid!==claim.pid)return false;process.kill(owner.pid,0);return true;}catch{return false;}
}
export function claimExecution(store:Store,kind:string,jobId:string,states:string[]){
 return store.tx(()=>{const job=store.get(kind,jobId);if(!job||!states.includes(job.state)||executionActive(store,kind,jobId))return undefined;
  const owner=JSON.parse(readFileSync(store.global.lock,'utf8')),token=id();store.global.put('media-execution',{id:key(kind,jobId),jobId,kind,token,pid:owner.pid,instance:owner.instance,role:store.global.lock.endsWith('media-worker.lock')?'media-worker':'api',started:now()});return token;
 });
}
export function releaseExecution(store:Store,kind:string,jobId:string,token:string){store.tx(()=>{const k=key(kind,jobId);if(store.global.get('media-execution',k)?.token===token)store.db.prepare('DELETE FROM docs WHERE kind=? AND id=?').run('media-execution',k);});}
