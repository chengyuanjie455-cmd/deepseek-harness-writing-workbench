import {test} from 'node:test';
import assert from 'node:assert/strict';
import {retainNativeDraft,draftCheckpointKey,type CheckpointStore,type DraftCheckpoint} from '../web/native-draft-recovery.ts';

function fixture(draft='draft'){
 let value={draft,draftRev:0,phase:'plain',attachmentIds:[] as string[],occurrences:[] as any[]},sequence=0;
 const listeners=new Set<()=>void>(),attachments=new Map<string,any>(),records=new Map<string,DraftCheckpoint>(),released:string[]=[],notices:string[]=[],uploads:any[]=[];
 const update=(change:any)=>{value={...value,...change};for(const fn of listeners)fn();};
 const shell={state:{getSnapshot:()=>value,subscribe(fn:()=>void){listeners.add(fn);return()=>{listeners.delete(fn);};}},draftEditor:{restoreDraft(text:string,occurrences:any[]){update({draft:text,draftRev:value.draftRev+1,occurrences});}},addAttachments(ids:string[]){if(value.phase==='submitting')return false;update({attachmentIds:[...value.attachmentIds,...ids]});return true;}};
 const conversation={createDrafts(session:string,files:File[]){return files.map(file=>{const id='id-'+(++sequence),kind=file.type.startsWith('image/')?'image':'file',attachment={id,kind,file};attachments.set(id,attachment);uploads.push({session,id,kind});return attachment;});},resolveDraftAttachments(ids:string[]){return ids.flatMap(id=>attachments.has(id)?[attachments.get(id)]:[]);},releaseDraftAttachment(id:string){released.push(id);attachments.delete(id);}};
 const store:CheckpointStore={async read(key){return records.get(key);},async write(key,value){if(value)records.set(key,value);else records.delete(key);}};
 const attach=(scope='viewer:shared',session='session-a',backend=store)=>retainNativeDraft({scope,session,shell,conversation,store:backend,notice:text=>notices.push(text)});
 return {shell,conversation,store,records,notices,uploads,released,update,attach};
}

test('project navigation restores original file and image bytes through the native attachment registry',async()=>{
 const a=fixture(),key=draftCheckpointKey('viewer:shared','session-a'),retained=a.attach();await retained.ready;
 const files=[new File(['中文剧本\n123'],'剧本.txt',{type:'text/plain',lastModified:42}),new File([new Uint8Array([0,128,255,4])],'参考.png',{type:'image/png',lastModified:43})];
 a.shell.addAttachments(a.conversation.createDrafts('session-a',files).map(v=>v.id));await retained.flush();retained.dispose();
 const b=fixture();b.records.set(key,a.records.get(key)!);const restored=b.attach();await restored.ready;
 const drafts=b.conversation.resolveDraftAttachments(b.shell.state.getSnapshot().attachmentIds);assert.equal(drafts.length,2);assert.deepEqual(drafts.map(v=>v.file.name),files.map(v=>v.name));
 for(let i=0;i<files.length;i++){assert.equal(drafts[i].file.lastModified,files[i].lastModified);assert.deepEqual(await drafts[i].file.arrayBuffer(),await files[i].arrayBuffer());}
 assert(b.uploads.every(v=>v.session==='session-a'));restored.dispose();
});

test('draft checkpoints cannot cross projects, members, viewer identities or sessions',async()=>{
 const a=fixture();a.records.set(draftCheckpointKey('viewer:shared','session-a'),{version:1,draft:'draft',occurrences:[],files:[new File(['private'],'A.txt')]});
 for(const [scope,session]of [['viewer:other','session-a'],['admin:shared:owner','session-a'],['another:shared','session-a'],['viewer:shared','session-b']]){const retained=a.attach(scope,session);await retained.ready;assert.equal(a.shell.state.getSnapshot().attachmentIds.length,0);retained.dispose();}
 assert.throws(()=>draftCheckpointKey('','session-a'));assert.throws(()=>draftCheckpointKey('viewer','../session-a'));
});

test('reference chips are rebuilt by the native editor only when the authoritative native draft matches',async()=>{
 const f=fixture('a \uFFFC z'),occurrences=[{offset:2,length:1,source:'file',ref:{path:'剧本.md'},label:'剧本.md',clipboardText:'\uFFFC'}];f.records.set(draftCheckpointKey('viewer:shared','session-a'),{version:1,draft:'a \uFFFC z',occurrences,files:[]});
 f.update({draft:'a  z'});const retained=f.attach();await retained.ready;assert.equal(f.shell.state.getSnapshot().draft,'a \uFFFC z');assert.deepEqual(f.shell.state.getSnapshot().occurrences,occurrences);retained.dispose();
});

