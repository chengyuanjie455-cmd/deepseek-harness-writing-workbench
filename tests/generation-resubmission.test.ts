import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resubmissionStatus,RESUBMIT_WAIT_MS} from '../server/generation-resubmission.ts';
test('ten-minute boundary uses original submission time, with no automatic action',()=>{
 const start=Date.parse('2026-09-29T00:00:00Z'),p={jobs:[{state:'running',created:new Date(start).toISOString()}]};
 assert.equal(resubmissionStatus(p,start+RESUBMIT_WAIT_MS-1).eligible,false);
 assert.equal(resubmissionStatus(p,start+RESUBMIT_WAIT_MS).eligible,true);
 for(const state of ['queued','preparing','submitting','submission_unknown','running','failed'])assert.equal(resubmissionStatus({jobs:[{...p.jobs[0],state}]},start+RESUBMIT_WAIT_MS).eligible,true);
 for(const state of ['ready','adopted','checking','downloading','download_failed','cancelled'])assert.equal(resubmissionStatus({jobs:[{...p.jobs[0],state}]},start+RESUBMIT_WAIT_MS).eligible,false);
 assert.equal(resubmissionStatus({jobs:[]}).eligible,false);assert.equal(resubmissionStatus({jobs:[{state:'running',created:'invalid'}]}).eligible,false);
});
