// Persist reports before transport, including optional screenshots. Keys bind server + viewer + owner + project.
export type IncidentDraft={body:Record<string,any>;files:{name:string;data:string}[]};
export async function incidentDraft(key:string,operation:'get'|'put'|'delete',value?:IncidentDraft):Promise<IncidentDraft|undefined>{
 const db=await new Promise<IDBDatabase>((resolve,reject)=>{const r=indexedDB.open('team-incident-outbox',1);r.onupgradeneeded=()=>r.result.createObjectStore('drafts');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
 try{return await new Promise((resolve,reject)=>{const tx=db.transaction('drafts',operation==='get'?'readonly':'readwrite'),store=tx.objectStore('drafts');const r=operation==='get'?store.get(key):operation==='put'?store.put(value,key):store.delete(key);let result:IncidentDraft|undefined;r.onsuccess=()=>{if(operation==='get')result=r.result;};tx.oncomplete=()=>resolve(result);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error??Error('报告未保存在浏览器中'));});}finally{db.close();}
}
export function outboxKey(server:string,viewer:string,project:string,owner=viewer){return JSON.stringify([server,viewer,project,owner]);}