test('asynchronous restore never overwrites a user edit, new attachment or a submitting native input',async()=>{
 for(const change of [{draft:'new user draft',draftRev:1},{attachmentIds:['new-file']},{phase:'submitting'}]){
  const f=fixture();let release!:(value:DraftCheckpoint)=>void;const store:CheckpointStore={...f.store,read:()=>new Promise(r=>{release=r;})},retained=f.attach('viewer:shared','session-a',store);f.update(change);release({version:1,draft:'draft',occurrences:[],files:[new File(['old'],'old.txt')]});await retained.ready;
  assert.equal(f.uploads.length,0);assert.equal(f.shell.state.getSnapshot().draft,change.draft??'draft');assert(f.notices.some(v=>v.includes('未用旧附件')));retained.dispose();
 }
});

test('accepted native clear and explicit removal retire the checkpoint; failed-send restoration saves it again without resending',async()=>{
 const f=fixture(),retained=f.attach();await retained.ready;const attachment=f.conversation.createDrafts('session-a',[new File(['keep'],'keep.txt')])[0];f.shell.addAttachments([attachment.id]);await retained.flush();assert.equal(f.records.size,1);
 f.update({draft:'',attachmentIds:[],occurrences:[]});await retained.flush();assert.equal(f.records.size,0);
 f.update({draft:'draft',draftRev:1,attachmentIds:[attachment.id]});await retained.flush();assert.equal(f.records.size,1);
 f.update({attachmentIds:[]});await retained.flush();assert.equal(f.records.size,0);assert.equal(f.uploads.length,1);retained.dispose();
});

test('storage failure is visible and navigation flush rejects until a successful retry',async()=>{
 const f=fixture();let fail=true;const store:CheckpointStore={...f.store,async write(key,value){if(fail)throw Error('QuotaExceededError');await f.store.write(key,value);}},retained=f.attach('viewer:shared','session-a',store);await retained.ready;
 f.shell.addAttachments(f.conversation.createDrafts('session-a',[new File(['keep'],'keep.txt')]).map(v=>v.id));await assert.rejects(retained.flush(),/Quota/);assert(f.notices.some(v=>v.includes('保留当前页面')));assert.equal(f.shell.state.getSnapshot().attachmentIds.length,1);
 fail=false;await retained.flush();assert.equal(f.records.size,1);assert.equal(f.notices.at(-1),'');retained.dispose();
});

test('a delayed save cannot recreate attachments after a later native clear',async()=>{
 const f=fixture(),writes:((()=>void))[]=[],store:CheckpointStore={...f.store,write:(key,value)=>new Promise<void>(r=>{writes.push(()=>{void f.store.write(key,value).then(r);});})};
 const retained=f.attach('viewer:shared','session-a',store);await new Promise(r=>setImmediate(r));writes.shift()!();await retained.ready;
 f.shell.addAttachments(f.conversation.createDrafts('session-a',[new File(['x'],'x.txt')]).map(v=>v.id));await new Promise(r=>setImmediate(r));f.update({draft:'',attachmentIds:[]});writes.shift()!();await new Promise(r=>setImmediate(r));writes.shift()!();await retained.flush();assert.equal(f.records.size,0);retained.dispose();
});

test('disposing a native shell waits for its pending file checkpoint without reading a released attachment registry',async()=>{
 const f=fixture(),retained=f.attach();await retained.ready;
 let finish!:()=>void;const originalWrite=f.store.write;f.store.write=async(key,value)=>{await new Promise<void>(r=>{finish=r;});await originalWrite(key,value);};
 const attachment=f.conversation.createDrafts('session-a',[new File(['exact original'],'original.txt')])[0];f.shell.addAttachments([attachment.id]);await new Promise(r=>setImmediate(r));
 retained.dispose();f.conversation.releaseDraftAttachment(attachment.id);const pending=retained.flush();finish();await pending;
 const fresh=fixture();fresh.records.set(draftCheckpointKey('viewer:shared','session-a'),f.records.get(draftCheckpointKey('viewer:shared','session-a'))!);const restored=fresh.attach();await restored.ready;
 assert.equal(await fresh.conversation.resolveDraftAttachments(fresh.shell.state.getSnapshot().attachmentIds)[0].file.text(),'exact original');assert(!f.notices.some(v=>v.includes('尚未就绪')));restored.dispose();
});
