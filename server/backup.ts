import {assertNativeBackupStopped} from './native-backup-guard.ts';
import {activeMediaWorker} from './media-worker-manager.ts';
import {cloneFileSync} from './clone-file.ts';
import {mkdirSync,existsSync,readdirSync,lstatSync,readFileSync,writeFileSync,copyFileSync,readlinkSync,symlinkSync,renameSync,chmodSync,realpathSync,constants} from 'node:fs';
import {join,resolve,relative,sep,basename} from 'node:path';
import {execFileSync} from 'node:child_process';
import {Store,requireThat,hash,id,now,type Doc} from './store.ts';
import {recordBackupStatus} from './operational-health.ts';
import {hashRegularFile as fileHash} from './file-hash.ts';
import {assertStoragePath} from './external-storage.ts';
const overlap=(a:string,b:string)=>a===b||a.startsWith(b+sep)||b.startsWith(a+sep);
function inventory(root:string){const files:Doc[]=[];const walk=(dir:string)=>{for(const name of readdirSync(dir).sort()){const p=join(dir,name),st=lstatSync(p),path=relative(root,p);if(st.isSymbolicLink())files.push({path,link:readlinkSync(p)});else if(st.isDirectory())walk(p);else{requireThat(st.isFile(),'备份包含不支持的特殊文件');files.push({path,bytes:st.size,sha256:fileHash(p)});}}};walk(root);return files;}
function copyTree(from:string,to:string,exclude=new Set<string>()) {mkdirSync(to,{recursive:true,mode:0o700});for(const name of readdirSync(from)){if(exclude.has(name))continue;const a=join(from,name),b=join(to,name),st=lstatSync(a);if(st.isSymbolicLink())symlinkSync(readlinkSync(a),b);else if(st.isDirectory())copyTree(a,b);else{requireThat(st.isFile(),'备份包含不支持的特殊文件');cloneFileSync(a,b);chmodSync(b,st.mode&0o700);}}}
function treeStamp(root:string){const files:Doc[]=[];const walk=(dir:string)=>{for(const name of readdirSync(dir).sort()){const p=join(dir,name),st=lstatSync(p);if(st.isDirectory())walk(p);else files.push({path:relative(root,p),size:st.size,mtime:st.mtimeMs,ctime:st.ctimeMs,ino:st.ino,link:st.isSymbolicLink()?readlinkSync(p):undefined});}};walk(root);return JSON.stringify(files);}
function copyProject(directory:string,target:string,expected:Record<string,string>){
 const before=treeStamp(directory);copyTree(directory,target);
 const actual=inventory(target),source=inventory(directory);
 requireThat(before===treeStamp(directory)&&JSON.stringify(actual)===JSON.stringify(source),'项目目录在备份期间变化，备份未完成',409);
 // Preserve the working folder and published revision independently. A native
 // workspace can contain drafts or an imported folder with no published files.
 const paths=new Set(actual.map(f=>f.path)),added=actual.filter(f=>!(f.path in expected)).length,
  changed=actual.filter(f=>f.path in expected&&(f.link!==undefined||expected[f.path]!==f.sha256)).length,
  removed=Object.keys(expected).filter(p=>!paths.has(p)).length;
 return {matchesPublished:added+changed+removed===0,added,changed,removed};
}
function assertNativeStopped(data:string){const docker=['/usr/local/bin/docker','/opt/homebrew/bin/docker'].find(existsSync)??'docker';assertNativeBackupStopped(data,args=>execFileSync(docker,args,{encoding:'utf8',timeout:10000,maxBuffer:16*1024*1024,stdio:['ignore','pipe','pipe']}),existsSync(join(data,'native-harness')));}
function ensureNewPath(dest:string){assertStoragePath(dest);requireThat(!existsSync(dest),'目标目录已存在，禁止覆盖',409);mkdirSync(resolve(dest,'..'),{recursive:true,mode:0o700});return join(realpathSync(resolve(dest,'..')),basename(dest));}
export function backupOffline(dataPath:string,destination:string){
 const data=realpathSync(resolve(dataPath)),dest=ensureNewPath(resolve(destination));requireThat(!overlap(data,dest),'备份目录不能与数据目录重叠');requireThat(!activeMediaWorker(data),'后台媒体执行器仍在运行，请先完整停止主机再做离线备份',409);assertNativeStopped(data);const store=new Store(data),stage=dest+'.building-'+id();
 try{requireThat(!store.all('intent').some(i=>i.phase!=='published'),'存在未完成的项目发布，先恢复原事务',409);requireThat(!['task','model-call'].some(k=>store.all(k).some(j=>['running','pending','queued','cancel_requested','termination_unconfirmed'].includes(j.state))),'文字任务尚未结束，请先处理原任务',409);
  mkdirSync(stage,{mode:0o700});copyTree(data,join(stage,'data'),new Set(['writer.lock','media-worker.lock','media-worker-status.json','media-worker-stop.json','platform.sqlite','platform.sqlite-wal','platform.sqlite-shm']));
  store.db.prepare('VACUUM INTO ?').run(join(stage,'data/platform.sqlite'));
  const projects=store.all('project').map(p=>{let workingTree;if(p.directory){requireThat(!overlap(p.directory,dest),'备份目录不能与项目目录重叠');workingTree=copyProject(p.directory,join(stage,'projects',p.id),store.get('revision',p.revision)!.manifest);}return {id:p.id,revision:p.revision,external:!!p.directory,...(workingTree?{workingTree}:{})};});
  const files=inventory(stage),manifest={version:1,created:now(),source:data,projects,files};writeFileSync(join(stage,'manifest.json'),JSON.stringify(manifest),{mode:0o600});writeFileSync(join(stage,'manifest.sha256'),hash(JSON.stringify(manifest)),{mode:0o600});renameSync(stage,dest);recordBackupStatus(data,{lastAttempt:{at:now(),status:'succeeded'},lastSuccess:{at:now(),files:files.length,bytes:files.reduce((n,f)=>n+(f.bytes??0),0),manifestSHA256:hash(JSON.stringify(manifest)),location:basename(dest)}});return {path:dest,files:files.length,bytes:files.reduce((n,f)=>n+(f.bytes??0),0),manifestSHA256:hash(JSON.stringify(manifest))};
 }catch(e){recordBackupStatus(data,{lastAttempt:{at:now(),status:'failed',reason:'备份未完成，请检查主机备份日志；上一份成功记录保留。'}});throw e;}finally{store.close();}
}
export function verifyBackup(path:string){const root=realpathSync(resolve(path)),raw=readFileSync(join(root,'manifest.json'),'utf8');requireThat(hash(raw)===readFileSync(join(root,'manifest.sha256'),'utf8'),'备份清单校验失败');const manifest=JSON.parse(raw);requireThat(manifest.version===1&&Array.isArray(manifest.files),'不支持的备份版本');const actual=inventory(root).filter(f=>!['manifest.json','manifest.sha256'].includes(f.path));requireThat(JSON.stringify(actual)===JSON.stringify(manifest.files),'备份文件缺失或哈希改变，停止恢复',409);return manifest;}
export function restoreOffline(backup:string,destination:string){const source=realpathSync(resolve(backup)),dest=ensureNewPath(resolve(destination));requireThat(!overlap(source,dest),'恢复目录不能与备份重叠');const manifest=verifyBackup(source);requireThat(!overlap(manifest.source,dest),'恢复目录不能覆盖原数据');const stage=dest+'.restoring-'+id();copyTree(source,stage,new Set(['manifest.json','manifest.sha256']));renameSync(stage,dest);const data=join(dest,'data'),store=new Store(data);
 try{requireThat(store.db.prepare('PRAGMA integrity_check').get()!.integrity_check==='ok','恢复数据库完整性检查失败');store.tx(()=>{for(const p of store.all('project'))if(p.directory)store.put('project',{...p,directory:join(dest,'projects',p.id),directoryOwnerRoot:data});store.db.exec('DELETE FROM auth');store.put('runtime',{id:'latest-restore-drill',checkedAt:now(),files:manifest.files.length,projects:manifest.projects.length,kind:'offline_restore',nativeSessions:null});store.audit('server','backup.restore',dest,{manifestSHA256:hash(JSON.stringify(manifest)),files:manifest.files.length,sourceUntouched:true});});return {data,files:manifest.files.length,projects:manifest.projects.length,sourceUntouched:true};}finally{store.close();}}
