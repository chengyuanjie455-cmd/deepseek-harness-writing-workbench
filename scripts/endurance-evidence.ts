import assert from 'node:assert/strict';
type Row=Record<string,any>;
export function roundSubmissionState(rows:Row[],session:string,marker:string){
 const matches=rows.filter(row=>row.session===session&&typeof row.prompt==='string'&&row.prompt.split(/\s+/)[0]===marker);
 if(matches.length>1)return {session,completed:false,failure:'duplicate user submissions',count:matches.length};
 const row=matches[0];
 if(!row)return {session,completed:false,state:'missing',count:0};
 return {session,completed:row.state==='completed',count:1,id:row.id,state:row.state,turn:row.turn,
  ...(['failed','cancelled','interrupted'].includes(row.state)?{failure:'terminal '+row.state}:{})};
}
export function assertPartialReconnect(before:Row,baseline:Row){
 const attempt=baseline?.activeAttempt;
 assert(before.fixtureFrameSeen&&before.nextIndex>0,'no observed content before disconnect');
 assert(attempt,'active reply missing after reconnect');
 assert.equal(attempt.attemptId,before.attemptId,'reconnect changed assistant attempt');
 assert(attempt.nextIndex>=before.nextIndex,'reconnect lost assistant chunks');
 assert(Array.isArray(attempt.stream)&&attempt.stream.length>0,'partial reply missing from reconnect snapshot');
 return {attemptId:attempt.attemptId,nextIndex:attempt.nextIndex,partialChunks:attempt.stream.length,revision:baseline.revision};
}
