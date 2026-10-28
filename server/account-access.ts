import {createHmac, randomBytes, timingSafeEqual} from 'node:crypto';
import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import type {IncomingMessage, ServerResponse} from 'node:http';
import type {Platform} from './app.ts';
import {hash, now, passwordHash, verifyPassword, requireThat, type Doc} from './store.ts';
import {MobileIdentity} from './mobile-identity.ts';

type Config = {serverId:string; gateway:string; key:string};
export function accountAccessConfig(app:Platform):Config|undefined {
  const file=join(app.store.root,'account-access.json');
  if(!existsSync(file))return;
  const c=JSON.parse(readFileSync(file,'utf8'));
  requireThat(c.serverId===app.serverId && /^[a-f0-9]{64}$/.test(c.key),'账号主机连接配置无效',503);
  const url=new URL(c.gateway);
  requireThat(url.protocol==='https:'&&!url.username&&!url.password&&!url.search&&!url.hash&&url.pathname==='/','账号入口必须为 HTTPS 根地址',503);
  return c;
}
export function signAccountRequest(key:string,serverId:string,time:string,nonce:string,body:string) {
  return createHmac('sha256',Buffer.from(key,'hex')).update([serverId,time,nonce,body].join('\n')).digest('hex');
}
export async function accountGatewayCall(app:Platform,body:Doc) {
  const c=accountAccessConfig(app);requireThat(c,'账号主机管理尚未启用',503);
  const raw=JSON.stringify(body),time=String(Date.now()),nonce=randomBytes(24).toString('hex');
  const r=await fetch(c.gateway.replace(/\/$/,'')+'/account-api/bridge',{method:'POST',redirect:'error',signal:AbortSignal.timeout(20000),headers:{'Content-Type':'application/json','X-Wawu-Host':c.serverId,'X-Wawu-Time':time,'X-Wawu-Nonce':nonce,'X-Wawu-Signature':signAccountRequest(c.key,c.serverId,time,nonce,raw)},body:raw});
  const result=await r.json() as Doc;requireThat(r.ok,result.error||'账号入口暂时不可用',r.status);return result;
}

/** Only the configured account gateway can invoke this bridge. No browser credential bypass. */
export async function accountAccessBridge(app:Platform,req:IncomingMessage,res:ServerResponse) {
  requireThat(req.method==='POST','请求方法无效',405);
  const c=accountAccessConfig(app);requireThat(c,'账号主机管理尚未启用',404);
  const chunks:Buffer[]=[];let bytes=0;
  for await(const chunk of req){bytes+=chunk.length;requireThat(bytes<=65536,'请求过大',413);chunks.push(chunk);}
  const raw=Buffer.concat(chunks).toString('utf8'),time=String(req.headers['x-wawu-time']??''),nonce=String(req.headers['x-wawu-nonce']??''),sig=String(req.headers['x-wawu-signature']??'');
  requireThat(req.headers['x-wawu-host']===app.serverId&&/^\d{13}$/.test(time)&&Math.abs(Date.now()-Number(time))<=30000&&/^[a-f0-9]{48}$/.test(nonce)&&/^[a-f0-9]{64}$/.test(sig),'账号连接验证失败',401);
  requireThat(timingSafeEqual(Buffer.from(sig,'hex'),Buffer.from(signAccountRequest(c.key,app.serverId,time,nonce,raw),'hex')),'账号连接验证失败',401);
  const key=hash(nonce);requireThat(!app.store.get('account-access-nonce',key),'账号请求已使用',409);
  app.store.put('account-access-nonce',{id:key,expires:Date.now()+60000});
  app.store.db.prepare("DELETE FROM docs WHERE kind='account-access-nonce' AND json_extract(body,'$.expires') < ?").run(Date.now());
  let body:Doc;try{body=JSON.parse(raw);}catch{throw new Error('账号请求格式错误');}
  requireThat(body&&typeof body==='object'&&!Array.isArray(body),'账号请求格式错误');
  const identity=(u:Doc)=>({id:u.id,username:u.username,name:u.name,role:u.role,active:u.active,credentialFingerprint:hash(u.password)});
  if(body.action==='inventory')return app.json(res,200,{serverId:app.serverId,users:app.store.all('user').filter(u=>!u.accountGatewayShadow).map(identity)});
  if(body.action==='authenticate'||body.action==='validate'){
    const user=app.store.get('user',String(body.userId??''));
    requireThat(user?.active&&!user.accountGatewayShadow,'账号或密码错误',401);
    if(body.action==='authenticate')requireThat(typeof body.password==='string'&&verifyPassword(body.password,user.password),'账号或密码错误',401);
    else requireThat(body.credentialFingerprint===hash(user.password),'账号登录已失效',401);
    return app.json(res,200,{serverId:app.serverId,user:identity(user)});
  }
  requireThat(['open','access'].includes(body.action),'账号请求不存在',404);
  requireThat(typeof body.accountId==='string'&&/^[a-f0-9-]{36}$/.test(body.accountId)&&typeof body.localUserId==='string'&&/^[a-f0-9-]{36}$/.test(body.localUserId),'账号身份无效');
  requireThat(['admin','member'].includes(body.role),'账号角色无效');
  const old=app.store.get('user',body.localUserId);
  requireThat(!old||!old.accountGatewayId||old.accountGatewayId===body.accountId,'主机账号归属冲突',409);
  requireThat(!old||old.role===body.role,'主机账号角色不匹配',409);
  requireThat(!old||old.active,'主机账号已停用',403);
  const user:Doc=old??{id:body.localUserId,username:'linked_'+body.accountId.replaceAll('-','').slice(0,30),name:String(body.name||body.username||'成员').slice(0,60),role:body.role,active:true,created:now(),password:passwordHash(randomBytes(32).toString('hex')),accountGatewayShadow:true};
  if(body.action==='access'){
    requireThat(typeof body.allowed==='boolean'&&Number.isSafeInteger(body.revision),'主机权限无效');
    requireThat(!old||body.revision>=(old.accountGatewayRevision??0),'主机权限版本过期',409);
    requireThat(body.role!=='admin'||body.allowed,'管理员可访问全部主机');
    const next={...user,accountGatewayId:body.accountId,accountGatewayAllowed:body.allowed,accountGatewayRevision:body.revision};
    app.store.tx(()=>{app.store.put('user',next);if(!body.allowed){app.store.db.prepare('DELETE FROM auth WHERE user_id=?').run(user.id);for(const g of app.store.all('mobile-device',user.id))app.store.put('mobile-device',{...g,revoked:true});}app.store.audit(body.accountId,'account.host.access',user.id,{allowed:body.allowed,revision:body.revision});});
    return app.json(res,200,{applied:true,serverId:app.serverId});
  }
  requireThat(old?.accountGatewayAllowed===true && old.accountGatewayId===body.accountId,'当前账号无权访问此主机',403);
  requireThat(old.accountGatewayRevision===body.revision,'主机权限尚未同步',409);
  if(body.client==='web'){
    const ticket=randomBytes(32).toString('hex');
    app.store.db.prepare("DELETE FROM docs WHERE kind='account-browser-ticket' AND json_extract(body,'$.expires') < ?").run(Date.now());
    app.store.put('account-browser-ticket',{id:hash(ticket),userId:user.id,accountId:body.accountId,revision:body.revision,expires:Date.now()+60000});
    return app.json(res,200,{serverId:app.serverId,ticket});
  }
  if(body.client==='h')return app.json(res,200,{serverId:app.serverId,user:app.publicUser(user),grant:new MobileIdentity(app.store,app.serverId).issue(user,'手机 H · 账号自动连接')});
  requireThat(body.client==='c','客户端类型无效');
  const token=randomBytes(32).toString('hex'),csrf=randomBytes(24).toString('hex');
  app.store.db.prepare('INSERT INTO auth VALUES(?,?,?,?)').run(hash(token),user.id,csrf,Date.now()+30*86400000);
  app.store.audit(user.id,'account.host.login',user.id);
  return app.json(res,200,{serverId:app.serverId,user:app.publicUser(user),cookie:`${app.cookieName}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=2592000`});
}

