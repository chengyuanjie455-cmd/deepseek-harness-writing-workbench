// A read model of human submissions. Tool calls, forks' inherited prefixes and
// scheduled/agent messages never become independent member tasks.
export function summarizeSubmissions(header, events, inherited = 0) {
 if ((header.delegationDepth ?? 0) > 0) return [];
 const items = new Map(); let turn = 0, title = '';
 const text = content => (content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');
 const add = (m, e, state) => {
  if (m.source?.kind !== 'user' || !m.id || e.seq < inherited) return;
  const old = items.get(m.id);
  items.set(m.id, {...old, id:m.id, session:header.id, prompt:text(m.content).slice(0,16000) || '提交附件', attachments:(m.content??[]).filter(c=>c.type!=='text').length, created:old?.created??new Date(e.time).toISOString(), state, turn:state==='running'?turn:old?.turn});
 };
 for (const e of events) {
  if (e.type==='session/title') title=e.data.title;
  if (e.type==='turn/start') turn=e.data.turn;
  if (e.type==='agent/inbox/spliced') for(const m of e.data.inserted??[]) if(!items.has(m.id)) add(m,e,'queued');
  if (e.type==='user/message' && e.surfaceOp !== 'replace') add(e.data,e,'running');
  if (e.type==='turn/end') for(const item of items.values()) if(item.turn===e.data.turn && item.state==='running') item.state=({completed:'completed',cancelled:'cancelled',interrupted:'interrupted',failed:'failed',error:'failed'})[e.data.reason?.kind]??'interrupted';
 }
 return [...items.values()].map(i=>({...i,title:title||'项目聊天'}));
}
