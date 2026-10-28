import {openSync,closeSync,readSync,writeSync,fstatSync,statSync,statfsSync,readFileSync,existsSync,renameSync,unlinkSync,constants} from 'node:fs';
import {join} from 'node:path';import {createHash} from 'node:crypto';import {id,requireThat,hash,type Doc} from './store.ts';
export const MAX_FILE_BYTES=256*1024*1024;
const cache=new Map<string,{stamp:string;info:Doc}>();
export function diskSpace(root:string,bytes:number){const s=statfsSync(root);requireThat(s.bavail*s.bsize>bytes+1024*1024*1024,'主机磁盘空间不足，原件未删除，请联系管理员',507);}
export function fileHash(path:string){const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{const before=fstatSync(fd);requireThat(before.isFile()&&before.size<=MAX_FILE_BYTES,'附件超过256 MiB或不是普通文件',413);const buf=Buffer.alloc(1024*1024),sha=createHash('sha256');let n;while((n=readSync(fd,buf,0,buf.length,null))>0)sha.update(buf.subarray(0,n));const after=fstatSync(fd);requireThat(before.size===after.size&&before.mtimeMs===after.mtimeMs&&before.ctimeMs===after.ctimeMs,'文件在读取期间变化',409);return sha.digest('hex');}finally{closeSync(fd);}}
export function objectPath(root:string,digest:string){requireThat(/^[a-f0-9]{64}$/.test(digest),'无效文件哈希');return join(root,'blobs',digest);}
export function objectInfo(root:string,digest:string):Doc{
 const path=objectPath(root,digest),st=statSync(path),stamp=[st.size,st.mtimeMs,st.ctimeMs].join(':');const previous=cache.get(path);if(previous?.stamp===stamp)return previous.info;
 requireThat(fileHash(path)===digest,'原件完整性检查失败',503);const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW),head=Buffer.alloc(Math.min(st.size,4*1024*1024));try{readSync(fd,head,0,head.length,0);}finally{closeSync(fd);}
 const mime=head.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'image/png':head[0]===255&&head[1]===216&&head[2]===255?'image/jpeg':head.toString('ascii',0,4)==='RIFF'&&head.toString('ascii',8,12)==='WEBP'?'image/webp':head.toString('ascii',0,5)==='%PDF-'?'application/pdf':head.toString('ascii',4,8)==='ftyp'&&['isom','iso2','mp41','mp42','avc1','M4V ','dash','qt  '].includes(head.toString('ascii',8,12))?(head.toString('ascii',8,12)==='qt  '?'video/quicktime':'video/mp4'):head.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3]))&&head.subarray(0,128).includes(Buffer.from('webm'))?'video/webm':'application/octet-stream';
 let text=mime==='application/octet-stream'&&st.size<=4*1024*1024&&!head.includes(0);if(text)try{new TextDecoder('utf-8',{fatal:true}).decode(head);}catch{text=false;}
 const info={bytes:st.size,text,mime,sha256:digest};cache.set(path,{stamp,info});return info;
}
export function storeFile(root:string,source:string){
 const expected=fileHash(source),dest=objectPath(root,expected);if(existsSync(dest)){objectInfo(root,expected);return expected;}
 const size=statSync(source).size;diskSpace(root,size);const temp=join(root,'blobs','upload-'+id()),input=openSync(source,constants.O_RDONLY|constants.O_NOFOLLOW),output=openSync(temp,'wx',0o600);const sha=createHash('sha256');let copied=0;
 try{const buf=Buffer.alloc(1024*1024);let n;while((n=readSync(input,buf,0,buf.length,null))>0){copied+=n;requireThat(copied<=MAX_FILE_BYTES,'附件超过256 MiB',413);sha.update(buf.subarray(0,n));let at=0;while(at<n)at+=writeSync(output,buf,at,n-at);}requireThat(copied===size&&sha.digest('hex')===expected,'原件在保存时变化',409);}catch(e){unlinkSync(temp);throw e;}finally{closeSync(input);closeSync(output);}
 renameSync(temp,dest);objectInfo(root,expected);return expected;
}
