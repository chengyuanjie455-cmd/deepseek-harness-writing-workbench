const {test}=require('node:test');const assert=require('node:assert/strict');const http=require('node:http');
const {normalizeOrigin,validOperation,Connection}=require('../connection.cjs');
test('project-file originals support video and SVG MIME types and preserve HTTP ranges',async()=>{
 const serverId='11111111-1111-1111-1111-111111111111',original=Buffer.from('synthetic video original'),seen=[];
 const server=http.createServer((req,res)=>{if(req.url==='/api/status'){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({serverId,protocol:{min:1,max:1}}));}if(req.url==='/api/login'){res.setHeader('Content-Type','application/json');res.setHeader('Set-Cookie','team_session_http=fixture; HttpOnly');return res.end('{"csrf":"fixture-csrf"}');}const url=new URL(req.url,'http://fixture'),svg=url.searchParams.get('path').endsWith('.svg');seen.push(req.headers.range??null);const b=req.headers.range?original.subarray(0,4):original;res.writeHead(req.headers.range?206:200,{'Content-Type':svg?'image/svg+xml':'video/mp4','Content-Length':b.length,'Accept-Ranges':'bytes',...(req.headers.range?{'Content-Range':`bytes 0-3/${original.length}`}:{})});res.end(b);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const c=new Connection();try{await c.connect('http://127.0.0.1:'+server.address().port,serverId);await c.call('/api/login','POST',{});for(const [path,range] of [['视频/原片.mp4',undefined],['视频/原片.mp4','bytes=0-3'],['资产/图.svg',undefined]]){const r=await c.projectFile({project:'shared',path},'GET',range);const chunks=[];for await(const b of r)chunks.push(b);assert.deepEqual(Buffer.concat(chunks),range?original.subarray(0,4):original);assert.equal(r.statusCode,range?206:200);}assert.deepEqual(seen,[null,'bytes=0-3',null]);await assert.rejects(c.projectFile({project:'shared',path:'视频/原片.mp4'},'GET','bytes=0-2,5-8'));}finally{c.disconnect();await new Promise(r=>server.close(r));}
});
test('desktop project-file bridge forwards only explicit thumbnail requests and leaves original requests unchanged',async()=>{
 const serverId='11111111-1111-1111-1111-111111111111',seen=[];
 const server=http.createServer((req,res)=>{if(req.url==='/api/status'){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({serverId,protocol:{min:1,max:1}}));}if(req.url==='/api/login'){res.setHeader('Content-Type','application/json');res.setHeader('Set-Cookie','team_session_http=fixture; HttpOnly');return res.end('{"csrf":"fixture-csrf"}');}const u=new URL(req.url,'http://fixture');assert.equal(u.pathname,'/api/file-content');assert.equal(req.headers.cookie,'team_session_http=fixture');seen.push(u.searchParams.get('preview'));const b=Buffer.from(u.searchParams.has('preview')?'thumbnail':'original');res.writeHead(200,{'Content-Type':'image/jpeg','Content-Length':b.length});res.end(b);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const c=new Connection();try{await c.connect('http://127.0.0.1:'+server.address().port,serverId);await c.call('/api/login','POST',{});for(const spec of [{project:'shared',path:'资产/大图.jpg',preview:'thumb'},{project:'shared',path:'资产/大图.jpg'}]){const r=await c.projectFile(spec);for await(const b of r){}}assert.deepEqual(seen,['thumb',null]);await assert.rejects(c.projectFile({project:'shared',path:'资产/大图.jpg',preview:'arbitrary'}));assert.equal(seen.length,2);}finally{c.disconnect();await new Promise(r=>server.close(r));}
});
test('origins and IPC requests cannot redirect to external targets or arbitrary operations',()=>{
  assert.equal(normalizeOrigin('localhost:4317'),'http://127.0.0.1:4317');
  assert.equal(normalizeOrigin('https://work.cyj123.top'),'https://work.cyj123.top');
  assert.equal(normalizeOrigin('mini.cyj123.top'),'https://mini.cyj123.top');
  assert.throws(()=>normalizeOrigin('https://user:secret@work.cyj123.top'));
  for(const bad of ['http://example.com','http://169.254.169.254','file:///etc/passwd','http://user:pw@192.168.1.1','http://192.168.1.1/private','http://192.168.1.1/?x=1'])assert.throws(()=>normalizeOrigin(bad));
  for(const p of ['https://example.com','//example.com/api/me','/api/../secret','/api/shell','/api/tasks#x'])assert.equal(validOperation(p,'GET'),false);
  assert(validOperation('/api/file?path=a%2Fb.md','GET'));assert(validOperation('/api/tasks','POST'));assert(!validOperation('/api/tasks','DELETE'));
});
test('connection keeps credentials only in memory, blocks changed identity, and never retries a write',async()=>{
  const id='11111111-1111-1111-1111-111111111111';let serverId=id,writes=0,logoutCookie='',probeCookies=[];
  const server=http.createServer((req,res)=>{
    res.setHeader('Content-Type','application/json');
    if(req.url==='/api/status'){probeCookies.push(req.headers.cookie??'');return res.end(JSON.stringify({serverId,protocol:{min:1,max:1}}));}
    if(req.url==='/api/login'){res.setHeader('Set-Cookie','team_session_http=private-token; HttpOnly');return res.end(JSON.stringify({csrf:'private-csrf',user:{id:'user'}}));}
    if(req.url==='/api/logout'){logoutCookie=req.headers.cookie;return res.end('{"ok":true}');}
    if(req.url==='/api/tasks'&&req.method==='POST'){writes++;req.socket.destroy();return;}
    return res.end(JSON.stringify({authenticated:!!req.headers.cookie}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
  try{
    const c=new Connection();await c.connect(base,id);const logged=await c.call('/api/login','POST',{username:'test',password:'synthetic'});
    assert(!('cookies' in logged));assert.equal((await c.call('/api/me')).data.authenticated,true);
    await assert.rejects(c.call('/api/tasks','POST',{}));assert.equal(writes,1);assert(c.needsProbe);
    await c.call('/api/status');assert(probeCookies.every(x=>x===''));
    await c.call('/api/logout','POST',{});assert.equal(logoutCookie,'team_session_http=private-token');assert.equal(c.cookie,'');
    const fresh=new Connection();await fresh.connect(base,id);assert.equal((await fresh.call('/api/me')).data.authenticated,false);
    serverId='22222222-2222-2222-2222-222222222222';await assert.rejects(c.call('/api/status'),/身份变化/);assert.equal(c.origin,'');assert.equal(c.cookie,'');
    await assert.rejects(fresh.connect(base,id),/身份已变化/);
  }finally{await new Promise(resolve=>server.close(resolve));}
});


test('private media bridge preserves bytes/ranges, rejects redirects and binds server identity',async()=>{
 const id='11111111-1111-1111-1111-111111111111',mediaId='33333333-3333-3333-3333-333333333333';
 let serverId=id,redirect=false,requests=0;const data=Buffer.from('synthetic original media bytes');
 const server=http.createServer((req,res)=>{
  if(req.url==='/api/status'){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({serverId,protocol:{min:1,max:1}}));}
  if(req.url==='/api/login'){res.setHeader('Content-Type','application/json');res.setHeader('Set-Cookie','team_session_http=test-private; HttpOnly');return res.end(JSON.stringify({csrf:'test-csrf'}));}
  if(req.url==='/api/media/'+mediaId){requests++;assert.equal(req.headers.cookie,'team_session_http=test-private');
   if(redirect){res.writeHead(302,{Location:'http://example.invalid/stolen'});return res.end();}
   const part=req.headers.range?data.subarray(0,4):data;res.writeHead(req.headers.range?206:200,{'Content-Type':'video/mp4','Content-Length':part.length,...(req.headers.range?{'Content-Range':`bytes 0-3/${data.length}`}:{})});return res.end(part);}
  res.end('{}');
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const c=new Connection();
 try{await c.connect('http://127.0.0.1:'+server.address().port,id);await assert.rejects(c.media(mediaId));await c.call('/api/login','POST',{});
  const response=await c.media(mediaId,'bytes=0-3');assert.equal(response.statusCode,206);const chunks=[];for await(const b of response)chunks.push(b);assert.deepEqual(Buffer.concat(chunks),data.subarray(0,4));
  redirect=true;await assert.rejects(c.media(mediaId));assert.equal(requests,2);
  serverId='22222222-2222-2222-2222-222222222222';await assert.rejects(c.media(mediaId));assert.equal(requests,2);
  c.disconnect();await assert.rejects(c.media(mediaId));
 }finally{c.disconnect();await new Promise(r=>server.close(r));}
});


test('quota approvals, media directory and image operations use the constrained desktop bridge',()=>{
 const id='11111111-1111-1111-1111-111111111111';
 for(const p of ['/api/admin/video-quota-requests','/api/xiaopei-models','/api/images?all=1','/api/image-models','/api/image-assets'])assert(validOperation(p,'GET'),p);
 for(const p of [`/api/admin/video-quota-requests/${id}/decision`,`/api/pickups/${id}/quota-requests`,`/api/admin/xiaopei-channels/${id}/sync`,`/api/images/${id}/confirm`,`/api/images/jobs/${id}/recover`,'/api/image-assets'])assert(validOperation(p,'POST'),p);
 assert(!validOperation('/api/images/arbitrary-shell','POST'));assert(!validOperation('/api/admin/xiaopei-channels/key/delete','POST'));
});

test('admin model management bridge allows only defined routes and verbs',()=>{
 const id='12345678-1234-1234-1234-123456789012';
 assert(validOperation('/api/admin/media-models','GET'));assert(validOperation('/api/admin/image-models','POST'));
 for(const kind of ['image','video'])assert(validOperation(`/api/admin/media-models/${kind}/${id}/remove`,'POST'));
 assert(!validOperation(`/api/admin/media-models/anything/${id}/remove`,'POST'));assert(!validOperation('/api/admin/media-models','DELETE'));
});

test('multi-project routes and selected project queries use the same authenticated backend',()=>{
 assert(validOperation('/api/projects','GET'));assert(validOperation('/api/admin/projects/preview','POST'));assert(validOperation('/api/admin/projects','POST'));assert(validOperation('/api/tasks?project=12345678-1234-1234-1234-123456789012','POST'));assert(!validOperation('/api/admin/projects','DELETE'));assert(!validOperation('/api/projects','POST'));
});

 test("project attachments permit scoped chunk operations but not arbitrary file routes",()=>{assert.equal(validOperation("/api/uploads?project=shared","POST"),true);assert.equal(validOperation("/api/uploads/"+"a".repeat(32)+"/chunk?project=shared","POST"),true);assert.equal(validOperation("/api/file-reference?project=shared","POST"),true);assert.equal(validOperation("/api/uploads/../../etc/passwd","GET"),false);});


test('chat models, scoped policies, session updates and queue edits are exposed through desktop IPC',()=>{
 const id='11111111-1111-1111-1111-111111111111';
 for(const p of ['/api/chat-options','/api/admin/chat-models'])assert(validOperation(p+'?project=shared','GET'));
 for(const p of ['/api/admin/chat-models','/api/admin/chat-policy'])assert(validOperation(p+'?project=shared','POST'));
 for(const p of ['/api/sessions/'+id,'/api/tasks/'+id])assert(validOperation(p+'?project=shared','PATCH'));
 assert(!validOperation('/api/admin/chat-policy','PATCH'));assert(!validOperation('/api/sessions/'+id,'DELETE'));
});

test('desktop administration reaches billing, member models and operations through the authenticated bridge',async()=>{
 const id='11111111-1111-1111-1111-111111111111',seen=[];
 const reads=['/api/mobile/devices','/api/mobile/bootstrap','/api/admin/billing','/api/admin/member-models','/api/admin/operations','/api/admin/concurrency'];
 const writes=['/api/mobile/devices','/api/mobile/devices/revoke','/api/admin/billing/prices/verify','/api/admin/billing/reconcile','/api/admin/member-models','/api/admin/operations/recover','/api/admin/operations/catalog','/api/admin/operations/idle','/api/admin/concurrency'];
 const server=http.createServer(async(req,res)=>{
  res.setHeader('Content-Type','application/json');
  if(req.url==='/api/status')return res.end(JSON.stringify({serverId:id,protocol:{min:1,max:1}}));
  if(req.url==='/api/login'){res.setHeader('Set-Cookie','team_session_http=fixture-only; HttpOnly');return res.end(JSON.stringify({csrf:'fixture-csrf'}));}
  let raw='';for await(const part of req)raw+=part;
  seen.push({path:req.url,method:req.method,cookie:req.headers.cookie,csrf:req.headers['x-csrf-token'],body:raw?JSON.parse(raw):null});res.end('{"ok":true}');
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const c=new Connection();
 try{
  await c.connect('http://127.0.0.1:'+server.address().port,id);await c.call('/api/login','POST',{username:'fixture',password:'fixture-only'});
  for(const p of reads)assert.equal((await c.call(p+'?project=shared')).status,200);
  for(const p of writes)assert.equal((await c.call(p+'?project=shared','POST',{fixture:true})).status,200);
  assert.equal(seen.length,reads.length+writes.length);assert(seen.every(r=>r.cookie==='team_session_http=fixture-only'&&r.csrf==='fixture-csrf'&&r.path.endsWith('?project=shared')));
  assert(seen.filter(r=>r.method==='POST').every(r=>r.body.fixture));
  for(const p of ['/api/admin/billing/arbitrary','/api/admin/operations/delete','/api/admin/member-models/reset','/api/mobile/identity','/api/mobile/arbitrary'])await assert.rejects(c.call(p,'POST',{}),/接口范围/);
  for(const p of [...reads,...writes])assert(!validOperation(p,'DELETE'));
  assert(!validOperation('/api/admin/billing','POST'));assert(!validOperation('/api/admin/operations','POST'));assert.equal(seen.length,reads.length+writes.length);
 }finally{c.disconnect();await new Promise(r=>server.close(r));}
});
