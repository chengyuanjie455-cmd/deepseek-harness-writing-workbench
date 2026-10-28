import {test} from 'node:test';
import assert from 'node:assert/strict';
import {enduranceOptions} from '../scripts/endurance-options.ts';
test('native endurance options distinguish a bounded recovery gate from duration acceptance',()=>{
 const baseline=enduranceOptions({ENDURANCE_REPORT:'/tmp/synthetic-endurance.json'});assert.equal(baseline.mode,'duration');assert.equal(baseline.durationMs,24*3600000);assert.equal(baseline.intervalMs,300000);
 const gate=enduranceOptions({ENDURANCE_REPORT:'/tmp/synthetic-endurance.json',ENDURANCE_ROUNDS:'4',ENDURANCE_INTERVAL_MS:'1000',ENDURANCE_HOURS:'0.1'});assert.equal(gate.mode,'bounded_rounds');assert.equal(gate.rounds,4);assert.equal(gate.durationMs,360000);
});
test('invalid endurance settings fail before creating accounts, services or receipts',()=>{
 for(const patch of [{ENDURANCE_REPORT:undefined},{ENDURANCE_REPORT:'relative.json'},{ENDURANCE_HOURS:'NaN'},{ENDURANCE_HOURS:'0'},{ENDURANCE_HOURS:'Infinity'},{ENDURANCE_HOURS:'1e308'},{ENDURANCE_INTERVAL_MS:'0'},{ENDURANCE_INTERVAL_MS:'1000.5'},{ENDURANCE_ROUNDS:'3'},{ENDURANCE_ROUNDS:'Infinity'}])assert.throws(()=>enduranceOptions({ENDURANCE_REPORT:'/tmp/synthetic-endurance.json',...patch}));
});
