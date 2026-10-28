const {test}=require('node:test');const assert=require('node:assert/strict');
const http=require('node:http');
const {restoreSaved}=require('../reconnect.cjs');const {Connection,probe}=require('../connection.cjs');
const id='11111111-1111-1111-1111-111111111111',other='22222222-2222-2222-2222-222222222222';
test('member discovery queries every physical private interface but excludes VPN and public routes',()=>{
 const {discoveryInterfaces}=require('../discovery.cjs');const nic=address=>({address,internal:false,family:'IPv4'});
 assert.deepEqual(discoveryInterfaces({en0:[nic('192.168.210.42')],en9:[nic('192.168.220.19')],utun0:[nic('10.0.0.1')],bridge0:[nic('192.168.64.1')],en8:[nic('8.8.8.8')]}),['192.168.210.42','192.168.220.19']);
});
test('saved host relocates via unauthenticated GET; identity remains fixed and old credentials are cleared',async()=>{
 const requests=[];const server=http.createServer((req,res)=>{requests.push({method:req.method,url:req.url,cookie:req.headers.cookie,csrf:req.headers['x-csrf-token']});res.setHeader('Content-Type','application/json');res.end(JSON.stringify({serverId:id,protocol:{min:1,max:1}}));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
 const conn=new Connection();conn.cookie='SECRET-OLD-SESSION';conn.csrf='SECRET-CSRF';conn.userId='old';
 try{
  const result=await restoreSaved({origin:'http://127.0.0.1:1',serverId:id},{probe,discover:async()=>[{origin,serverId:other},{origin,serverId:id}],connect:(a,b)=>conn.connect(a,b)});
  assert(result.moved);assert.equal(conn.origin,origin);assert.equal(conn.serverId,id);assert.equal(conn.cookie,'');assert.equal(conn.csrf,'');
  assert.equal(requests.length,2);assert(requests.every(r=>r.method==='GET'&&r.url==='/api/status'&&!r.cookie&&!r.csrf));
 }finally{await new Promise(r=>server.close(r));}
});
test('identity reuse, unverified announcements and unrelated hosts cannot silently rebind',async()=>{
 const saved={origin:'http://192.168.200.10:4325',serverId:id};let connects=0,discovery=0;
 const connect=async()=>{connects++;throw Error('must not bind');};
 await assert.rejects(restoreSaved(saved,{probe:async()=>({status:{serverId:other}}),discover:async()=>{discovery++;return[];},connect}),/身份已变化/);assert.equal(discovery,0);
 await assert.rejects(restoreSaved(saved,{probe:async origin=>{if(origin===saved.origin)throw Error('offline');return{origin,status:{serverId:other}};},discover:async()=>[{origin:'http://192.168.210.42:4325',serverId:id},{origin:'http://8.8.8.8',serverId:id}],connect}),/尚未找到原主机/);assert.equal(connects,0);
 await assert.rejects(restoreSaved({...saved,serverId:undefined},{connect}),/先选择/);
});
