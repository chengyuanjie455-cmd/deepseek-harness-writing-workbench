const {test}=require('node:test');const assert=require('node:assert/strict');const {NativeAccess}=require('../native-access.cjs');
test('multiple opened project frames retain independent credentials within one login, including websocket requests',()=>{
 const access=new NativeAccess(),connection={origin:'http://127.0.0.1:4325',epoch:1},a=connection.origin+'/harness/shared/',b=connection.origin+'/harness/11111111-1111-1111-1111-111111111111/';
 access.add(a,'team_native=a',1);access.add(b,'team_native=b',1);
 assert.equal(access.find(a+'api/poll',connection).cookie,'team_native=a');assert.equal(access.find(b+'api/poll',connection).cookie,'team_native=b');assert.equal(access.find(a.replace('http:','ws:')+'api/ws',connection).cookie,'team_native=a');
 for(const url of [connection.origin+'/api/projects',a.replace('/shared/','/shared-other/'),a.replace('127.0.0.1','attacker.test')])assert.equal(access.find(url,connection),undefined);
 connection.epoch++;assert.equal(access.find(a,connection),undefined);access.add(a,'team_native=new',2);assert.equal(access.find(b,connection),undefined);access.clear();assert.equal(access.find(a,connection),undefined);
});

test('administrator member frames keep separate cookies from their own project and other members',()=>{
 const a=new NativeAccess(),c={origin:'http://127.0.0.1:4325',epoch:3},own=c.origin+'/harness/shared/',member=own.slice(0,-1)+'~11111111-1111-1111-1111-111111111111/';a.add(own,'own',3);a.add(member,'member',3);
 assert.equal(a.find(own+'api/read',c).cookie,'own');assert.equal(a.find(member+'api/read',c).cookie,'member');assert.equal(a.find(member.replace('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222')+'api/read',c),undefined);
});
