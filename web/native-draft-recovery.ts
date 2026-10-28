// An attachment/reference checkpoint around the pinned native input shell.
// It never sends, edits queues, or owns a second composer. Native text remains
// authoritative; restoration requires the same scoped native text and revision.
type Snapshot={draft:string;draftRev:number;phase:string;attachmentIds:string[];occurrences:any[]};
type Draft={kind:string;id:string;file:File};
export type DraftCheckpoint={version:1;draft:string;occurrences:any[];files:File[]};
export interface CheckpointStore{read(key:string):Promise<DraftCheckpoint|undefined>;write(key:string,value:DraftCheckpoint|undefined):Promise<void>}
type Shell={state:{getSnapshot():Snapshot;subscribe(fn:()=>void):()=>void};draftEditor:{restoreDraft(text:string,occurrences:any[]):void};addAttachments(ids:string[]):boolean};
type Conversation={createDrafts(session:string,files:File[]):Draft[];resolveDraftAttachments(ids:string[]):Draft[];releaseDraftAttachment(id:string):void};

export function draftCheckpointKey(scope:string,session:string){
 if(!scope||!/^session-[a-zA-Z0-9-]{1,160}$/.test(session))throw Error('缺少已认证的聊天草稿范围');
 return JSON.stringify([scope,session]);
}

export function browserDraftStore(indexedDB:IDBFactory):CheckpointStore{
 let opening:Promise<IDBDatabase>|undefined;
 const open=()=>opening??=new Promise<IDBDatabase>((resolve,reject)=>{
  const request=indexedDB.open('team-native-draft-checkpoints',1);
  request.onupgradeneeded=()=>request.result.createObjectStore('drafts');
  request.onerror=()=>{opening=undefined;reject(request.error??Error('草稿附件存储未打开'));};
  request.onblocked=()=>{opening=undefined;reject(Error('草稿附件存储正在被旧页面占用'));};
  request.onsuccess=()=>{const db=request.result;db.onversionchange=()=>{db.close();opening=undefined;};resolve(db);};
 });
 return {
  async read(key){const db=await open();return new Promise((resolve,reject)=>{const transaction=db.transaction('drafts','readonly'),request=transaction.objectStore('drafts').get(key);let value:DraftCheckpoint|undefined;request.onsuccess=()=>{value=request.result;};transaction.oncomplete=()=>resolve(value);transaction.onerror=transaction.onabort=()=>reject(transaction.error??Error('草稿附件读取失败'));});},
  async write(key,value){const db=await open();return new Promise<void>((resolve,reject)=>{const transaction=db.transaction('drafts','readwrite'),store=transaction.objectStore('drafts');if(value)store.put(value,key);else store.delete(key);transaction.oncomplete=()=>resolve();transaction.onerror=transaction.onabort=()=>reject(transaction.error??Error('草稿附件保存失败'));});}
 };
}

export function retainNativeDraft({scope,session,shell,conversation,store,notice=()=>{}}:{scope:string;session:string;shell:Shell;conversation:Conversation;store:CheckpointStore;notice?:(message:string)=>void}){
 const key=draftCheckpointKey(scope,session),initial=shell.state.getSnapshot();
 let disposed=false,restoring=true,tail=Promise.resolve(),last='',failure:unknown;
 const snapshot=()=>shell.state.getSnapshot();
 const report=(error:unknown)=>{failure=error;notice('聊天附件尚未保存，请保留当前页面：'+(error instanceof Error?error.message:String(error)));};
 const capture=()=>{
  if(disposed||restoring)return;
  try{
  const value=snapshot(),drafts=conversation.resolveDraftAttachments(value.attachmentIds);
  if(drafts.length!==value.attachmentIds.length){report(Error('附件尚未就绪'));return;}
  const signature=JSON.stringify([value.draft,value.attachmentIds,value.occurrences]);
  if(signature===last&&!failure)return;last=signature;
  // Capture File objects before a native send/removal releases its registry.
  // No base64 expansion, network upload, or reference to an old object URL.
  const checkpoint:DraftCheckpoint|undefined=drafts.length||value.occurrences.length?{version:1,draft:value.draft,occurrences:structuredClone(value.occurrences),files:drafts.map(v=>v.file)}:undefined;
  tail=tail.then(async()=>{await store.write(key,checkpoint);failure=undefined;notice('');}).catch(report);
  }catch(error){report(error);}
 };
 const off=shell.state.subscribe(capture);
 const ready=(async()=>{
  try{
   const saved=await store.read(key),current=snapshot();
   if(disposed)return;
   if(saved){
    if(saved.version!==1||!Array.isArray(saved.files)||!Array.isArray(saved.occurrences))throw Error('草稿附件记录格式变化');
    // The native store strips its own placeholder characters during seeding.
    const textMatches=current.draft===saved.draft||current.draft===saved.draft.replace(/[\uE100-\uE11D\uFFFC]/gu,'');
    if(current.draftRev!==initial.draftRev||current.draft!==initial.draft||current.attachmentIds.length||!['plain','claimed'].includes(current.phase)||!textMatches){
     restoring=false;notice('当前输入已变化，未用旧附件草稿覆盖当前内容。');return;
    }
    const drafts=conversation.createDrafts(session,saved.files),ids=drafts.map(v=>v.id);
    if(!shell.addAttachments(ids)){for(const id of ids)conversation.releaseDraftAttachment(id);throw Error('聊天输入暂时不可恢复附件');}
    // After attachment admission they belong to the native shell. Never revoke
    // them if the separate rich-reference restoration reports an error.
    if(saved.occurrences.length)shell.draftEditor.restoreDraft(saved.draft,saved.occurrences);
   }
   restoring=false;capture();await tail;
  }catch(error){report(error);}
 })();
 return {
  ready,
  async flush(){await ready;if(!disposed)capture();await tail;if(failure)throw failure;},
  dispose(){disposed=true;off();}
 };
}
