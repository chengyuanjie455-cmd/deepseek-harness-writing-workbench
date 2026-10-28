import {mkdirSync,existsSync,readFileSync,writeFileSync,renameSync,lstatSync,realpathSync,readdirSync} from 'node:fs';import {join,resolve} from 'node:path';
import {hash,id,now,requireThat,type Doc} from './store.ts';import {privateSkillRedactor} from './private-skill-content.ts';import type {NativeHarness,Instance} from './native-harness.ts';
const canonical=(v:any):any=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const digest=(v:unknown)=>hash(JSON.stringify(canonical(v)));
function artefacts(root:string){const files:Doc={};const walk=(dir:string,prefix='')=>{for(const name of readdirSync(dir)){const path=join(dir,name),key=prefix+name,stat=lstatSync(path);requireThat(!stat.isSymbolicLink(),'历史记录包含外部链接，未修改原记录',409);if(stat.isDirectory())walk(path,key+'/');else{requireThat(stat.isFile(),'历史记录含特殊文件，未修改原记录',409);files[key]={bytes:stat.size,sha256:hash(readFileSync(path))};}}};walk(root);return {files,digest:digest(files)};}
/** One-time, offline preparation. Original native artefacts are atomically moved
 * into host-private storage, never deleted. The official native persistence
 * importer recreates the same sessions and exact inherited prefix metadata. */
export async function preparePrivateSkillHistory(native:NativeHarness,i:Instance):Promise<Doc[]>{
 const store=native.store,redactor=privateSkillRedactor(native.codeRoot,store.root),versionKey=hash(JSON.stringify(redactor.sourceDigests.sort())),kind='private-skill-history-migration',old=store.get(kind,i.key);
 if(old?.state==='completed'&&old.versionKey===versionKey)return [];
 if(old&&old.state!=='completed'){
  requireThat(existsSync(old.payload)&&hash(readFileSync(old.payload))===old.payloadHash,'历史技能迁移准备文件不完整，原记录保留在主机私有归档',409);
  if(!existsSync(old.backup)){requireThat(existsSync(join(i.root,'state/sessions'))&&artefacts(join(i.root,'state/sessions')).digest===old.originalManifest.digest,'历史记录未找到或已改变，暂停启动以保护上下文',409);renameSync(join(i.root,'state/sessions'),old.backup);}
  requireThat(artefacts(old.backup).digest===old.originalManifest.digest,'历史原始归档已改变，暂停恢复以保护上下文',409);
  mkdirSync(join(i.root,'state/sessions'),{recursive:true,mode:0o700});return JSON.parse(readFileSync(old.payload,'utf8'));
 }
 const root=join(i.root,'state/sessions');if(!existsSync(root)){store.put(kind,{id:i.key,owner:i.owner,project:i.project,versionKey,state:'completed',redactedStrings:0,checked:now()});return [];}
 requireThat(!lstatSync(root).isSymbolicLink()&&realpathSync(root)===resolve(root),'原生历史目录身份改变，未修改原记录',409);
 const listed=await native.history.read(i.key);requireThat(Array.isArray(listed.items)&&!listed.error,'原生历史未完整读取，不能迁移内部技能资料',409);let changed=0;const items:Doc[]=[];
 for(const entry of listed.items){requireThat(entry.id&&!entry.error,'部分原生历史未读出，未修改原记录',409);const value=await native.history.read(i.key,entry.id,undefined,'evidence');requireThat(value.header&&Array.isArray(value.events),'原生会话证据不完整，未修改原记录',409);const cleaned=redactor.redact({header:value.header,events:value.events});changed+=cleaned.redactedStrings;items.push({...cleaned.value,inheritedEventCount:value.inheritedEventCount??0,privateHistoryRestore:true});}
 if(!changed){store.put(kind,{...old,id:i.key,owner:i.owner,project:i.project,versionKey,state:'completed',redactedStrings:0,sessions:items.length,checked:now()});return [];}
 const parent=join(store.root,'private-skills','history');mkdirSync(parent,{recursive:true,mode:0o700});requireThat(!lstatSync(parent).isSymbolicLink()&&realpathSync(parent)===resolve(parent),'历史私有归档目录身份改变',409);
 const transaction=join(parent,i.key+'-'+id());mkdirSync(transaction,{mode:0o700});const payload=join(transaction,'redacted-sessions.json'),backup=join(transaction,'original-sessions');writeFileSync(payload,JSON.stringify(items),{mode:0o600,flush:true});
 store.put(kind,{id:i.key,owner:i.owner,project:i.project,versionKey,state:'prepared',payload,payloadHash:hash(readFileSync(payload)),backup,originalManifest:artefacts(root),redactedStrings:changed,sessions:items.length,expected:items.map(v=>({id:v.header.id,events:v.events.length,digest:digest(v.events),inheritedEventCount:v.inheritedEventCount})),started:now()});
 renameSync(root,backup);mkdirSync(root,{mode:0o700});store.audit(i.owner,'private.skill.history.archive',i.key,{project:i.project,sessions:items.length,redactedStrings:changed,originalsPreserved:true});return items;
}
export async function verifyPrivateSkillHistory(native:NativeHarness,i:Instance){
 const kind='private-skill-history-migration',migration=native.store.get(kind,i.key);if(!migration||migration.state==='completed')return;
 requireThat(existsSync(migration.backup)&&artefacts(migration.backup).digest===migration.originalManifest.digest&&hash(readFileSync(migration.payload))===migration.payloadHash,'历史迁移归档缺失或准备文件改变，未覆盖记录',409);
 const redactor=privateSkillRedactor(native.codeRoot,native.store.root);
 for(const expected of migration.expected){const current=await native.history.read(i.key,expected.id,undefined,'evidence');requireThat(current.header&&current.events.length>=expected.events&&current.inheritedEventCount===expected.inheritedEventCount&&digest(current.events.slice(0,expected.events))===expected.digest,'原生会话迁移未完整回读，保留原记录与准备文件待恢复',409);requireThat(redactor.redact(current.events).redactedStrings===0,'原生会话仍含内部技能正文，未开放该环境',409);}
 const completed:Doc={...migration,state:'completed',finished:now(),originalsPreserved:true};native.store.put(kind,completed);native.store.put('private-skill-history-receipt',{...completed,id:hash(i.key+completed.payloadHash),workspace:i.key});
}
