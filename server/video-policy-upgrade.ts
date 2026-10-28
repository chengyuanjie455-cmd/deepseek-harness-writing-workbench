import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {Store,requireThat,hash,now,type Doc} from './store.ts';
import {VideoQuota} from './video-quota.ts';

/** Explicit deployment migration, not a general way to release unknown submissions. */
export function upgradeVideoPolicy(store:Store,serverId:string,policy:Doc,receipts:string) {
  requireThat(policy.version===1&&policy.serverId===serverId&&policy.defaultLimit===5&&policy.authorization==='user-20260924-five-submissions','视频提交策略未获核验');
  if(store.get('video-policy-migration','quota5-20260924'))return;
  const auth=JSON.parse(readFileSync(join(receipts,'authorization.json'),'utf8'));
  const rawIntent=readFileSync(join(receipts,'single-create-intent.json'));
  const intent=JSON.parse(rawIntent.toString('utf8'));
  const receipt=JSON.parse(readFileSync(join(receipts,'create-response.json'),'utf8'));const remote=JSON.parse(receipt.raw);
  requireThat(auth.serverId===serverId&&auth.sourceId===policy.sourceId&&auth.sourceProject===policy.sourceProject&&Array.isArray(auth.priorTaskIds),'历史镜头授权不匹配');
  requireThat(hash(rawIntent)===policy.intentSHA256&&intent.requestSHA256===auth.requestSHA256&&intent.sourceId===auth.sourceId&&receipt.method==='POST'&&receipt.httpStatus===200,'原单次创建凭据未通过核验');
  const first=store.all('video-job').find(j=>j.remoteTaskId===remote.id&&j.sourceId===auth.sourceId&&j.requestHash===intent.requestSHA256);
  requireThat(first&&first.state==='failed','原任务终态尚未核对，不迁移');
  const blocked=store.get('video-job',policy.notSentJobId);
  requireThat(blocked&&blocked.state==='submission_unknown'&&!blocked.remoteTaskId&&!blocked.receipt&&blocked.createAttempts===1&&blocked.sourceId===auth.sourceId&&blocked.requestHash===intent.requestSHA256&&Date.parse(blocked.submitIntentAt)>Date.parse(receipt.time),'待修复记录与提交前拦截证据不符');
  const quota=new VideoQuota(store),project=quota.project(blocked);
  requireThat(project===policy.project&&quota.project(first)===project,'历史项目不匹配');
  store.tx(()=>{
    const history={id:quota.key(project,auth.sourceId),project,sourceId:auth.sourceId,taskIds:[...new Set(auth.priorTaskIds)],evidence:'legacy project authorization; history retained',created:now()};
    requireThat(!store.get('video-source-history',history.id),'已存在镜头历史，需先核对');store.put('video-source-history',history);
    store.put('video-job',{...blocked,state:'blocked',createAttempts:0,submissionDisposition:'not_sent',nextPoll:null,finished:now(),updated:now(),error:'旧版单次验收保护在请求发出前阻止了提交；本轮未发送、不占次数。可重新准备方案并确认。',
      priorSubmissionRecord:{state:blocked.state,createAttempts:blocked.createAttempts,error:blocked.error,submitIntentAt:blocked.submitIntentAt},
      notSentEvidence:{reason:'existing exclusive intent rejected before provider fetch',legacyIntentSHA256:policy.intentSHA256,originalJobId:first.id,reconciledAt:now()}});
    store.put('video-policy-migration',{id:'quota5-20260924',policy,created:now()});
    store.audit('system:authorized-quota5','video.quota.migrate',blocked.id,{project,sourceId:auth.sourceId,oldState:blocked.state,newState:'blocked',oldAttempts:1,newAttempts:0,historyCount:history.taskIds.length});
    store.event(blocked.owner,'pickup.updated',{id:blocked.planId,jobId:blocked.id,state:'blocked'});
  });
}
