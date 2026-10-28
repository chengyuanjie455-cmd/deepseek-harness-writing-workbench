import { createHmac, createHash } from 'node:crypto';
import { createReadStream, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store, id, now, requireThat, type Doc } from './store.ts';
import { fields, text, httpsURL } from './video-catalog.ts';
import { MediaStore } from './media.ts';
import {ProviderReferences} from './provider-references.ts';
const digest=(s:string)=>createHash('sha256').update(s).digest('hex');
const mac=(key:string|Buffer,value:string)=>createHmac('sha256',key).update(value).digest();
const encode=(s:string)=>encodeURIComponent(s).replace(/[!'()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase());
// S3-compatible, path-style SigV4. Credentials are used only in the server process.
export function signedObjectURL(c:Doc,secret:Doc,key:string,method='GET',date=new Date()) {
  const stamp=date.toISOString().replace(/[:-]|\.\d{3}/g,''),day=stamp.slice(0,8);const scope=`${day}/${c.region}/s3/aws4_request`;
  const url=new URL(c.origin);url.pathname='/'+[c.bucket,...key.split('/')].map(encode).join('/');
  const q:Record<string,string>={'X-Amz-Algorithm':'AWS4-HMAC-SHA256','X-Amz-Credential':`${secret.accessKeyId}/${scope}`,'X-Amz-Date':stamp,'X-Amz-Expires':'86400','X-Amz-SignedHeaders':'host'};
  const canonicalQuery=Object.keys(q).sort().map(k=>encode(k)+'='+encode(q[k])).join('&');
  const canonical=`${method}\n${url.pathname}\n${canonicalQuery}\nhost:${url.host}\n\nhost\nUNSIGNED-PAYLOAD`;
  const k=mac(mac(mac(mac('AWS4'+secret.secretAccessKey,day),c.region),'s3'),'aws4_request');
  const signature=createHmac('sha256',k).update(`AWS4-HMAC-SHA256\n${stamp}\n${scope}\n${digest(canonical)}`).digest('hex');
  url.search=canonicalQuery+'&X-Amz-Signature='+signature;return url.toString();
}
export class VideoStorage {
  constructor(public store:Store,public media:MediaStore){}
  publicConfig(): Doc | null {const c=this.store.get('video-storage','active');if(!c)return null;const {secretRef,...safe}=c;return {...safe,credentialConfigured:c.mode==='host-reference'||!!secretRef};}
  save(user:Doc,b:Doc) {
    requireThat(this.store.get('user',user.id)?.role==='admin' && this.store.get('user',user.id)?.active,'仅超管可配置素材托管',403);
    fields(b,['origin','bucket','region','accessKeyId','secretAccessKey','enabled']);const u=httpsURL(b.origin);requireThat(u.pathname==='/'&&!u.search,'对象存储填写 HTTPS 根地址');
    requireThat(typeof b.bucket==='string'&&/^[a-z0-9][a-z0-9.-]{1,62}$/.test(b.bucket),'存储桶名称无效');requireThat(typeof b.enabled==='boolean','启停状态无效');
    const old=this.store.get('video-storage','active');let secretRef=old?.secretRef;
    if(b.accessKeyId||b.secretAccessKey){secretRef=id();const secret={accessKeyId:text(b.accessKeyId,'Access Key',256),secretAccessKey:text(b.secretAccessKey,'Secret Key',1024)};writeFileSync(join(this.store.root,'video-secrets',secretRef),JSON.stringify(secret),{flag:'wx',mode:0o600});}
    requireThat(secretRef,'请配置素材托管密钥');const c={id:'active',revision:id(),origin:u.origin,bucket:b.bucket,region:text(b.region,'Region',100),secretRef,enabled:b.enabled,created:now()};
    this.store.tx(()=>{this.store.put('video-storage',c);this.store.put('video-storage-version',{...c,id:c.revision});this.store.audit(user.id,'video.storage.save',c.revision);});return this.publicConfig();
  }
  async prepare(asset:Doc,revision:string,signal:AbortSignal) {
    const c=this.store.get('video-storage-version',revision);requireThat(c?.enabled && this.store.get('video-storage','active')?.revision===revision && this.store.get('video-storage','active')?.enabled,'素材托管配置改变或停用，请重新形成方案',409);
    if(c.mode==='host-reference')return new ProviderReferences(this.store,this.media).prepare(asset,c,signal);
    const m=this.media.get(asset.mediaId);const secret=JSON.parse(readFileSync(join(this.store.root,'video-secrets',c.secretRef),'utf8'));
    const original=createHash('sha256');for await(const bytes of createReadStream(this.media.path(m.id)))original.update(bytes);requireThat(original.digest('hex')===asset.sha256 && m.sha256===asset.sha256,'上传前原件哈希不一致',409);
    const key=`team/shared/${m.sha256}`;const url=signedObjectURL(c,secret,key);const options={redirect:'error' as const,signal:AbortSignal.any([signal,AbortSignal.timeout(120000)])};
    const existing=await fetch(url,{...options,method:'GET'});
    let response=existing,uploaded=false;
    if(existing.status===404){await existing.body?.cancel();const target=signedObjectURL(c,secret,key,'PUT');const put=await fetch(target,{...options,method:'PUT',body:createReadStream(this.media.path(m.id)) as any,duplex:'half','headers':{'Content-Type':m.mime,'Content-Length':String(m.bytes)}} as any);await put.body?.cancel();requireThat(put.ok,'原件上传未确认成功，请核对对象存储',502);uploaded=true;response=await fetch(url,options);}
    requireThat(response.ok&&response.body,'无法回读托管素材',502);const sha=createHash('sha256');let bytes=0;
    for await(const b of response.body as any){bytes+=b.length;requireThat(bytes<=m.bytes,'托管素材大小不一致',422);sha.update(b);}
    requireThat(bytes===m.bytes&&sha.digest('hex')===asset.sha256,'托管素材原字节哈希不一致',422);
    this.store.put('video-upload',{id:id(),mediaId:m.id,sha256:m.sha256,bytes:m.bytes,storageRevision:revision,key,uploaded,readbackVerified:true,created:now()});return url;
  }
}
