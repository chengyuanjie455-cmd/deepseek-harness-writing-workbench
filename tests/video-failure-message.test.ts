import {test} from 'node:test';import assert from 'node:assert/strict';import {Pickups} from '../server/pickups.ts';
test('member failure explains reference timeout without leaking provider URL or encouraging duplicate creation',()=>{
 const raw={id:'job',state:'failed',createAttempts:1,error:'供应商任务失败；本轮不重新创建',payload:{secret:'private'},receipt:{private:true},queryReceipt:{error:{code:'media_fetch_timeout',message:'retry https://signed.example/?token=secret'}},channelRevision:'private',modelCapabilityHash:'private'};
 const view=Pickups.prototype.publicJob.call({} as any,raw);assert.equal(view.providerErrorCode,'media_fetch_timeout');assert.match(view.error,/参考图片连接超时/);assert.match(view.error,/不会重新创建/);assert(!JSON.stringify(view).includes('secret'));assert(!JSON.stringify(view).includes('https://'));assert.equal(raw.error,'供应商任务失败；本轮不重新创建');assert.equal(view.createAttempts,1);
});
