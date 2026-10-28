import {readFileSync,readdirSync,lstatSync,existsSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {join,resolve} from 'node:path';
import {requireThat,hash,id,type Doc} from './store.ts';
import {redactor} from './incident-context.ts';
export type VerificationOptions={docker:string;image:string;commands:string[][];timeoutMs?:number;dependenciesInImage?:string;trustedPaths?:string[]};
/** Candidate code runs in an ephemeral container: no network, credentials, app data, or host write mount. */
export function dockerVerifier(options:VerificationOptions,trustedSource?:string){
 requireThat(options.image&&Array.isArray(options.commands)&&options.commands.length>0,'独立验证器需要固定镜像和检查命令');
 return async(workspace:string,signal:AbortSignal)=>{
  const checks:Doc[]=[];
  requireThat(trustedSource&&options.trustedPaths?.length,'独立验证器需要声明不可由修复智能体改写的回归测试路径');
  const check=(relative:string)=>{requireThat(!relative.startsWith('/')&&!relative.split('/').includes('..'),'回归测试路径无效');const original=join(trustedSource!,relative),candidate=join(workspace,'source',relative);requireThat(existsSync(candidate)&&!lstatSync(original).isSymbolicLink()&&!lstatSync(candidate).isSymbolicLink(),'受保护的回归测试缺失或变成链接');if(lstatSync(original).isDirectory()){for(const name of readdirSync(original))check(relative+'/'+name);}else requireThat(hash(readFileSync(original))===hash(readFileSync(candidate)),'修复修改了受保护回归测试，不能自动认定通过');};
  options.trustedPaths!.forEach(check);

  const bootstrap=`const fs=require('node:fs'),cp=require('node:child_process');fs.cpSync('/candidate','/tmp/check',{recursive:true,filter:p=>!p.split('/').includes('node_modules')});const deps=process.argv[1];if(deps)fs.symlinkSync(deps,'/tmp/check/node_modules','dir');const cmd=JSON.parse(process.argv[2]);const r=cp.spawnSync(cmd[0],cmd.slice(1),{cwd:'/tmp/check',stdio:'inherit',env:{...process.env,HOME:'/tmp',CI:'1'}});process.exit(r.status??1);`;
  for(const command of options.commands){
   signal.throwIfAborted();requireThat(command.length>0&&command.every(v=>typeof v==='string'),'验证命令无效');let output='';
   const container='incident-check-'+id();const args=['run','--name',container,'--rm','--pull=never','--network','none','--read-only','--cap-drop=ALL','--security-opt','no-new-privileges','--pids-limit','128','--memory','2g','--cpus','2','--user',`${process.getuid?.()??1000}:${process.getgid?.()??1000}`,'--tmpfs','/tmp:rw,nosuid,exec,size=4096m','--mount',`type=bind,src=${resolve(workspace,'source')},dst=/candidate,readonly`,'--entrypoint','node',options.image,'-e',bootstrap,options.dependenciesInImage??'',JSON.stringify(command)];
   const child=spawn(options.docker,args,{stdio:['ignore','pipe','pipe']});const safe=redactor();
   child.stdout.on('data',b=>output=(output+b).slice(-24000));child.stderr.on('data',b=>output=(output+b).slice(-24000));
   const stop=()=>child.kill('SIGTERM'),timer=setTimeout(stop,options.timeoutMs??120000);signal.addEventListener('abort',stop,{once:true});
   let code:number|null;try{code=await new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});}finally{clearTimeout(timer);signal.removeEventListener('abort',stop);await new Promise<void>(r=>{const cleanup=spawn(options.docker,['rm','-f',container],{stdio:'ignore'}),timer=setTimeout(()=>{cleanup.kill();r();},5000);cleanup.once('error',()=>{clearTimeout(timer);r();});cleanup.once('close',()=>{clearTimeout(timer);r();});});}
   signal.throwIfAborted();checks.push({command,passed:code===0,exitCode:code,output:safe.text(output)});if(code!==0)return {passed:false,checks};
  }
  return {passed:true,checks};
 };
}
