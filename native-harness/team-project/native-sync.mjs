// Presentation only. Native Harness owns the journal, cursors, repair and retries.
export function createNativeSyncStatus({emit,now=Date.now}) {
 const rows=new Map();let selected=null,serial=0;
 const publish=()=>{try{emit({session:selected,...(rows.get(selected)?.state??{phase:'waiting',observedAt:0})});}catch{}};
 return {
  begin(session){if(typeof session!=='string'||!/^session-[a-zA-Z0-9-]{1,160}$/.test(session))return;
   const token={session,serial:++serial};rows.set(session,{token,state:{phase:'loading',observedAt:now()}});if(session===selected)publish();return token;},
  update(token,phase){if(!token||rows.get(token.session)?.token!==token||!['live','reconnecting','error'].includes(phase))return;
   const row=rows.get(token.session);row.state={phase,observedAt:now(),lastUpdateAt:phase==='live'?now():row.state.lastUpdateAt};if(token.session===selected)publish();},
  end(token){if(token&&rows.get(token.session)?.token===token){rows.delete(token.session);if(token.session===selected)publish();}},
  select(session){selected=typeof session==='string'?session:null;publish();},
  snapshot:publish
 };
}
