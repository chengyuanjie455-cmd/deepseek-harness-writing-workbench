import {test} from 'node:test';
import assert from 'node:assert/strict';
import {roundSubmissionState,assertPartialReconnect} from '../scripts/endurance-evidence.ts';
test('round gate requires the exact current submission and rejects terminal failures or duplicates',()=>{
 const old={session:'s',id:'old',prompt:'round-1 text',state:'completed'},current={session:'s',id:'new',prompt:'round-2 text',state:'completed'};
 assert.equal(roundSubmissionState([old],'s','round-2').completed,false);
 assert.equal(roundSubmissionState([old,current],'s','round-2').completed,true);
 assert.equal(roundSubmissionState([old,{...current,state:'failed'}],'s','round-2').failure,'terminal failed');
 assert.equal(roundSubmissionState([current,{...current,id:'other'}],'s','round-2').failure,'duplicate user submissions');
 assert.equal(roundSubmissionState([{...current,session:'foreign'}],'s','round-2').completed,false);
});
test('reconnect gate requires the same active attempt with observed partial content',()=>{
 const before={fixtureFrameSeen:true,nextIndex:2,attemptId:'same'},baseline={revision:3,activeAttempt:{attemptId:'same',nextIndex:2,stream:[{text:'partial'}]}};
 assert.equal(assertPartialReconnect(before,baseline).partialChunks,1);
 for(const changed of [{},{...baseline,activeAttempt:{...baseline.activeAttempt,attemptId:'other'}},{...baseline,activeAttempt:{...baseline.activeAttempt,nextIndex:1}},{...baseline,activeAttempt:{...baseline.activeAttempt,stream:[]}}])assert.throws(()=>assertPartialReconnect(before,changed));
 assert.throws(()=>assertPartialReconnect({...before,nextIndex:0},baseline));
});
