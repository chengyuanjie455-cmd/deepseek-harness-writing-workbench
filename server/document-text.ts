import {readFileSync,openSync,readSync,closeSync,existsSync,statSync,lstatSync,constants} from 'node:fs';import {extname} from 'node:path';import {fileURLToPath} from 'node:url';import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {setTimeout as delay} from 'node:timers/promises';import {objectPath,objectInfo} from './file-objects.ts';import {hashRegularFile} from './file-hash.ts';import {requireThat,type Doc} from './store.ts';
const tool=(name:string)=>process.platform==='darwin'?['/opt/homebrew/bin/','/usr/local/bin/','/usr/bin/'].map(p=>p+name).find(p=>existsSync(p))??name:name;
const run=promisify(execFile),cache=new Map<string,Doc>();let active=0,waiting=0,cacheBytes=0;
const verified=new Map<string,string>();
const stamp=(s:import('node:fs').Stats)=>[s.dev,s.ino,s.size,s.mtimeMs,s.ctimeMs].join(':');
export function verifiedDocumentOriginal(path:string,digest:string){
 requireThat(/^[a-f0-9]{64}$/.test(digest)&&lstatSync(path).isFile(),'附件原件路径无效',409);const before=statSync(path),key=path+':'+digest,value=stamp(before);
 if(verified.get(key)!==value){requireThat(hashRegularFile(path)===digest,'附件原件哈希不符，未读取或替换原件',409);if(verified.size>=256)verified.delete(verified.keys().next().value!);verified.set(key,value);}return before;
}
async function acquire(){requireThat(waiting<32,'文档解析队列已满，请稍后读取',429);waiting++;const end=Date.now()+30000;try{while(active>=2){requireThat(Date.now()<end,'文档解析等待超时，原件仍已保存',503);await delay(20);}active++;}finally{waiting--;}}
export async function documentText(root:string,digest:string,name:string,offset=0,limit=24000):Promise<Doc>{
 return extractText(objectPath(root,digest),objectInfo(root,digest),name,root+':'+digest,offset,limit);
}
// Only call after resolving an authorized native persistence reference. The
// original stays in native CAS; no copy is published into project blobs.
export async function nativeDocumentText(path:string,digest:string,name:string,offset=0,limit=24000):Promise<Doc>{
 const before=verifiedDocumentOriginal(path,digest),fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW),head=Buffer.alloc(Math.min(before.size,65536));try{readSync(fd,head,0,head.length,0);}finally{closeSync(fd);}
 const mime=head.subarray(0,5).toString()==='%PDF-'?'application/pdf':head.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'image/png':head[0]===255&&head[1]===216?'image/jpeg':head.toString('ascii',0,4)==='RIFF'&&head.toString('ascii',8,12)==='WEBP'?'image/webp':head.toString('ascii',4,8)==='ftyp'?'video/mp4':'application/octet-stream';
 let text=mime==='application/octet-stream'&&before.size<=40*1024*1024&&!head.includes(0);if(text)try{new TextDecoder('utf-8',{fatal:true}).decode(head,{stream:before.size>head.length});}catch{text=false;}
 const result=await extractText(path,{sha256:digest,bytes:before.size,mime,text},name,path+':'+digest,offset,limit),after=statSync(path);if(stamp(before)!==stamp(after)){const key=path+':'+digest+':'+extname(name).toLowerCase(),old=cache.get(key);if(old){cacheBytes-=Buffer.byteLength(old.content);cache.delete(key);}verified.delete(path+':'+digest);requireThat(false,'附件在解析期间发生变化，未采用本次正文',409);}return result;
}
async function extractText(path:string,info:Doc,name:string,identity:string,offset:number,limit:number):Promise<Doc>{
 requireThat(Number.isInteger(offset)&&offset>=0&&Number.isInteger(limit)&&limit>=1&&limit<=32000,'读取范围无效');const ext=extname(name).toLowerCase(),key=identity+':'+ext;let result=cache.get(key);
 if(!result){let content='',extraction='unsupported',note='原件已保存，可下载和引用；此格式尚未提供文本解析。';
 if(info.text){content=readFileSync(path,'utf8');extraction='text';note='原文文本';}
 else if(info.mime==='application/pdf'||['.docx','.xlsx','.pptx'].includes(ext)){
  await acquire();
  try{if(info.mime==='application/pdf'){const r=await run(tool('pdftotext'),['-enc','UTF-8',path,'-'],{timeout:15000,maxBuffer:40*1024*1024});content=r.stdout;extraction=content.trim()?'pdf_text':'no_text';note='PDF可提取的文本；扫描页未执行OCR，原始排版与图片以原件为准。';}else{const r=await run(tool('python3'),[fileURLToPath(new URL('./document-text.py',import.meta.url)),path,ext],{timeout:15000,maxBuffer:40*1024*1024});content=JSON.parse(r.stdout).text;extraction='office_text';note='提取Office正文文本，不执行宏或外部链接；排版和嵌入图片仍以原件为准。';}}catch{extraction='unavailable';note='此文档暂无法提取文本（可能加密、损坏、超出解析范围或主机缺少解析工具）；原件已保留。';}finally{active--;}
 }else if(info.mime.startsWith('image/')){extraction='image';note='图片原件已保存，可预览或用作生成参考；当前文字工具未识别画面或执行OCR。';}
 result={content,extraction,note};const bytes=Buffer.byteLength(content);while(cache.size&&(cache.size>=100||cacheBytes+bytes>64*1024*1024)){const first=cache.keys().next().value!;cacheBytes-=Buffer.byteLength(cache.get(first)!.content);cache.delete(first);}if(extraction!=='unavailable'&&bytes<=64*1024*1024){cache.set(key,result);cacheBytes+=bytes;}
 }
 const content=result.content.slice(offset,offset+limit);return {...info,content,extraction:result.extraction,note:result.note,offset,nextOffset:offset+content.length<result.content.length?offset+content.length:null,totalCharacters:result.content.length};
}
