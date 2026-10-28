const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const uuid = /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const MAX = 1024 * 1024 * 1024;
async function digest(file) { const sha=createHash('sha256'); for await(const b of fs.createReadStream(file))sha.update(b);return sha.digest('hex'); }
// Only trusted, authenticated server responses enter this queue; renderer chooses no file path.
class MediaReceiver {
  constructor(connection, downloads) { this.connection=connection;this.root=path.join(downloads,'DeepSeek Team');this.items=new Map();this.scope='';this.active=false;this.timer=undefined; }
  identity() { const c=this.connection;return c.cookie && uuid.test(c.serverId) && uuid.test(c.userId||'') ? `${c.epoch}:${c.serverId}:${c.userId}` : ''; }
  reset() {clearTimeout(this.timer);this.timer=undefined;this.items.clear();this.scope=this.identity();}
  observe(plans) {
    if(this.scope!==this.identity())this.reset();if(!this.scope || !Array.isArray(plans))return;
    for(const p of plans)if(p.owner===this.connection.userId)for(const j of p.jobs??[]) {
      if(j.owner!==this.connection.userId || !uuid.test(j.mediaId||'') || !uuid.test(j.id||'') || !/^[a-f0-9]{64}$/.test(j.mediaSHA256||''))continue;
      if(!this.items.has(j.mediaId))this.items.set(j.mediaId,{mediaId:j.mediaId,sha256:j.mediaSHA256,jobId:j.id,state:'queued',bytes:0,attempts:0,nextAttempt:0});
    }
    void this.pump();
  }
  status() {if(this.scope!==this.identity())this.reset();return [...this.items.values()].map(({nextAttempt,...x})=>({...x,nextAttempt:x.state==='retrying'?nextAttempt:null}));}
  async pump() {
    if(this.active || !this.scope || this.scope!==this.identity())return;
    clearTimeout(this.timer);
    const item=[...this.items.values()].find(i=>['queued','retrying'].includes(i.state)&&i.nextAttempt<=Date.now());
    if(!item) {const next=[...this.items.values()].filter(i=>i.state==='retrying').map(i=>i.nextAttempt);if(next.length){this.timer=setTimeout(()=>void this.pump(),Math.max(100,Math.min(...next)-Date.now()));this.timer.unref?.();}return;}
    this.active=true;const scope=this.scope;const current=()=>scope===this.identity() && scope===this.scope;
    let temp, response;
    try {
      item.state='receiving';item.attempts++;item.bytes=0;item.error=null;
      const dir=path.join(this.root,this.connection.serverId,this.connection.userId);
      for(const d of [this.root,path.dirname(dir),dir]) {fs.mkdirSync(d,{recursive:true,mode:0o700});if(!fs.lstatSync(d).isDirectory() || fs.lstatSync(d).isSymbolicLink())throw Error('接收目录不能是符号链接');}
      const file=path.join(dir,item.mediaId+'.mp4');
      if(fs.existsSync(file)) {
        if(!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink() || fs.statSync(file).size>MAX || await digest(file)!==item.sha256)throw Object.assign(Error('本地同名文件已改变，保留原文件，请手动下载或移开后重试'),{permanent:true});
        if(!current())return;
        item.bytes=fs.statSync(file).size;item.totalBytes=item.bytes;item.state='saved';item.path=file;item.savedAt=new Date().toISOString();return;
      }
      const disk=fs.statfsSync(dir);if(disk.bavail*disk.bsize<MAX+256*1024*1024)throw Error('成员电脑磁盘空间不足，主机原片仍保留');
      response=await this.connection.media(item.mediaId);
      if(!current()){response.destroy();return;}
      const length=Number(response.headers['content-length']);
      if(response.statusCode!==200 || response.headers['content-type']!=='video/mp4' || !Number.isSafeInteger(length) || length<=0 || length>MAX || response.headers['x-content-sha256']!==item.sha256)throw Error('原片响应或校验信息不一致');
      item.totalBytes=length;const sha=createHash('sha256');
      const counter=new Transform({transform(chunk,_,cb){if(!current())return cb(Error('登录身份已改变'));item.bytes+=chunk.length;if(item.bytes>length)return cb(Error('原片长度超出回执'));sha.update(chunk);cb(null,chunk);}});
      temp=file+'.'+randomUUID()+'.partial';
      await pipeline(response,counter,fs.createWriteStream(temp,{flags:'wx',mode:0o600}));
      if(!current())return;
      if(item.bytes!==length || sha.digest('hex')!==item.sha256)throw Error('原片下载不完整或 SHA-256 不一致');
      // link is no-clobber: another process/file can never be silently overwritten.
      await fs.promises.link(temp,file);await fs.promises.unlink(temp);temp=undefined;
      if(!current())return;
      item.state='saved';item.path=file;item.savedAt=new Date().toISOString();
    } catch(e) {
      if(current()){item.state=e.permanent?'blocked':'retrying';item.error=e.permanent?e.message:'原片尚未完整接收，请检查网络和本机磁盘；30 秒后重试下载，主机原片保留。';item.nextAttempt=Date.now()+30000;}
    } finally {
      response?.destroy();if(temp)await fs.promises.rm(temp,{force:true}).catch(()=>{});
      this.active=false;if(current())void this.pump();else if(this.scope===this.identity())void this.pump();
    }
  }
  close() {this.reset();this.scope='';}
}
module.exports={MediaReceiver};
