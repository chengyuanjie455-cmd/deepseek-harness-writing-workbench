/** Offline restore helper: verify a copied project before attaching a copied data directory. */
import {resolve,join,sep} from 'node:path';import {realpathSync,lstatSync,readdirSync,readFileSync} from 'node:fs';import {Store,hash,requireThat} from '../server/store.ts';import {validPath} from '../server/project.ts';
import {fileHash,MAX_FILE_BYTES} from '../server/file-objects.ts';
const args=process.argv.slice(2);requireThat((args.length===4||args.length===6&&args[4]==='--project-id')&&args[0]==='--data'&&args[2]==='--project','用法：tsx scripts/rebind-restored-project.ts --data 已复制且已停服的数据目录 --project 已复制的独立项目目录 [--project-id 项目编号]');
const data=realpathSync(resolve(args[1])),project=realpathSync(resolve(args[3]));requireThat(resolve(args[3])===project&&!lstatSync(project).isSymbolicLink(),'独立项目目录不能经过符号链接');
const projectId=args[5]??'shared';requireThat(projectId==='shared'||/^[a-f0-9-]{36}$/.test(projectId),'项目编号无效');
const store=new Store(data);
try{
 const current=store.get('project',projectId);requireThat(current?.directory && current.directoryOwnerRoot!==data,'本工具仅用于已复制到不同路径的数据目录，不修改活动绑定',409);
 const overlaps=(a:string,b:string)=>a===b||a.startsWith(b+sep)||b.startsWith(a+sep);
 requireThat(!store.all('project').some(p=>p.id!==projectId&&p.directory&&overlaps(project,p.directory)),'新副本不能与另一项目目录重叠',409);
 requireThat(!overlaps(project,current.directory)&&!overlaps(project,data)&&!overlaps(project,current.directoryOwnerRoot),'独立项目副本不能与原项目、原数据或新数据路径重叠',409);
 requireThat(!store.all('intent').some(i=>i.phase!=='published'),'存在未完成发布，须先核对原事务，禁止更换目标',409);
 const expected=store.get('revision',current.revision)!.manifest,actual:Record<string,string>={};let count=0;
 function walk(dir:string,rel=''){for(const e of readdirSync(dir)){const name=validPath(rel?rel+'/'+e:e),p=join(dir,e),st=lstatSync(p);requireThat(!st.isSymbolicLink()&&realpathSync(p)===p,'副本包含链接，停止核验');if(st.isDirectory())walk(p,name);else{requireThat(st.isFile()&&st.size<=MAX_FILE_BYTES&&++count<=10000,'副本文件不受支持');actual[name]=fileHash(p);}}}
 walk(project);const stable=(o:Record<string,string>)=>JSON.stringify(Object.entries(o).sort());requireThat(stable(actual)===stable(expected),'副本与已发布版本不一致，未修改绑定',409);
 store.tx(()=>{store.put('project',{...current,directory:project,directoryOwnerRoot:data});store.audit('server','restored-project.rebind',projectId,{previousDirectory:current.directory,directory:project,revision:current.revision,files:count});});
 console.log(JSON.stringify({state:'verified_and_rebound',projectId,directory:project,revision:current.revision,files:count,sourceUntouched:true}));
}finally{store.close();}
