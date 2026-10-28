import {test} from 'node:test';import assert from 'node:assert/strict';
import {removeNativeContainer} from '../server/native-container.ts';
const name='team-dsh-0123456789abcdef01234567';
test('native replacement waits for Docker Desktop to release the old name; only one removal is sent',async()=>{
 const calls:string[][]=[];let probes=0;await removeNativeContainer(name,async args=>{calls.push(args);if(args[0]==='rm')throw Error('removal already in progress');return {stdout:++probes<3?name+'\n':''};},1000);
 assert.equal(calls.filter(a=>a[0]==='rm').length,1);assert.equal(probes,3);
});
test('native replacement refuses to continue when the old container remains or the daemon cannot be checked',async()=>{
 await assert.rejects(removeNativeContainer(name,async args=>{if(args[0]==='rm')throw Error('denied');return {stdout:name};},0),/旧容器尚未清理/);
 await assert.rejects(removeNativeContainer(name,async()=>{throw Error('daemon unavailable');},0),/daemon unavailable/);
});
