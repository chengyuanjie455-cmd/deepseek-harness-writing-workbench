export function projectHistory(header,events,inheritedEventCount,revision,deriveEventMessage){
 let title='未命名聊天',status='idle';const rows=[];
 for(const e of events){if(e.type==='session/title')title=e.data.title;
 if(e.type==='turn/start')status='running';if(e.type==='turn/end')status=e.data.reason?.kind??'completed';
 const m=deriveEventMessage(e);if(m&&!['system','developer'].includes(m.role))rows.push({seq:e.seq,time:e.time,role:m.role,content:m.content,source:m.source,kind:e.type});
 else if(['command/result','turn/error','compaction/summary','turn/end'].includes(e.type))rows.push({seq:e.seq,time:e.time,kind:e.type,data:e.data});
 }
 const value={id:header.id,title,created:header.createdAt??header.created,updated:events.at(-1)?.time??0,subagent:(header.delegationDepth??0)>0,parent:header.parentSessionId,inheritedEventCount:inheritedEventCount,status,revision:revision,rows};
 return value;
}

export function pageHistory(data,window){
 const {before,after,limit}=window,all=data.rows;
 const filtered=all.filter(r=>(before===undefined||r.seq<before)&&(after===undefined||r.seq>after));
 const rows=after===undefined?filtered.slice(-limit):filtered.slice(0,limit);
 return {...data,rows,paged:true,total:all.length,hasOlder:rows.length>0&&all.some(r=>r.seq<rows[0].seq),hasNewer:rows.length>0&&all.some(r=>r.seq>rows.at(-1).seq),latestSeq:all.at(-1)?.seq??-1};
}
