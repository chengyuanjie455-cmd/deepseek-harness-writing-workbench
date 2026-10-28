import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,writeFileSync,readFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {Store,hash} from '../server/store.ts';import {VideoQuota} from '../server/video-quota.ts';import {upgradeVideoPolicy} from '../server/video-policy-upgrade.ts';
test('project scope and recorded external history count once without exposing other member requests',()=>{
 const s=new Store(mkdtempSync(join(tmpdir(),'video-quota-')));try{const q=new VideoQuota(s);
 s.put('video-source-history',{id:q.key('one','S1'),taskIds:['old','old','same']});s.put('video-job',{id:'known',project:'one',sourceId:'S1',remoteTaskId:'same',createAttempts:1,state:'failed'});s.put('video-job',{id:'unknown',project:'one',sourceId:'S1',createAttempts:1,state:'submission_unknown'});s.put('video-job',{id:'blocked',project:'one',sourceId:'S1',createAttempts:0,state:'blocked',submissionDisposition:'not_sent'});s.put('video-quota-request',{id:'private',owner:'other',project:'one',sourceId:'S1',state:'pending',reason:'private reason'});
 const a=q.status('one','S1','me');assert.equal(a.used,3);assert.equal(a.historicalUsed,1);assert.equal(a.remaining,2);assert.equal(a.requests.length,0);assert.equal(q.status('two','S1').used,0);
 }finally{s.close();}
});
test('legacy migration corrects only the proven pre-send record and retains first job and history',()=>{
 const root=mkdtempSync(join(tmpdir(),'quota-migration-')),s=new Store(join(root,'data'));try{
 const requestSHA256='frozen-payload',auth={serverId:'server',sourceId:'EP040-015',sourceProject:'chongsheng80-v2',requestSHA256,priorTaskIds:['external-old']};
 const intent={sourceId:auth.sourceId,requestSHA256};writeFileSync(join(root,'authorization.json'),JSON.stringify(auth));writeFileSync(join(root,'single-create-intent.json'),JSON.stringify(intent));writeFileSync(join(root,'create-response.json'),JSON.stringify({method:'POST',httpStatus:200,time:'2026-09-24T05:57:24.580Z',raw:JSON.stringify({id:'remote-original'})}));
 const first={id:'first',project:'shared',sourceId:auth.sourceId,remoteTaskId:'remote-original',requestHash:requestSHA256,state:'failed',createAttempts:1};s.put('video-job',first);s.put('video-job',{id:'second',project:'shared',sourceId:auth.sourceId,planId:'plan',owner:'member',requestHash:requestSHA256,state:'submission_unknown',createAttempts:1,submitIntentAt:'2026-09-24T07:18:12.745Z'});
 const policy={version:1,serverId:'server',defaultLimit:5,authorization:'user-20260924-five-submissions',sourceId:auth.sourceId,sourceProject:auth.sourceProject,project:'shared',intentSHA256:hash(readFileSync(join(root,'single-create-intent.json'))),notSentJobId:'second'};
 assert.throws(()=>upgradeVideoPolicy(s,'wrong',policy,root));assert.throws(()=>upgradeVideoPolicy(s,'server',{...policy,notSentJobId:'first'},root));assert.equal(s.get('video-job','second')!.state,'submission_unknown');
 upgradeVideoPolicy(s,'server',policy,root);upgradeVideoPolicy(s,'server',policy,root);assert.deepEqual(s.get('video-job','first'),first);assert.equal(s.get('video-job','second')!.state,'blocked');assert.equal(s.get('video-job','second')!.createAttempts,0);assert.equal(s.get('video-job','second')!.priorSubmissionRecord.createAttempts,1);const q=new VideoQuota(s).status('shared',auth.sourceId);assert.equal(q.used,2);assert.equal(q.remaining,3);
 }finally{s.close();}
});