/** Browser handoff is a POST from the pinned account portal, never a URL token. */
export async function acceptAccountBrowser(app:Platform,req:IncomingMessage,res:ServerResponse,relay?:{origin:string}) {
  const config=accountAccessConfig(app);
  requireThat(config&&req.method==='POST','账号入口不存在',404);
  const origin=relay?req.headers['x-wawu-browser-origin']:req.headers.origin;
  requireThat(origin===new URL(config.gateway).origin,'账号入口来源不匹配',403);
  requireThat(req.headers['content-type']?.split(';')[0]==='application/x-www-form-urlencoded','账号入口格式无效',415);
  let raw='';for await(const chunk of req){raw+=chunk;requireThat(Buffer.byteLength(raw)<=1024,'账号入口请求过大',413);}
  const ticket=new URLSearchParams(raw).get('ticket');requireThat(ticket&&/^[a-f0-9]{64}$/.test(ticket),'账号入口已失效',401);
  const token=randomBytes(32).toString('hex'),csrf=randomBytes(24).toString('hex');
  app.store.tx(()=>{
    const key=hash(ticket),grant=app.store.get('account-browser-ticket',key),user=grant&&app.store.get('user',grant.userId);
    requireThat(grant&&grant.expires>Date.now()&&user?.active&&user.accountGatewayAllowed===true&&user.accountGatewayId===grant.accountId&&user.accountGatewayRevision===grant.revision,'账号入口已失效，请重新登录',401);
    app.store.db.prepare("DELETE FROM docs WHERE kind='account-browser-ticket' AND id=?").run(key);
    app.store.db.prepare('INSERT INTO auth VALUES(?,?,?,?)').run(hash(token),user.id,csrf,Date.now()+30*86400000);
    app.store.audit(user.id,'account.host.login',user.id,{client:'web'});
  });
  res.setHeader('Set-Cookie',`${app.browserCookieName}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${relay||app.options.tls?'; Secure':''}`);
  res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type','text/html; charset=utf-8');
  // A same-origin document starts the final navigation so Strict cookies apply.
  res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=/"><title>正在进入工作台</title><p>登录成功，正在进入工作台。<a href="/">继续</a></p></html>');
}
