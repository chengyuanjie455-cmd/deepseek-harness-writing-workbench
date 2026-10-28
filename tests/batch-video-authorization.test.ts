import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {hash} from '../server/store.ts';
import {reserveBatchVideo} from '../server/batch-video-authorization.ts';
test('frozen eight-source gate allows each exact request once and refuses changed, old or ninth payloads',()=>{
 const root=mkdtempSync(join(tmpdir(),'stress8-guard-'));
 const c={id:'revision',origin:'https://api.aicopy.top',adapter:'xiaopei'};
 const payloads=Array.from({length:8},(_,i)=>({model:'【api调用】wan-3.0-720p',prompt:'synthetic '+i,seconds:4,extra:{resolution:'720p',aspect_ratio:'16:9',generate_audio:true}}));
 const auth={serverId:'isolated',channelRevision:c.id,provider:'xiaopei',origin:c.origin,maxCreates:8,entries:payloads.map((p,i)=>({sourceId:`STRESS8-20260924-S0${i+1}`,requestSHA256:hash(JSON.stringify(p)),maxCreates:1}))};
 writeFileSync(join(root,'authorization.json'),JSON.stringify(auth));
 assert.throws(()=>reserveBatchVideo(root,'wrong',c,payloads[0]));
 assert.throws(()=>reserveBatchVideo(root,'isolated',{...c,id:'changed'},payloads[0]));
 assert.throws(()=>reserveBatchVideo(root,'isolated',c,{...payloads[0],prompt:'old shot'}));
 for(const p of payloads){reserveBatchVideo(root,'isolated',c,p);assert.throws(()=>reserveBatchVideo(root,'isolated',c,p));}
 assert.equal(readdirSync(root).filter(f=>f.endsWith('-create-intent.json')).length,8);
});
