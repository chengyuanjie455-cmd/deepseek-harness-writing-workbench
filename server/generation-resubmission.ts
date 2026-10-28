import type {Doc} from './store.ts';

export const RESUBMIT_WAIT_MS=10*60*1000;
/** Eligibility for an explicit member-requested repeat, never a timer-driven POST. */
export function resubmissionStatus(plan:Doc,time=Date.now()){
 const jobs:Doc[]=plan.jobs??[];
 if(!jobs.length)return {eligible:false,reason:'尚未提交的方案可直接生成'};
 if(jobs.some(j=>j.mediaId||j.remoteCompletedAt||['ready','adopted','downloading','download_failed','checking'].includes(j.state)))return {eligible:false,reason:'原任务已生成，请查看原片或恢复下载；需要新版本可直接提出修改'};
 if(jobs.some(j=>j.state==='cancelled'))return {eligible:false,reason:'该任务已取消，可直接发起新的生成'};
 const starts=jobs.map(j=>Date.parse(j.created??plan.confirmedAt));
 if(starts.some(t=>!Number.isFinite(t)))return {eligible:false,reason:'提交时间缺失，请先核对任务记录'};
 const availableAt=new Date(Math.max(...starts)+RESUBMIT_WAIT_MS).toISOString();
 return {eligible:time>=Date.parse(availableAt),availableAt,reason:time>=Date.parse(availableAt)?'成员可以再次提交，原任务继续跟踪':'同一任务满 10 分钟仍未生成时可再次提交；换型、修正和其他任务可立即并发提交'};
}
