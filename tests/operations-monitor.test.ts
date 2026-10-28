import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {operationalHealth} from '../server/operational-health.ts';
import {OperationsMonitor} from '../server/operational-health.ts';
import {Platform} from '../server/app.ts';
import {operations} from '../server/operations.ts';
test('independent backup and stale guardian cannot appear healthy from a primary backup alone',()=>{
 const root=mkdtempSync(join(tmpdir(),'operations-monitor-')),clock=Date.now(),store={root,all:()=>[]} as any,sample={diskFreeBytes:40*1024**3,memoryFreeBytes:8*1024**3,memoryTotalBytes:16*1024**3};
 try{writeFileSync(join(root,'backup-status.json'),JSON.stringify({lastSuccess:{at:new Date(clock).toISOString()},independentRequired:true}));writeFileSync(join(root,'host-status.json'),JSON.stringify({state:'healthy',checkedAt:new Date(clock-100000).toISOString()}));let h=operationalHealth(store,clock,sample);assert(h.alerts.some(a=>a.id==='backup-independent'));assert(h.alerts.some(a=>a.id==='resident-stale'));assert(!h.alerts.some(a=>a.id==='backup-stale'));
 writeFileSync(join(root,'backup-status.json'),JSON.stringify({lastSuccess:{at:new Date(clock).toISOString()},independentRequired:true,independent:{at:new Date(clock).toISOString(),status:'verified'}}));writeFileSync(join(root,'host-status.json'),JSON.stringify({state:'healthy',checkedAt:new Date(clock).toISOString()}));h=operationalHealth(store,clock,sample);assert(!h.alerts.some(a=>a.id.startsWith('backup-')||a.id.startsWith('resident')));
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('invalid or future backup and resident timestamps cannot pass freshness checks',()=>{
 const root=mkdtempSync(join(tmpdir(),'operations-time-')),clock=Date.now(),store={root,all:()=>[]} as any,sample={diskFreeBytes:40*1024**3,memoryFreeBytes:8*1024**3,memoryTotalBytes:16*1024**3};
 try{for(const value of ['invalid',new Date(clock+10*60000).toISOString()]){
  writeFileSync(join(root,'backup-status.json'),JSON.stringify({lastSuccess:{at:value},independentRequired:true,independent:{at:value,status:'verified'}}));
  writeFileSync(join(root,'host-status.json'),JSON.stringify({state:'healthy',checkedAt:value}));
  const h=operationalHealth(store,clock,sample);for(const key of ['backup-stale','backup-independent','resident-stale'])assert(h.alerts.some(a=>a.id===key));
 }}finally{rmSync(root,{recursive:true,force:true});}
});
test('an inaccessible resource path is explicit unknown state, never a fresh healthy sample',()=>{
 const root=join(tmpdir(),'operations-absent-'+Date.now()+'-'+Math.random()),health=operationalHealth({root,all:()=>[]} as any);
 assert.equal(health.resource.unavailable,true);assert(health.alerts.some(a=>a.id==='resource-probe'));
});
test('unchanged alerts still advance the independent collection heartbeat without duplicate notifications',async()=>{
 const root=mkdtempSync(join(tmpdir(),'operations-heartbeat-')),app=new Platform({dataDir:root});let clock=Date.now();const monitor=new OperationsMonitor(app.store,operationalHealth,()=>clock);
 try{monitor.tick();const first=app.store.get('operations-monitor','status')!,audits=app.store.db.prepare('SELECT count(*) n FROM audit').get() as any;clock+=30000;monitor.tick();const next=app.store.get('operations-monitor','status')!;
  assert.notEqual(next.checkedAt,first.checkedAt);assert.equal(next.lastSuccessAt,next.checkedAt);assert.equal((app.store.db.prepare('SELECT count(*) n FROM audit').get() as any).n,audits.n);
  assert.equal(monitor.snapshot(clock+90001).label,'数据过期');assert(operationalHealth(app.store,clock+90001,undefined,monitor.snapshot(clock+90001)).alerts.some(a=>a.id==='monitor-stale'));
 }finally{monitor.close();await app.close();rmSync(root,{recursive:true,force:true});}
});
test('a failed probe preserves the prior success time, reports safe failure and recovers without losing its timer',async()=>{
 const root=mkdtempSync(join(tmpdir(),'operations-probe-')),app=new Platform({dataDir:root});let clock=Date.now(),fail=false;
 const monitor=new OperationsMonitor(app.store,(...args:Parameters<typeof operationalHealth>)=>{if(fail)throw Object.assign(Error('secret-fixture-never-persist'),{code:'EIO'});return operationalHealth(...args);},()=>clock);
 try{monitor.start();const timer=monitor.timer,success=monitor.snapshot().lastSuccessAt;fail=true;clock+=30000;monitor.tick();assert.equal(monitor.timer,timer);assert.equal(monitor.snapshot().state,'failed');assert.equal(monitor.snapshot().lastSuccessAt,success);assert.equal(monitor.snapshot().error?.code,'EIO');assert(!JSON.stringify(app.store.get('operations-monitor','status')).includes('secret-fixture'));
  const failed=app.store.db.prepare("SELECT count(*) n FROM audit WHERE action='operations.monitor.failed'").get() as any;clock+=30000;monitor.tick();assert.equal((app.store.db.prepare("SELECT count(*) n FROM audit WHERE action='operations.monitor.failed'").get() as any).n,failed.n);assert.equal(monitor.snapshot().consecutiveFailures,2);
  fail=false;clock+=30000;monitor.tick();assert.equal(monitor.snapshot().state,'healthy');assert.equal(monitor.snapshot().consecutiveFailures,0);assert.equal((app.store.db.prepare("SELECT count(*) n FROM audit WHERE action='operations.alert_resolved' AND target='monitor-probe'").get() as any).n,1);
 }finally{monitor.close();await app.close();rmSync(root,{recursive:true,force:true});}
});
test('a responsive operations endpoint does not conceal a stopped background monitor',async()=>{
 const root=mkdtempSync(join(tmpdir(),'operations-stopped-')),app=new Platform({dataDir:root});
 try{app.operationsMonitor.start();assert.equal(operations(app).health.monitor?.state,'healthy');app.operationsMonitor.close();const h=operations(app).health;assert(h.monitor);assert.equal(h.monitor.state,'stopped');assert.equal(h.monitor.running,false);assert(h.alerts.some(a=>a.id==='monitor-stopped'));
 }finally{await app.close();rmSync(root,{recursive:true,force:true});}
});
