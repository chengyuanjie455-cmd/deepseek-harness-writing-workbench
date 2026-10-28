import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, statSync, statfsSync, lstatSync, realpathSync, readFileSync, openSync, readSync, closeSync, unlinkSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {withMediaCheck} from './media-check-slots.ts';
import {fileByteRange} from './native-download.ts';
import { Store, id, now, requireThat, type Doc } from './store.ts';

const run = promisify(execFile);
const MAX_MEDIA = 1024 * 1024 * 1024;
export function adoptedMediaIds(store:Store){return new Set<string>(store.all('video-job').filter(j=>j.mediaId&&j.changeId&&store.get('change',j.changeId)?.state==='committed').map(j=>j.mediaId));}
export function projectSharedMedia(store:Store,media:Doc){return media.scope==='project'||adoptedMediaIds(store).has(media.id);}
export class MediaStore {
  root: string;
  constructor(public store: Store) { this.root = join(store.root, 'media'); mkdirSync(this.root, { recursive: true, mode: 0o700 }); for(const name of readdirSync(this.root)){if(!/^qa-[a-f0-9-]{36}$/.test(name))continue;const dir=join(this.root,name),st=lstatSync(dir);if(!st.isSymbolicLink()&&st.isDirectory()&&Date.now()-st.mtimeMs>86400000&&readdirSync(dir).every(f=>/^(\d{4}|last)\.jpg$/.test(f)&&lstatSync(join(dir,f)).isFile()))rmSync(dir,{recursive:true,force:true});} }
  capacity(bytes = MAX_MEDIA) { const d = statfsSync(this.root); requireThat(d.bavail * d.bsize > bytes + 1024 * 1024 * 1024, '磁盘可用空间不足，停止接收新媒体，原件未删除', 507); }
  path(mediaId: string) { requireThat(/^[a-f0-9-]{36}$/.test(mediaId), '媒体编号无效'); return join(this.root, mediaId); }
  async ingest(source: Readable, owner: string, scope = 'private', name = 'video.mp4', signal?: AbortSignal, onProgress?: (bytes:number)=>void, expectedBytes?:number, derived?:{internalDerived:'video_qa_frame';derivedFrom:string}) {
    this.capacity(); const mediaId = id(); const temp = this.path(mediaId) + '.partial'; const sha = createHash('sha256'); let bytes = 0;
    const counter = new Transform({ transform(chunk, _, cb) { bytes += chunk.length; if (bytes > MAX_MEDIA) return cb(new Error('媒体文件超过 1 GiB 上限')); sha.update(chunk); try { onProgress?.(bytes); } catch(e) { return cb(e as Error); } cb(null, chunk); } });
    try {
      await pipeline(source, counter, createWriteStream(temp, { flags: 'wx', mode: 0o600 }), { signal });
      requireThat(expectedBytes===undefined || bytes===expectedBytes,'原片下载字节数不完整',502); requireThat(bytes > 0, '媒体为空'); const fd = openSync(temp, 'r'); const h = Buffer.alloc(16); try { readSync(fd, h, 0, 16, 0); } finally { closeSync(fd); }
      const mime = h.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'image/png' : h[0] === 255 && h[1] === 216 && h[2] === 255 ? 'image/jpeg' : h.toString('ascii', 0, 4) === 'RIFF' && h.toString('ascii', 8, 12) === 'WEBP' ? 'image/webp' : h.toString('ascii', 4, 8) === 'ftyp' ? 'video/mp4' : h.toString('ascii',0,4)==='RIFF'&&h.toString('ascii',8,12)==='WAVE'?'audio/wav':h.toString('ascii',0,3)==='ID3'||h[0]===255&&(h[1]&0xe0)===0xe0?'audio/mpeg':h.toString('ascii',0,4)==='fLaC'?'audio/flac':h.toString('ascii',0,4)==='OggS'?'audio/ogg':'';
      requireThat(mime, '当前媒体仅支持经过内容识别的 PNG/JPEG/WebP/MP4/WAV/MP3/FLAC/OGG', 422);
      renameSync(temp, this.path(mediaId));
      const doc = { id: mediaId, owner, scope, name: name.slice(0, 160), mime, bytes, sha256: sha.digest('hex'), ...(derived?{internalDerived:derived.internalDerived,derivedFrom:derived.derivedFrom}:{}), created: now() }; this.store.put('media', doc); return doc;
    } catch (e) { if (existsSync(temp)) unlinkSync(temp); throw e; }
  }
  async verify(mediaId:string, expectedSHA:string, signal?:AbortSignal) {
    const m=this.get(mediaId), sha=createHash('sha256'); let bytes=0;
    for await(const chunk of createReadStream(this.path(mediaId),{signal})) {bytes+=chunk.length;sha.update(chunk);}
    requireThat(bytes===m.bytes && sha.digest('hex')===expectedSHA && m.sha256===expectedSHA,'主机原片完整性检查失败，已保留文件等待核对',409);
  }
  async importOriginal(path: string, user: Doc) {
    requireThat(user.role === 'admin' && this.store.get('user', user.id)?.active, '仅超管可导入主机素材', 403);
    const absolute = resolve(path); requireThat(absolute === path && realpathSync(absolute) === absolute && lstatSync(absolute).isFile(), '请选择无符号链接的本机原文件');
    const before = statSync(absolute); requireThat(before.size <= MAX_MEDIA, '媒体文件过大');
    const media = await this.ingest(createReadStream(absolute), user.id, 'private', absolute.split('/').at(-1));
    const after = statSync(absolute); requireThat(before.size === after.size && before.mtimeMs === after.mtimeMs, '导入期间源文件改变，请核对原件', 409);
    requireThat(this.store.get('user',user.id)?.active && this.store.get('user',user.id)?.role==='admin','导入期间管理员权限改变',403);
    this.store.put('media',{...media,scope:'project'}); media.scope='project';
    this.store.audit(user.id, 'media.import', media.id, { sha256: media.sha256, bytes: media.bytes }); return media;
  }
  get(mediaId: string) { const m = this.store.get('media', mediaId); requireThat(m && existsSync(this.path(mediaId)), '媒体不存在', 404); return m; }
  canRead(m: Doc, user: Doc) { return user.role === 'admin' || m.owner === user.id || projectSharedMedia(this.store,m); }
  serve(req: IncomingMessage, res: ServerResponse, mediaId: string, user: Doc) {
    const m = this.get(mediaId); requireThat(this.canRead(m, user), '媒体不存在或无权限', 404);
    if (user.role === 'admin' && m.owner !== user.id && m.scope !== 'project') this.store.audit(user.id, 'admin.media.read', m.id);
    const etag='"sha256-'+m.sha256+'"',{start,end,partial}=fileByteRange(req,res,m.bytes,{etag});
    res.writeHead(partial ? 206 : 200, { 'Content-Type': m.mime, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', 'ETag':etag, 'X-Content-SHA256': m.sha256, 'Cache-Control': 'no-store', ...(partial ? { 'Content-Range': `bytes ${start}-${end}/${m.bytes}` } : {}), 'Content-Disposition': `${req.url?.includes('download=1') ? 'attachment' : 'inline'}; filename="${m.id}.${m.mime === 'video/mp4' ? 'mp4' : m.mime === 'audio/mpeg'?'mp3':m.mime.split('/')[1]}"` });
    if (req.method === 'HEAD') return res.end(); const stream = createReadStream(this.path(m.id), { start, end }); stream.on('error', () => res.destroy()); res.on('close', () => stream.destroy()); stream.pipe(res);
  }
  async technicalQA(mediaId: string, expectedDuration: number, signal?:AbortSignal): Promise<Doc> {
    return withMediaCheck(async()=>{
      const m=this.get(mediaId);try{await this.verify(mediaId,m.sha256,signal);}catch(e){signal?.throwIfAborted();return {passed:false,checkedAt:now(),error:'主机原片完整性检查失败，原片已保留',humanAcceptance:'pending'};}
      const cached=this.store.get('media-check',mediaId);
      if(cached?.version===1&&cached.sha256===m.sha256&&cached.expectedDuration===expectedDuration){
        try{for(const frame of cached.result.frames){const f=this.get(frame.mediaId);await this.verify(f.id,f.sha256,signal);}return cached.result;}catch(e){signal?.throwIfAborted();}
      }
      const result=await this.checkVideo(mediaId,expectedDuration,signal);
      if(result.passed)this.store.put('media-check',{id:mediaId,owner:m.owner,project:m.project??this.store.projectId??'shared',version:1,sha256:m.sha256,expectedDuration,result});return result;
    },signal);
  }
  private async checkVideo(mediaId:string,expectedDuration:number,signal?:AbortSignal):Promise<Doc>{
    const m = this.get(mediaId); requireThat(m.mime === 'video/mp4', '返回内容不是视频', 422);
    let frameDir:string|undefined;
    try {
      const { stdout } = await run('ffprobe', ['-v','error','-show_entries','format=duration:stream=codec_type,width,height','-of','json',this.path(mediaId)], { signal, timeout: 30000, maxBuffer: 1024 * 1024 });
      const info = JSON.parse(stdout); const duration = Number(info.format?.duration); const video = info.streams?.find((s: Doc) => s.codec_type === 'video');
      requireThat(video && Number.isFinite(duration) && Math.abs(duration - expectedDuration) <= 0.5, '原片时长或视频流与方案不符', 422);
      await run('ffmpeg', ['-nostdin','-v','error','-xerror','-i',this.path(mediaId),'-f','null','-'], { signal, timeout: 120000, maxBuffer: 1024 * 1024 });
      frameDir=join(this.root,'qa-'+id());mkdirSync(frameDir,{mode:0o700});
      await run('ffmpeg',['-nostdin','-v','error','-i',this.path(mediaId),'-vf','fps=1:start_time=0','-frames:v','121',join(frameDir,'%04d.jpg')],{signal,timeout:120000,maxBuffer:1024*1024});
      const frameNames=readdirSync(frameDir).sort();const frames:Doc[]=[];
      for(let i=0;i<frameNames.length;i++){const frame=await this.ingest(createReadStream(join(frameDir,frameNames[i])),m.owner,'private',`${i}s.jpg`,signal,undefined,undefined,{internalDerived:'video_qa_frame',derivedFrom:mediaId});frames.push({mediaId:frame.id,time:i});}
      const last=join(frameDir,'last.jpg');await run('ffmpeg',['-nostdin','-v','error','-ss',String(Math.max(0,duration-0.1)),'-i',this.path(mediaId),'-frames:v','1',last],{signal,timeout:30000,maxBuffer:1024*1024});
      if(existsSync(last)){const frame=await this.ingest(createReadStream(last),m.owner,'private','last.jpg',signal,undefined,undefined,{internalDerived:'video_qa_frame',derivedFrom:mediaId});frames.push({mediaId:frame.id,time:Math.max(0,duration-0.1)});}
      requireThat(frames.length>=Math.ceil(duration),'逐秒抽帧未完整完成',422);
      return { passed: true, frames, duration, width: video.width, height: video.height, hasAudio: info.streams.some((s: Doc) => s.codec_type === 'audio'), sha256: m.sha256, checkedAt: now(), humanAcceptance: 'pending' };
    } catch { signal?.throwIfAborted(); return { passed: false, checkedAt: now(), error: '视频解码、时长核对未通过或 ffmpeg/ffprobe 不可用；原片已保留', humanAcceptance: 'pending' }; } finally { if(frameDir)rmSync(frameDir,{recursive:true,force:true}); }
  }
}
