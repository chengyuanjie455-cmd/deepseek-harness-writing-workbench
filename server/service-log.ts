import {openSync,closeSync,writeSync,fstatSync,existsSync,renameSync,unlinkSync,lstatSync} from 'node:fs';
import {assertStoragePath} from './external-storage.ts';

export class RotatingLog {
 private fd:number;private size:number;
 constructor(readonly file:string,readonly maxBytes=20*1024*1024,readonly keep=7){
  assertStoragePath(file);if(existsSync(file)&&!lstatSync(file).isFile())throw Error('运行日志不是普通文件');
  this.fd=openSync(file,'a',0o600);this.size=fstatSync(this.fd).size;
 }
 write(chunk:Buffer|string){const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);
  if(this.size&&this.size+bytes.length>this.maxBytes){assertStoragePath(this.file);closeSync(this.fd);
   if(existsSync(this.file+'.'+this.keep))unlinkSync(this.file+'.'+this.keep);
   for(let n=this.keep-1;n>=1;n--)if(existsSync(this.file+'.'+n))renameSync(this.file+'.'+n,this.file+'.'+(n+1));
   renameSync(this.file,this.file+'.1');this.fd=openSync(this.file,'a',0o600);this.size=0;
  }
  let offset=0;while(offset<bytes.length)offset+=writeSync(this.fd,bytes,offset);this.size+=bytes.length;
 }
 close(){if(this.fd>=0){closeSync(this.fd);this.fd=-1;}}
}
export function installServiceLog(file:string){
 const sink=new RotatingLog(file);
 for(const stream of [process.stdout,process.stderr])stream.write=((chunk:any,encoding?:any,callback?:any)=>{
  const cb=typeof encoding==='function'?encoding:callback;
  sink.write(Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk,typeof encoding==='string'?encoding as BufferEncoding:'utf8'));if(cb)queueMicrotask(cb);return true;
 }) as typeof stream.write;
 process.once('exit',()=>sink.close());
 return sink;
}
