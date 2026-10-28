import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {hash} from '../server/store.ts';import {reserveProjectShot} from '../server/project-shot-authorization.ts';
test('explicit project pickup grant preserves history, pins exact request, consumes once across restarts',()=>{
 const r=mkdtempSync(join(tmpdir(),'project-shot-'));const c={id:'channel-v1',origin:'https://api.aicopy.top',adapter:'xiaopei'};
 const p={model:'【api调用】wan-3.0-720p',prompt:'synthetic fixture',seconds:4,extra:{resolution:'720p',aspect_ratio:'9:16',generate_audio:true,reference_images:[1,2,3].map(i=>({url:`https://example.test/${i}`,role:'reference_image'}))}};
 const a={version:1,serverId:'isolated',provider:'xiaopei',origin:c.origin,channelRevision:c.id,maxCreates:1,requestSHA256:hash(JSON.stringify(p)),sourceProject:'chongsheng80-v2',sourceId:'EP040-015',authorization:'one-explicit-4s-pickup-20260924',priorTaskIds:['task_KKHag9doasigyjBGOrfS6KWfaRIcFzq4']};
 const save=(v:any)=>writeFileSync(join(r,'authorization.json'),JSON.stringify(v));save(a);
 assert.throws(()=>reserveProjectShot(r,'wrong',c,p));assert.throws(()=>reserveProjectShot(r,'isolated',{...c,id:'other'},p));assert.throws(()=>reserveProjectShot(r,'isolated',c,{...p,prompt:'modified'}));
 save({...a,priorTaskIds:[]});assert.throws(()=>reserveProjectShot(r,'isolated',c,p));save(a);reserveProjectShot(r,'isolated',c,p);
 assert.throws(()=>reserveProjectShot(r,'isolated',c,p));assert.equal(JSON.parse(readFileSync(join(r,'single-create-intent.json'),'utf8')).priorTaskIds[0],a.priorTaskIds[0]);
});
