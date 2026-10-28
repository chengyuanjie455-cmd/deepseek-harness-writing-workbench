import {opendir, lstat, realpath} from 'node:fs/promises';
import {homedir} from 'node:os';
import {resolve, join, dirname, basename, sep} from 'node:path';
import {Problem, requireThat} from './store.ts';
import type {Projects} from './project.ts';

// Lists directory names only. Import/preview/bind retain their independent checks.
export async function browseHostFolders(projects:Projects, value:string|null, mode:string|null, query='') {
  requireThat(mode===null||mode==='create'||mode==='bind','目录选择用途无效');
  requireThat(query.length<=120,'文件夹搜索过长');
  const data=resolve(projects.store.root), defaultProject=join(data,'project');
  const inside=(p:string,root:string)=>p===root||p.startsWith(root+sep);
  function visible(p:string) {
    if(p.split(sep).some(x=>x.startsWith('.')||x==='node_modules'||x.endsWith('.app')))return false;
    return !inside(p,data)||inside(p,defaultProject);
  }
  async function check(p:string) {
    requireThat(p.length<=1000&&p===resolve(p)&&!/[\x00-\x1f]/.test(p),'文件夹地址无效');
    requireThat(visible(p),'平台内部目录不可浏览',403);
    try {
      const stat=await lstat(p);
      requireThat(stat.isDirectory()&&!stat.isSymbolicLink()&&await realpath(p)===p,'只能浏览主机真实文件夹，不能经过符号链接',409);
    }catch(e){if(e instanceof Problem)throw e;throw new Problem(404,'文件夹不存在、已移走或无权读取');}
    return p;
  }
  const shortcuts:{name:string,path:string}[]=[];
  for(const [name,p] of [['主机个人文件夹',homedir()],['桌面',join(homedir(),'Desktop')],['文稿',join(homedir(),'Documents')],['下载',join(homedir(),'Downloads')],['本地项目',join(homedir(),'LocalProjects')],['外接磁盘','/Volumes'],['当前项目',projects.canonical],['主机磁盘',sep]]) {
    try {await check(p!);if(!shortcuts.some(s=>s.path===p))shortcuts.push({name:name!,path:p!});}catch{}
  }
  const path=await check(value??homedir());
  const folders:{name:string,path:string}[]=[];let scanned=0,truncated=false;
  try {
    for await(const item of await opendir(path)) {
      if(++scanned>10000){truncated=true;break;}
      if(!item.isDirectory()||!visible(join(path,item.name))||!item.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()))continue;
      if(folders.length>=500){truncated=true;break;}
      folders.push({name:item.name,path:join(path,item.name)});
    }
    // A folder may have been replaced while it was being read.
    await check(path);
  }catch(e){if(e instanceof Problem)throw e;throw new Problem(403,'无法读取这个文件夹，请检查主机权限或磁盘连接');}
  folders.sort((a,b)=>a.name.localeCompare(b.name,'zh-CN',{numeric:true}));
  let reason='';try{projects.directoryPath(path,mode==='create');}catch(e){reason=e instanceof Problem?e.message:'这个文件夹暂不可选';}
  return {path,name:basename(path)||'主机磁盘',parent:path===sep?null:dirname(path),folders,shortcuts,selectable:!reason,reason,truncated};
}
