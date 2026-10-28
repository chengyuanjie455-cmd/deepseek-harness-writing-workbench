import {mkdirSync,existsSync,renameSync,unlinkSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {FairQueue} from './fair-queue.ts';
import {requireThat,id,type Doc} from './store.ts';
import type {MediaStore} from './media.ts';
import {serveFileDownload} from './native-download.ts';
const run=promisify(execFile),queue=new FairQueue(2),pending=new Map<string,Promise<string>>();
type PreviewSource={root:string;sha256:string;mime:string;path:string;owner:string;capacity:()=>void;verify:()=>void|Promise<void>};
// Both generated media and published immutable project files use the same
// bounded derivative queue and cache. Creating a thumbnail never imports an
// extra media record or modifies the original object.
export async function previewSourceFile(source:PreviewSource,variant:string){
 requireThat(['thumb','preview'].includes(variant),'预览类型无效');const video=source.mime.startsWith('video/');
 requireThat(video||source.mime.startsWith('image/'),'该文件不支持媒体预览',415);
 requireThat(/^[a-f0-9]{64}$/.test(source.sha256),'原件哈希无效');
 const root=join(source.root,'media-previews');mkdirSync(root,{recursive:true,mode:0o700});
 const file=join(root,source.sha256+'-v1-'+variant+(video&&variant==='preview'?'.mp4':'.jpg'));
 if(existsSync(file)&&statSync(file).size>0)return file;
 if(pending.has(file))return pending.get(file)!;
 const operation=(async()=>{const release=await queue.acquire(source.owner,undefined,'media-preview'),temp=file+'.'+id()+'.partial';try{
  source.capacity();await source.verify();
  const scale=variant==='thumb'?360:960,args=['-nostdin','-v','error','-threads','1','-i',source.path,'-map_metadata','-1','-vf',`scale=w='min(${scale},iw)':h=-2`];
  if(video&&variant==='preview')args.push('-c:v','libx264','-preset','veryfast','-crf','28','-c:a','aac','-b:a','96k','-movflags','+faststart','-f','mp4');else args.push('-frames:v','1','-q:v','4','-f','image2');
  args.push(temp);await run('ffmpeg',args,{timeout:180000,maxBuffer:1024*1024});requireThat(statSync(temp).size>0,'预览未生成',502);renameSync(temp,file);return file;
 }finally{if(existsSync(temp))unlinkSync(temp);release();}})();pending.set(file,operation);
 try{return await operation;}finally{pending.delete(file);}
}
export async function previewFile(media:MediaStore,mediaId:string,variant:string){
 const m=media.get(mediaId);return previewSourceFile({root:media.store.root,sha256:m.sha256,mime:m.mime,path:media.path(m.id),owner:m.owner,capacity:()=>media.capacity(Math.min(m.bytes,64*1024*1024)),verify:async()=>{await media.verify(m.id,m.sha256);}},variant);
}
export async function serveMediaPreview(media:MediaStore,req:IncomingMessage,res:ServerResponse,mediaId:string,user:Doc,variant:string){
 const authorized=()=>{const current=media.store.global.get('user',user.id),m=media.store.get('media',mediaId);return !!current?.active&&!!m&&media.canRead(m,current);};
 requireThat(authorized(),'媒体不存在或无权限',404);const file=await previewFile(media,mediaId,variant);requireThat(authorized(),'登录身份已变更',401);
 res.setHeader('X-Media-Derivative','preview-only');return serveFileDownload(file,req,res,{authorized,inline:true,mime:file.endsWith('.mp4')?'video/mp4':'image/jpeg'});
}
