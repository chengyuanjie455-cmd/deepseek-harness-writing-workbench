import {constants,openSync,closeSync,fstatSync,lstatSync,realpathSync,createReadStream} from 'node:fs';
import {resolve,basename,sep} from 'node:path';
import {pipeline} from 'node:stream/promises';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {Problem,requireThat} from './store.ts';

/** One byte-range contract for originals, conversation attachments and previews.
 * Suffix ranges let media clients read the trailing index without a full file. */
export function fileByteRange(req:IncomingMessage,res:ServerResponse,size:number,validators:{etag?:string;modified?:string}={}) {
  requireThat(Number.isSafeInteger(size)&&size>=0,'文件字节数无效',500);
  let start=0,end=size-1,partial=false;
  const range=req.headers.range,ifRange=req.headers['if-range'];
  if(range&&(!ifRange||ifRange===validators.etag||ifRange===validators.modified)) {
    const match=/^bytes=(\d*)-(\d*)$/.exec(range);
    const invalid=():never=>{res.setHeader('Content-Range','bytes */'+size);throw new Problem(416,'下载范围无效');};
    if(!match||(!match[1]&&!match[2])||size===0)invalid();
    if(!match![1]) {const count=Number(match![2]);if(!Number.isSafeInteger(count)||count<=0)invalid();start=Math.max(0,size-count);}
    else {start=Number(match![1]);if(match![2])end=Number(match![2]);}
    if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>=size||end<start)invalid();
    end=Math.min(end,size-1);partial=true;
  }
  return {start,end,partial};
}

/** The caller supplies the authenticated member's workspace, never a client-supplied owner/root. */
export async function serveNativeDownload(root:string,path:unknown,req:IncomingMessage,res:ServerResponse,authorized:()=>boolean=()=>true) {
  requireThat(['GET','HEAD'].includes(req.method??''),'下载只支持 GET 或 HEAD',405);
  requireThat(authorized(),'登录状态已变更，请重新登录',401);
  requireThat(typeof path==='string'&&path.startsWith('/workspace/')&&path.length<=4096&&!/[\x00-\x1f\\]/.test(path),'下载路径无效',400);
  const relative=path.slice('/workspace/'.length);
  requireThat(relative.length>0&&relative.split('/').every(p=>p&&p!=='.'&&p!=='..'),'下载路径不能离开当前工作区',403);
  const base=resolve(root),file=resolve(base,relative);
  requireThat(file.startsWith(base+sep),'下载路径不能离开当前工作区',403);
  return serveFileDownload(file,req,res,{authorized});
}

/** Streams an already resolved host file; shared by workspace and host browsing. */
export async function serveFileDownload(file:string,req:IncomingMessage,res:ServerResponse,options:{authorized?:()=>boolean;mime?:string;inline?:boolean;filename?:string}={}) {
  const authorized=options.authorized??(()=>true);
  requireThat(['GET','HEAD'].includes(req.method??''),'下载只支持 GET 或 HEAD',405);
  let fd:number|undefined;
  try {
    requireThat(realpathSync(file)===file&&!lstatSync(file).isSymbolicLink(),'下载文件不能经过符号链接',403);
    fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW);
    const stat=fstatSync(fd),current=lstatSync(file);
    requireThat(stat.isFile()&&realpathSync(file)===file&&stat.dev===current.dev&&stat.ino===current.ino,'文件已改变或不是普通文件',409);
    requireThat(authorized(),'登录状态已变更，请重新登录',401);
    const etag='"'+[stat.dev,stat.ino,stat.size,stat.mtimeMs].join('-')+'"';
    const modified=stat.mtime.toUTCString();
    const {start,end,partial}=fileByteRange(req,res,stat.size,{etag,modified});
    res.removeHeader('X-Frame-Options');
    res.writeHead(partial?206:200,{
      'Content-Type':options.inline?options.mime??'application/octet-stream':'application/octet-stream',
      'Content-Security-Policy':"default-src 'none'; sandbox",
      'Content-Disposition':(options.inline?"inline":"attachment")+"; filename=\"download\"; filename*=UTF-8''"+encodeURIComponent(basename(options.filename??file)).replace(/['()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase()),
      'Content-Length':Math.max(0,end-start+1),'Accept-Ranges':'bytes','ETag':etag,'Last-Modified':modified,
      'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff',
      ...(partial?{'Content-Range':`bytes ${start}-${end}/${stat.size}`}:{})
    });
    if(req.method==='HEAD'||stat.size===0){res.end();return;}
    const stream=createReadStream(file,{fd,autoClose:true,start,end,highWaterMark:256*1024});fd=undefined;
    const abort=()=>stream.destroy(new Error('download_cancelled'));
    req.once('aborted',abort);
    const timer=setInterval(()=>{if(!authorized())abort();},1000);timer.unref();
    try {await pipeline(stream,res);} catch(error) {if(!res.destroyed)throw error;}
    finally {clearInterval(timer);req.off('aborted',abort);}
  } catch(error:any) {
    if(['ENOENT','ENOTDIR'].includes(error?.code))throw new Problem(404,'下载文件不存在');
    if(error?.code==='ELOOP')throw new Problem(403,'下载文件不能经过符号链接');
    throw error;
  } finally {if(fd!==undefined)closeSync(fd);}
}
