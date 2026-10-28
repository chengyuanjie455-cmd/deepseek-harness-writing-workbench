import {readFileSync,writeFileSync,openSync,closeSync,fsyncSync} from 'node:fs';
import {join} from 'node:path';
import {hash,requireThat,type Doc} from './store.ts';

/** Additional acceptance-only gate, shared by all rounds and persisted across restarts. */
export function reserveSingleShot(receipts:string,channel:Doc,payload:Doc) {
 const auth=JSON.parse(readFileSync(join(receipts,'authorization.json'),'utf8'));
 requireThat(auth.provider==='xiaopei'&&auth.origin===channel.origin&&channel.adapter==='xiaopei'&&auth.maxCreates===1&&auth.requestSHA256===hash(JSON.stringify(payload)),'Live request does not match the frozen one-shot authorization');
 requireThat(payload.model===auth.model&&Number(payload.seconds)===4&&payload.extra?.resolution==='720p','Live specification changed');
 const fd=openSync(join(receipts,'single-create-intent.json'),'wx',0o600);
 try{writeFileSync(fd,JSON.stringify({created:new Date().toISOString(),sourceId:auth.sourceId,requestSHA256:auth.requestSHA256,maxCreates:1}));fsyncSync(fd);}finally{closeSync(fd);}
 const dir=openSync(receipts,'r');try{fsyncSync(dir);}finally{closeSync(dir);}
 writeFileSync(join(receipts,'request.json'),JSON.stringify(payload),{flag:'wx',mode:0o600});
}
