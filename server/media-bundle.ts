import {constants,lstatSync} from 'node:fs';
import {open} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import type {ServerResponse} from 'node:http';
import {requireThat} from './store.ts';
import type {MediaStore} from './media.ts';
const table=Array.from({length:256},(_,n)=>{for(let i=0;i<8;i++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
const u16=(b:Buffer,o:number,n:number)=>b.writeUInt16LE(n,o),u32=(b:Buffer,o:number,n:number)=>b.writeUInt32LE(n>>>0,o),u64=(b:Buffer,o:number,n:number)=>b.writeBigUInt64LE(BigInt(n),o);
export type BundleFile={path:string;name:string;bytes:number;sha256:string};
export function bundleName(name:string){
 const clean=name.normalize('NFC').replace(/[\\/:*?"<>|\x00-\x1f\x7f]/g,'_').replace(/[. ]+$/g,'')||'原件';
 const ext=clean.match(/\.[a-zA-Z0-9]{1,8}$/)?.[0]??'';let stem='';
 for(const c of ext?clean.slice(0,-ext.length):clean){if(Buffer.byteLength(stem+c+ext)>180)break;stem+=c;}
 return (stem||'原件')+ext;
}
export function validateBundle(files:BundleFile[]){
 requireThat(files.length>0,'当前范围没有可下载的原件',422);
 const names=new Set<string>();let bytes=0;
 for(const f of files){
  requireThat(f.name&&!f.name.startsWith('/')&&!f.name.includes('\\')&&f.name.split('/').every(v=>v&&v!=='.'&&v!=='..')&&Buffer.byteLength(f.name)<65536&&!names.has(f.name),'打包文件名无效或重复',409);names.add(f.name);
  requireThat(/^[a-f0-9]{64}$/.test(f.sha256)&&Number.isSafeInteger(f.bytes)&&f.bytes>=0,'原件缺少完整性记录，请刷新后重试',409);
  let st;try{st=lstatSync(f.path);}catch{requireThat(false,'部分原件已失效，请刷新画廊后重试',409);}
  requireThat(st.isFile()&&!st.isSymbolicLink()&&st.size===f.bytes,'部分原件已变更，请刷新画廊后重试',409);bytes+=f.bytes;
 }
 requireThat(Number.isSafeInteger(bytes),'打包文件大小超出支持范围',422);
}
/** ZIP64 STORE streams originals with bounded buffers and verifies each hash.
 * A failed/cancelled stream never gets a valid central directory. No temp ZIP. */
export async function serveFileBundle(files:BundleFile[],res:ServerResponse,filename='project-originals.zip',options:{head?:boolean;authorize?:()=>void}={}){
 validateBundle(files);options.authorize?.();
 const headers={'Content-Type':'application/zip','Content-Disposition':`attachment; filename="gallery-originals.zip"; filename*=UTF-8''${encodeURIComponent(bundleName(filename))}`,'Cache-Control':'no-store','X-Gallery-Count':String(files.length)};
 if(options.head){res.writeHead(200,headers);res.end();return;}
 const controller=new AbortController(),abort=()=>{if(!res.writableFinished)controller.abort();};res.once('close',abort);
 async function* zip(){let offset=0;const entries:Buffer[]=[];
  for(const f of files){
   controller.signal.throwIfAborted();options.authorize?.();const name=Buffer.from(f.name),start=offset;
   const h=Buffer.alloc(30),extra=Buffer.alloc(20);u32(h,0,0x04034b50);u16(h,4,45);u16(h,6,0x808);u16(h,12,33);u32(h,18,0xffffffff);u32(h,22,0xffffffff);u16(h,26,name.length);u16(h,28,extra.length);u16(extra,0,1);u16(extra,2,16);u64(extra,4,f.bytes);u64(extra,12,f.bytes);
   yield h;yield name;yield extra;offset+=h.length+name.length+extra.length;
   const sha=createHash('sha256');let crc=0xffffffff,bytes=0;
   const handle=await open(f.path,constants.O_RDONLY|constants.O_NOFOLLOW);
   try{
    controller.signal.throwIfAborted();
    const input=handle.createReadStream({autoClose:false,signal:controller.signal});
    // pipeline cancellation can return the generator before its iterator attaches.
    // Keep late AbortError events handled; the iterator still rejects normally.
    input.on('error',()=>{});
    try{for await(const chunk of input){
     options.authorize?.();const b=Buffer.from(chunk);sha.update(b);for(const byte of b)crc=table[(crc^byte)&255]^(crc>>>8);bytes+=b.length;requireThat(bytes<=f.bytes,'原件已变更，打包已中止',409);offset+=b.length;yield b;
    }}finally{input.destroy();}
   }finally{await handle.close();}
   requireThat(bytes===f.bytes&&sha.digest('hex')===f.sha256,'原件完整性校验失败，打包已中止',409);
   crc=(crc^0xffffffff)>>>0;const descriptor=Buffer.alloc(24);u32(descriptor,0,0x08074b50);u32(descriptor,4,crc);u64(descriptor,8,bytes);u64(descriptor,16,bytes);yield descriptor;offset+=descriptor.length;
   const c=Buffer.alloc(46),ce=Buffer.alloc(28);u32(c,0,0x02014b50);u16(c,4,45);u16(c,6,45);u16(c,8,0x808);u16(c,14,33);u32(c,16,crc);u32(c,20,0xffffffff);u32(c,24,0xffffffff);u16(c,28,name.length);u16(c,30,ce.length);u32(c,42,0xffffffff);u16(ce,0,1);u16(ce,2,24);u64(ce,4,bytes);u64(ce,12,bytes);u64(ce,20,start);entries.push(Buffer.concat([c,name,ce]));
  }
  options.authorize?.();const central=offset;for(const e of entries){yield e;offset+=e.length;}
  const z=Buffer.alloc(56);u32(z,0,0x06064b50);u64(z,4,44);u16(z,12,45);u16(z,14,45);u64(z,24,files.length);u64(z,32,files.length);u64(z,40,offset-central);u64(z,48,central);yield z;
  const locator=Buffer.alloc(20);u32(locator,0,0x07064b50);u64(locator,8,offset);u32(locator,16,1);yield locator;
  const end=Buffer.alloc(22);u32(end,0,0x06054b50);u16(end,8,0xffff);u16(end,10,0xffff);u32(end,12,0xffffffff);u32(end,16,0xffffffff);yield end;
 }
 try{res.writeHead(200,headers);await pipeline(Readable.from(zip()),res,{signal:controller.signal});}
 finally{res.off('close',abort);controller.abort();}
}
export async function serveMediaBundle(media:MediaStore,ids:string[],res:ServerResponse){
 const files=[...new Set(ids)].map(id=>media.get(id));
 return serveFileBundle(files.map((m,i)=>({path:media.path(m.id),name:`${String(i+1).padStart(3,'0')}-${m.id}.${m.mime==='video/mp4'?'mp4':m.mime.split('/')[1]}`,bytes:m.bytes,sha256:m.sha256})),res);
}
