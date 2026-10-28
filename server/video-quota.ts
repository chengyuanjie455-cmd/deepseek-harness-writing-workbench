import {Store,requireThat,hash,id,now,type Doc} from './store.ts';
import {fields,text} from './video-catalog.ts';

export const VIDEO_DEFAULT_LIMIT=5;
const heldStates=['queued','preparing'];
export class VideoQuota {
  constructor(public store:Store) {}
  project(job:Doc) {return job.project??this.store.get('pickup',job.planId)?.project??'shared';}
  key(project:string,sourceId:string) {return hash(JSON.stringify([project,sourceId]));}
  status(project:string,sourceId:string,owner?:string) {
    const jobs=this.store.all('video-job').filter(j=>this.project(j)===project&&j.sourceId===sourceId);
    const requests=this.store.all('video-quota-request').filter(r=>r.project===project&&r.sourceId===sourceId);
    const known=new Set(jobs.map(j=>j.remoteTaskId).filter(Boolean));
    const inherited=(this.store.get('video-source-history',this.key(project,sourceId))?.taskIds??[]) as string[];
    const historicalUsed=new Set(inherited.filter(t=>!known.has(t))).size;
    const used=historicalUsed+jobs.filter(j=>j.createAttempts>0&&j.submissionDisposition!=='not_sent').length;
    const reserved=jobs.filter(j=>!j.createAttempts&&heldStates.includes(j.state)).length;
    const limit=VIDEO_DEFAULT_LIMIT+requests.filter(r=>r.state==='approved').reduce((n,r)=>n+r.grantedAdditional,0);
    return {project,sourceId,baseLimit:VIDEO_DEFAULT_LIMIT,limit,used,historicalUsed,reserved,remaining:Math.max(0,limit-used-reserved),
      unresolved:jobs.some(j=>['submitting','submission_unknown'].includes(j.state)),
      inFlight:jobs.some(j=>['queued','preparing','submitting','submission_unknown','running','downloading','checking'].includes(j.state)),
      requests:owner?requests.filter(r=>r.owner===owner):[]};
  }
  assertAvailable(project:string,sourceId:string) {
    const q=this.status(project,sourceId);
    requireThat(q.remaining>0,`镜头 ${sourceId} 已用完 ${q.limit} 次提交额度，请向管理员申请追加次数`,409);
  }
  assertReservation(job:Doc) {
    const q=this.status(this.project(job),job.sourceId);
    requireThat(q.used+q.reserved<=q.limit,`镜头 ${job.sourceId} 提交额度不足，请向管理员申请`,409);
  }
  request(user:Doc,plan:Doc,b:Doc) {
    fields(b,['sourceId','requestedAdditional','reason']);
    requireThat(this.store.get('user',user.id)?.active&&plan.owner===user.id,'只能为自己的补抽方案申请额度',403);
    requireThat(plan.shots?.some((s:Doc)=>s.source.id===b.sourceId),'镜头不在本方案中',404);
    requireThat(Number.isSafeInteger(b.requestedAdditional)&&b.requestedAdditional>=1&&b.requestedAdditional<=100,'申请次数须为1至100的整数');
    const reason=text(b.reason,'申请理由',2000),project=plan.project??'shared';
    return this.store.tx(()=>{
      const q=this.status(project,b.sourceId,user.id);
      const pending=q.requests.find(r=>r.state==='pending');if(pending)return pending;
      requireThat(q.remaining===0,'仍有可用次数，无需申请追加',409);
      const r={id:id(),owner:user.id,project,sourceId:b.sourceId,planId:plan.id,requestedAdditional:b.requestedAdditional,reason,state:'pending',created:now()};
      this.store.put('video-quota-request',r);this.store.audit(user.id,'video.quota.request',r.id,{project,sourceId:b.sourceId,requestedAdditional:r.requestedAdditional});
      this.store.event(user.id,'video.quota.updated',{sourceId:b.sourceId});return r;
    });
  }
  admin(user:Doc) {const u=this.store.get('user',user.id);requireThat(u?.active&&u.role==='admin','仅超级管理员可审批提交次数',403);}
  list(user:Doc) {this.admin(user);return this.store.all('video-quota-request').map(r=>({...r,requester:this.store.get('user',r.owner)?.name??'成员',quota:this.status(r.project,r.sourceId)}));}
  decide(user:Doc,requestId:string,b:Doc) {
    this.admin(user);fields(b,['decision','additional','reason']);requireThat(['approve','reject'].includes(b.decision),'审批结果无效');
    const note=typeof b.reason==='string'?b.reason.trim():'';requireThat(note.length<=2000&&(b.decision==='approve'||note.length>0),'拒绝时需填写原因，最多2000字');
    return this.store.tx(()=>{
      const r=this.store.get('video-quota-request',requestId);requireThat(r,'申请不存在',404);
      const amount=b.decision==='approve'?b.additional:0;
      requireThat(b.decision==='reject'||Number.isSafeInteger(amount)&&amount>=1&&amount<=r.requestedAdditional,'批准次数须在申请范围内');
      const state=b.decision==='approve'?'approved':'rejected';
      if(r.state!=='pending'){requireThat(r.state===state&&r.grantedAdditional===amount&&r.decisionReason===note,'申请已处理，不能重复修改或追加',409);return r;}
      const saved={...r,state,grantedAdditional:amount,decisionReason:note,decidedBy:user.id,decidedAt:now()};
      this.store.put('video-quota-request',saved);this.store.audit(user.id,'video.quota.'+state,r.id,{project:r.project,sourceId:r.sourceId,additional:amount});this.store.event(r.owner,'video.quota.updated',{sourceId:r.sourceId});return saved;
    });
  }
}
