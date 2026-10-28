import {setTimeout as delay} from 'node:timers/promises';
type Run=(args:string[])=>Promise<{stdout:string}>;
/** Docker Desktop can acknowledge removal while the name is still reserved.
 * Never create a replacement until absence is confirmed, and never hide an
 * unavailable daemon or a failed removal behind a subsequent name conflict. */
export async function removeNativeContainer(name:string,run:Run,waitMs=15000){
 if(!/^team-dsh-[a-f0-9]{24}$/.test(name))throw Error('原生环境容器身份无效');
 let removalError:unknown;try{await run(['rm','-f',name]);}catch(error){removalError=error;}
 const end=Date.now()+waitMs;
 do{
  const result=await run(['ps','-a','--filter','name=^/'+name+'$','--format','{{.Names}}']);
  if(!result.stdout.trim().split(/\s+/).includes(name))return;
  if(Date.now()>=end)break;await delay(Math.min(100,end-Date.now()));
 }while(true);
 throw new Error('原生环境旧容器尚未清理，已保留聊天记录，请稍后重试',{cause:removalError});
}
