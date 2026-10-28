import {test} from 'node:test';import assert from 'node:assert/strict';
import {assertNativeBackupStopped} from '../server/native-backup-guard.ts';
const data='/fixture/workbench-data',other={Id:'container-other',Mounts:[{Source:'/another-host/native-harness/member'}]},own={Id:'container-own',Mounts:[{Source:data+'/native-harness/member/state'}]};
function sequence(steps:{args:string[];result:string|Error}[]){let i=0;return {run:(args:string[])=>{const step=steps[i++];assert(step,'unexpected Docker call');assert.deepEqual(args,step.args);if(step.result instanceof Error)throw step.result;return step.result;},done:()=>assert.equal(i,steps.length)};}
test('an unrelated container disappearing during inspect is re-listed and verified without aborting an otherwise isolated backup',()=>{
 const s=sequence([{args:['ps','--no-trunc','-q'],result:'container-gone\ncontainer-other'},{args:['inspect','container-gone','container-other'],result:Error('No such object: container-gone')},{args:['ps','--no-trunc','-q'],result:'container-other'},{args:['inspect','container-other'],result:JSON.stringify([other])},{args:['ps','--no-trunc','-q'],result:'container-other'}]);assertNativeBackupStopped(data,s.run,true);s.done();
});
test('the workbench native container still blocks backup after an unrelated one disappears',()=>{
 const s=sequence([{args:['ps','--no-trunc','-q'],result:'container-gone\ncontainer-own'},{args:['inspect','container-gone','container-own'],result:Error('No such object')},{args:['ps','--no-trunc','-q'],result:'container-own'},{args:['inspect','container-own'],result:JSON.stringify([own])}]);assert.throws(()=>assertNativeBackupStopped(data,s.run,true),/原生环境仍在运行/);s.done();
});
test('unchanged failed, partial or continuously changing Docker inventory never counts as a stopped native environment',()=>{
 const fail=sequence([{args:['ps','--no-trunc','-q'],result:'container-own'},{args:['inspect','container-own'],result:Error('permission denied')},{args:['ps','--no-trunc','-q'],result:'container-own'}]);assert.throws(()=>assertNativeBackupStopped(data,fail.run,true),/无法核对/);fail.done();
 const partial=sequence([{args:['ps','--no-trunc','-q'],result:'container-own'},{args:['inspect','container-own'],result:'[]'}]);assert.throws(()=>assertNativeBackupStopped(data,partial.run,true),/检查不完整/);partial.done();
 let count=0;assert.throws(()=>assertNativeBackupStopped(data,args=>args[0]==='ps'?'changing-'+count++:JSON.stringify([{Id:args[1],Mounts:[]}]),true),/持续变化/);
 assert.throws(()=>assertNativeBackupStopped(data,()=>{throw Error('daemon unavailable');},true),/无法检查 Docker/);assert.doesNotThrow(()=>assertNativeBackupStopped(data,()=>{throw Error('daemon unavailable');},false));
});
