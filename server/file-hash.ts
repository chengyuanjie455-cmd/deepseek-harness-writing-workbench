import {openSync,closeSync,readSync,fstatSync,constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {requireThat} from './store.ts';

/** Hash an unchanged regular file in bounded memory; upload limits belong to callers. */
export function hashRegularFile(path:string){
 const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{
  const before=fstatSync(fd);requireThat(before.isFile(),'校验对象不是普通文件');
  const buffer=Buffer.alloc(1024*1024),sha=createHash('sha256');let n,total=0;
  while((n=readSync(fd,buffer,0,buffer.length,null))>0){sha.update(buffer.subarray(0,n));total+=n;}
  const after=fstatSync(fd);
  requireThat(total===before.size&&before.size===after.size&&before.mtimeMs===after.mtimeMs&&before.ctimeMs===after.ctimeMs,'文件在读取期间变化',409);
  return sha.digest('hex');
 }finally{closeSync(fd);}
}
