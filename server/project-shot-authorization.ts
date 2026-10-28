import {readFileSync,writeFileSync,openSync,closeSync,fsyncSync} from 'node:fs';
import {join} from 'node:path';
import {hash,requireThat,type Doc} from './store.ts';

/** One explicit real-project acceptance grant. Prior source history is retained in the grant. */
export function reserveProjectShot(receipts:string,serverId:string,channel:Doc,payload:Doc) {
 const auth=JSON.parse(readFileSync(join(receipts,'authorization.json'),'utf8'));
 requireThat(auth.version===1&&auth.serverId===serverId&&auth.provider==='xiaopei'&&auth.origin===channel.origin&&channel.adapter==='xiaopei'&&auth.channelRevision===channel.id,'Project acceptance server or channel changed');
 requireThat(auth.maxCreates===1&&auth.requestSHA256===hash(JSON.stringify(payload))&&auth.sourceProject==='chongsheng80-v2'&&auth.sourceId==='EP040-015'&&auth.authorization==='one-explicit-4s-pickup-20260924','Request is outside the single authorized project shot');
 requireThat(Array.isArray(auth.priorTaskIds)&&auth.priorTaskIds.includes('task_KKHag9doasigyjBGOrfS6KWfaRIcFzq4'),'Prior source creation history must be retained');
 requireThat(payload.model==='【api调用】wan-3.0-720p'&&Number(payload.seconds)===4&&payload.extra?.resolution==='720p'&&payload.extra?.aspect_ratio==='9:16'&&payload.extra?.generate_audio===true&&payload.extra?.reference_images?.length===3,'Frozen project video specification changed');
 const fd=openSync(join(receipts,'single-create-intent.json'),'wx',0o600);
 try{writeFileSync(fd,JSON.stringify({created:new Date().toISOString(),sourceProject:auth.sourceProject,sourceId:auth.sourceId,priorTaskIds:auth.priorTaskIds,requestSHA256:auth.requestSHA256,maxCreates:1,authorization:auth.authorization}));fsyncSync(fd);}finally{closeSync(fd);}
 const dir=openSync(receipts,'r');try{fsyncSync(dir);}finally{closeSync(dir);}
 writeFileSync(join(receipts,'request.json'),JSON.stringify(payload),{flag:'wx',mode:0o600});
}
