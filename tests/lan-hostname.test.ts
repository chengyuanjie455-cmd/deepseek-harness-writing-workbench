import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Platform } from '../server/app.ts';
import { localHostname } from '../server/lan-hostname.ts';

test('native local host label is canonical and cannot add arbitrary hosts or URL syntax', () => {
  assert.equal(localHostname(' Work-Mac\n'), 'work-mac.local');
  for(const v of ['', '-mac', 'mac-', 'mac.local', 'mac,evil.example', 'a/b', 'a:4325', 'x'.repeat(64)]) assert.equal(localHostname(v), null);
});

test('one approved local origin supports login while other hosts, origins and CSRF remain blocked', async () => {
  const old = process.env.PLATFORM_ALLOWED_HOSTS;
  process.env.PLATFORM_ALLOWED_HOSTS = 'team-test.local';
  const app = new Platform({ dataDir: mkdtempSync(join(tmpdir(), 'team-local-name-')) });
  const password='Synthetic-local-only-28912!'; app.newUser({username:'local_admin',password},'admin');
  const port = await app.start(0), host=`team-test.local:${port}`, origin=`http://${host}`;
  const call=(method:string,path:string,body?:unknown,headers:Record<string,string>={})=>new Promise<{status:number;headers:any;body:any}>((resolve,reject)=>{
    const req=request({hostname:'127.0.0.1',port,method,path,headers:{Host:host,Origin:origin,'Content-Type':'application/json',...headers}},res=>{
      let data='';res.on('data',d=>data+=d);res.on('end',()=>resolve({status:res.statusCode!,headers:res.headers,body:JSON.parse(data)}));
    });req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));
  });
  try {
    assert.equal((await call('GET','/api/status')).status,200);
    assert.equal((await call('GET','/api/status',undefined,{Host:`other.local:${port}`})).status,403);
    assert.equal((await call('POST','/api/login',{username:'local_admin',password},{Origin:'http://attacker.local'})).status,403);
    const login=await call('POST','/api/login',{username:'local_admin',password});assert.equal(login.status,200);
    const cookie=login.headers['set-cookie'][0].split(';')[0];assert(!login.headers['set-cookie'][0].includes('Domain='));
    assert.equal((await call('GET','/api/project',undefined,{Cookie:cookie})).status,200);
    assert.equal((await call('POST','/api/logout',{}, {Cookie:cookie,'X-CSRF-Token':'wrong'})).status,403);
    assert.equal((await call('POST','/api/logout',{}, {Cookie:cookie,'X-CSRF-Token':login.body.csrf})).status,200);
    assert.equal((await call('GET','/api/me',undefined,{Cookie:cookie})).status,401);
  } finally {await app.close();if(old===undefined)delete process.env.PLATFORM_ALLOWED_HOSTS;else process.env.PLATFORM_ALLOWED_HOSTS=old;}
});
