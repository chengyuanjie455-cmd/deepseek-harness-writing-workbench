import {readFileSync,writeFileSync,openSync,closeSync,fsyncSync} from 'node:fs';
import {join} from 'node:path';
import {hash,requireThat,type Doc} from './store.ts';

/** Acceptance-only, immutable eight-source authorization. A spent slot is never released. */
export function reserveBatchVideo(receipts:string,serverId:string,channel:Doc,payload:Doc) {
 const auth=JSON.parse(readFileSync(join(receipts,'authorization.json'),'utf8'));
 requireThat(auth.serverId===serverId&&auth.provider==='xiaopei'&&auth.origin===channel.origin&&channel.adapter==='xiaopei'&&auth.channelRevision===channel.id,'Batch server or channel changed');
 requireThat(auth.maxCreates===8&&Array.isArray(auth.entries)&&auth.entries.length===8&&new Set(auth.entries.map((e:Doc)=>e.sourceId)).size===8&&new Set(auth.entries.map((e:Doc)=>e.requestSHA256)).size===8,'Batch must contain exactly eight distinct frozen sources');
 const requestSHA256=hash(JSON.stringify(payload));const entry=auth.entries.find((e:Doc)=>e.requestSHA256===requestSHA256);
 requireThat(entry&&/^STRESS8-20260924-S0[1-8]$/.test(entry.sourceId)&&entry.maxCreates===1,'Request is outside the authorized sources');
 requireThat(payload.model==='【api调用】wan-3.0-720p'&&Number(payload.seconds)===4&&payload.extra?.resolution==='720p'&&payload.extra?.aspect_ratio==='16:9'&&payload.extra?.generate_audio===true&&!payload.extra?.reference_images,'Frozen video specification changed');
 const fd=openSync(join(receipts,entry.sourceId+'-create-intent.json'),'wx',0o600);
 try{writeFileSync(fd,JSON.stringify({created:new Date().toISOString(),...entry}));fsyncSync(fd);}finally{closeSync(fd);}
 const dir=openSync(receipts,'r');try{fsyncSync(dir);}finally{closeSync(dir);}
 writeFileSync(join(receipts,entry.sourceId+'-request.json'),JSON.stringify(payload),{flag:'wx',mode:0o600});
 return entry;
}
