import React,{useState} from 'react';
type Item=Record<string,any>;
type Api=(path:string,method?:string,body?:unknown)=>Promise<any>;
export function VideoQuotaCard({quota:q,planId,mine,api,refresh}:{quota:Item,planId:string,mine:boolean,api:Api,refresh:()=>Promise<void>}) {
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const pending=q.requests?.find((r:Item)=>r.state==='pending');
  return <div className="video-quota" aria-label={`${q.sourceId} 提交次数`}>
    <p className="small"><b>{q.sourceId}</b> · 已提交 {q.used} / {q.limit} 次 · 剩余 {q.remaining} 次{q.reserved>0?` · 排队预留 ${q.reserved} 次`:''}</p>
    <p className="small muted">同项目、同镜头共用次数；已发送的失败请求也计数，确认未发送的不计。每一轮均需重新确认。</p>
    {q.historicalUsed>0&&<p className="small muted">已提交次数包含登记的历史任务 {q.historicalUsed} 次。</p>}
    {q.unresolved&&<p role="status">原任务提交结果待核对，暂不能创建新一轮。</p>}
    {q.requests?.map((r:Item)=><p className="small" key={r.id}>追加 {r.requestedAdditional} 次申请：{r.state==='pending'?'等待管理员审批':r.state==='approved'?`已批准 ${r.grantedAdditional} 次`:`已拒绝：${r.decisionReason}`}</p>)}
    {mine&&q.remaining===0&&!pending&&<form onSubmit={e=>{e.preventDefault();if(busy)return;const f=new FormData(e.currentTarget);setBusy(true);setError('');void api(`/pickups/${planId}/quota-requests`,'POST',{sourceId:q.sourceId,requestedAdditional:Number(f.get('additional')),reason:f.get('reason')}).then(()=>refresh()).catch(e=>setError(e.message)).finally(()=>setBusy(false));}}>
      <label>申请追加次数<input name="additional" type="number" min="1" max="100" defaultValue="1" required disabled={busy}/></label>
      <label>申请理由<textarea name="reason" maxLength={2000} required disabled={busy}/></label>
      <button type="submit" disabled={busy}>{busy?'正在提交申请…':'向管理员申请追加次数'}</button>
    </form>}
    {error&&<p role="alert" className="error">{error}</p>}
  </div>;
}
export function VideoQuotaApprovals({requests,disabled,decide}:{requests:Item[],disabled:boolean,decide:(id:string,body:Item)=>void}) {
  return <div className="card admin-card"><h3>视频提交次数申请</h3><p className="small muted">每镜默认 5 次。追加需明确审批，批准不会自动生成视频；所有决定留存。</p>
    {!requests.length&&<p>暂无追加次数申请</p>}
    {requests.map(r=><div className="pickup-job" key={r.id}>
      <b>{r.sourceId} · {r.requester} · {r.state==='pending'?'待审批':r.state==='approved'?'已批准':'已拒绝'}</b>
      <p>申请追加 {r.requestedAdditional} 次：{r.reason}</p><p className="small">当前已提交 {r.quota.used} / {r.quota.limit} 次</p>
      {r.state==='pending'?<form onSubmit={e=>{e.preventDefault();const f=new FormData(e.currentTarget);const button=(e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement;decide(r.id,{decision:button.value,additional:Number(f.get('additional')),reason:f.get('reason')});}}>
        <label>批准追加次数<input name="additional" type="number" min="1" max={r.requestedAdditional} defaultValue={r.requestedAdditional} required disabled={disabled}/></label>
        <label>审批说明（拒绝时必填）<textarea name="reason" maxLength={2000} disabled={disabled}/></label>
        <button type="submit" value="approve" disabled={disabled}>批准追加次数</button><button type="submit" value="reject" disabled={disabled}>拒绝申请</button>
      </form>:<p className="small">{r.state==='approved'?`追加 ${r.grantedAdditional} 次`:'未追加次数'} · {r.decisionReason||'无补充说明'}</p>}
    </div>)}
  </div>;
}
