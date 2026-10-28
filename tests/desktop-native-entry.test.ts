import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {createServer} from 'node:net';
import {createRequire} from 'node:module';
import {setTimeout as delay} from 'node:timers/promises';
const require=createRequire(import.meta.url);
const {HostControl}=require('../desktop/host-control.cjs');

test('desktop explicit sidebar profile reaches the actual server entry without changing other profiles',async()=>{
 const inherited=process.env.PLATFORM_NATIVE_PROJECT_SURFACE;
 process.env.PLATFORM_NATIVE_PROJECT_SURFACE='1';
 const root=mkdtempSync(join(tmpdir(),'desktop-sidebar-entry-'));
 let control:any;
 try{
  for(const enabled of [true,false,undefined]){
   const area=join(root,String(enabled)),data=join(area,'data');
   mkdirSync(join(area,'server'),{recursive:true});mkdirSync(data);
   writeFileSync(join(area,'package.json'),JSON.stringify({type:'module'}));
   symlinkSync(resolve('node_modules'),join(area,'node_modules'),'dir');
   writeFileSync(join(area,'server/main.ts'),`import ${JSON.stringify(resolve('server/main.ts'))};\n`);
   const socket=createServer();await new Promise<void>(r=>socket.listen(0,'127.0.0.1',r));
   const port=(socket.address() as any).port;await new Promise<void>((r,e)=>socket.close(error=>error?e(error):r()));
   writeFileSync(join(data,'service-config.json'),JSON.stringify({PORT:String(port),PLATFORM_BIND:'127.0.0.1',PLATFORM_DISCOVERY:'0',PLATFORM_KEEP_AWAKE:'0'}));
   control=new HostControl({root:area,data,node:process.execPath,...(enabled===undefined?{}:{nativeProjectSurface:enabled})});
   const status=await control.start();assert.equal(status.managed,true);
   const response=await fetch(status.url+'/api/status'),body:any=await response.json();
   assert.equal(body.capabilities.includes('native-project-surface'),enabled===true);
   assert.equal(body.needsSetup,true);assert.equal(body.loginRequired,true);
   assert.equal(body.modelMode,'mock');
   await control.stop();control=undefined;
   assert.equal(existsSync(join(data,'runtime-state.json')),false);
  }
  for(const value of ['true','1',1,null])assert.throws(()=>new HostControl({root,data:join(root,'data'),nativeProjectSurface:value}),/项目侧栏启动配置无效/);
 }finally{
  if(inherited===undefined)delete process.env.PLATFORM_NATIVE_PROJECT_SURFACE;else process.env.PLATFORM_NATIVE_PROJECT_SURFACE=inherited;
  if(control){
   try{if((await control.status()).managed)await control.stop();}catch(error){
    // Surface the owned service state without touching any unverified PID.
    const state=control.runtime();
    throw new Error('候选后台清理未确认：'+String((error as Error).message)+'；实例：'+String(state?.serverInstance));
   }
  }
  for(let n=0;n<20&&existsSync(join(root,'true/data/runtime-state.json'));n++)await delay(50);
  rmSync(root,{recursive:true,force:true});
 }
});
