import {constants,openSync,closeSync,fstatSync,readSync,writeSync,fsyncSync} from 'node:fs';
import {requireThat,type Doc} from './store.ts';
import {diskSpace} from './file-objects.ts';
/** Resume compares acknowledged bytes; never blindly appends a retried request. */
export function receiveChunk(path:string,total:number,b:Doc,spaceRoot:string){
 requireThat(Number.isSafeInteger(b.offset)&&b.offset>=0&&typeof b.base64==='string'&&b.base64.length<=1400000,'分块参数错误');
 const bytes=Buffer.from(b.base64,'base64');requireThat(bytes.length>0&&bytes.length<=1024*1024&&bytes.toString('base64')===b.base64,'分块编码无效');requireThat(b.offset+bytes.length<=total,'分块超过文件总量',413);
 const fd=openSync(path,constants.O_RDWR|constants.O_NOFOLLOW);
 try{const size=fstatSync(fd).size;requireThat(b.offset<=size,'分块不连续，请恢复原上传',409);
 if(b.offset<size){requireThat(b.offset+bytes.length<=size,'重复分块边界冲突',409);const old=Buffer.alloc(bytes.length);readSync(fd,old,0,old.length,b.offset);requireThat(old.equals(bytes),'重复分块内容不一致',409);}
 else{diskSpace(spaceRoot,bytes.length);let at=0;while(at<bytes.length)at+=writeSync(fd,bytes,at,bytes.length-at,b.offset+at);fsyncSync(fd);}return fstatSync(fd).size;
 }finally{closeSync(fd);}
}
