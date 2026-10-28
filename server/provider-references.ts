import {randomBytes} from 'node:crypto';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {Store,hash,requireThat,now,type Doc} from './store.ts';
import {MediaStore} from './media.ts';
import {httpsURL} from './video-catalog.ts';

/** A grant exposes one frozen reference original for 48 hours, never a directory. */
export class ProviderReferences {
  constructor(public store:Store,public media:MediaStore){}
  async prepare(asset:Doc,config:Doc,signal:AbortSignal){
    const origin=httpsURL(config.origin);requireThat(origin.pathname==='/'&&!origin.search,'参考原图主机地址无效');
    const m=this.media.get(asset.mediaId);requireThat(/^(image|video|audio)\//.test(m.mime),'参考媒体类型不受支持',422);
    await this.media.verify(m.id,asset.sha256,signal);
    const token=randomBytes(24).toString('hex');
    this.store.put('provider-reference',{id:hash(token),mediaId:m.id,sha256:m.sha256,bytes:m.bytes,expires:Date.now()+48*3600_000,created:now(),storageRevision:config.revision});
    return origin.origin+'/api/provider-reference/'+token;
  }
  async serve(req:IncomingMessage,res:ServerResponse,token:string){
    requireThat(/^[a-f0-9]{48}$/.test(token),'参考原图链接不存在',404);
    const grant=this.store.get('provider-reference',hash(token));requireThat(grant&&grant.expires>Date.now(),'参考原图链接已失效',404);
    const m=this.media.get(grant.mediaId);requireThat(/^(image|video|audio)\//.test(m.mime)&&m.sha256===grant.sha256&&m.bytes===grant.bytes,'参考原件不匹配',409);
    await this.media.verify(m.id,grant.sha256);
    this.media.serve(req,res,m.id,{id:m.owner,role:'member'});
  }
}
