import {MobileIdentity} from './mobile-identity.ts';
import {companionRunners} from './companion-runner.ts';
import type {IncomingMessage, ServerResponse} from 'node:http';
import type {Platform} from './app.ts';
import {hash, now, requireThat, type Doc} from './store.ts';
import {publicRow} from './native-history.ts';
import {Transform} from 'node:stream';
import {createHash} from 'node:crypto';
import {mkdir, open, readFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';

function imageType(bytes:Buffer) {
  if(bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')))return 'image/png';
  if(bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return 'image/jpeg';
  if(bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP')return 'image/webp';
  if(['GIF87a','GIF89a'].includes(bytes.toString('ascii',0,6)))return 'image/gif';
}

// Prototype only. Reuses platform authentication, native session ownership and storage.
// A durable unknown receipt is never an instruction to repeat a model request.
export class MobileGateway {
  private pending = new Map<string, Promise<Doc>>();
  constructor(private app: Platform) {
    for (const receipt of app.store.all('mobile-receipt')) {
      if (receipt.state === 'preparing' || receipt.state === 'dispatching') {
        app.store.put('mobile-receipt', {...receipt, state: receipt.state === 'preparing' ? 'notReceived' : 'indeterminate',
          reason: '服务恢复后只查询原回执，没有自动重发'});
      }
    }
  }
  canonicalKey(key: Doc) {
    return {serverId: key.serverId, projectId: key.projectId, ownerId: key.ownerId, nativeSessionId: key.nativeSessionId};
  }
  scope(viewer: Doc, key: Doc) {
    requireThat(key?.serverId === this.app.serverId, '主机身份不一致', 409);
    requireThat(typeof key.projectId === 'string' && typeof key.ownerId === 'string', '会话范围无效', 400);
    const current = this.app.store.get('user', viewer.id);
    requireThat(current?.active && current.role === viewer.role, '登录身份已变化', 401);
    const owner = this.app.nativeOwner(current, key.projectId, key.ownerId === viewer.id ? undefined : key.ownerId);
    requireThat(owner.active, '成员已停用', 403);
    requireThat(/^session-[a-zA-Z0-9-]{1,160}$/.test(key.nativeSessionId), '原生聊天编号无效', 400);
    return {owner, historyKey: this.app.native.key(owner, key.projectId)};
  }
  async page(viewer: Doc, key: Doc, after?: number) {
    const {historyKey} = this.scope(viewer, key);
    requireThat(after === undefined || Number.isSafeInteger(after) && after >= -1, '游标无效', 400);
    const data = await this.app.native.history.read(historyKey, key.nativeSessionId, {after, limit: 100});
    this.scope(viewer, key);
    requireThat(!data.missing, '原生聊天不存在', 404);
    // Resolve interrupted host runs on mobile-only reconnect as well; never replay them.
    this.app.native.team.codexService();
    return {...data, serverId: this.app.serverId, rows: data.rows.map((row:Doc) => ({...publicRow(row), isUserInput: row.role === 'user' && row.source?.kind === 'user', requestId: row.source?.kind === 'user' ? row.source.rpcId : undefined})),
      results: this.app.native.history.results(key.projectId, key.ownerId, key.nativeSessionId),
      codexRuns: this.app.store.all('codex-run', key.ownerId)
        .filter(r=>r.project===key.projectId&&r.nativeSession===key.nativeSessionId&&r.instance===historyKey)
        .sort((a,b)=>a.created.localeCompare(b.created))
        .map(r=>({id:r.id,state:r.state,model:r.model,text:r.text,error:r.error,steps:r.steps??[],created:r.created,finished:r.finished}))};
  }
  receiptId(viewer: Doc, requestId: string) {
    requireThat(typeof requestId === 'string' && /^[a-zA-Z0-9_-]{8,160}$/.test(requestId), '提交编号无效', 400);
    return hash(JSON.stringify([this.app.serverId, viewer.id, requestId]));
  }
  async send(viewer: Doc, body: Doc, verify: () => void) {
    const {requestId, text} = body;
    const {owner} = this.scope(viewer, body.key), key = this.canonicalKey(body.key);
    requireThat(Object.keys(body).every(k => ['key', 'requestId', 'text', 'receiptIds', 'sourceFingerprint'].includes(k)), '消息包含未支持的字段', 400);
    const receiptIds = body.receiptIds ?? [];
    const sourceFingerprint = body.sourceFingerprint ?? '';
    requireThat(typeof sourceFingerprint === 'string' && (sourceFingerprint === '' || /^[a-f0-9]{64}$/.test(sourceFingerprint)), '消息指纹无效', 400);
    requireThat(Array.isArray(receiptIds) && receiptIds.every((r:unknown) => typeof r === 'string'), '附件回执格式无效', 400);
    requireThat(typeof text === 'string' && (text.trim().length > 0 || receiptIds.length > 0) && text.length <= 200000, '消息内容无效', 400);
    const rid = this.receiptId(viewer, requestId), digest = hash(JSON.stringify({key, text, receiptIds, sourceFingerprint}));
    const existing = this.app.store.get('mobile-receipt', rid);
    if (existing) {
      requireThat(existing.digest === digest, '相同提交编号对应不同消息', 409);
      return this.pending.get(rid) ?? existing;
    }
    // There is no await between looking up and reserving this request.
    const base = {id: rid, owner: viewer.id, actorId: viewer.id, key, requestId, receiptIds, sourceFingerprint, digest, created: now()};
    this.app.store.put('mobile-receipt', {...base, state: 'preparing'});
    const operation = (async () => {
      let dispatchStarted = false;
      try {
        await this.page(viewer, key);
        const instance = await this.app.native.get(owner, key.projectId);
        verify(); this.scope(viewer, key);
        const images:Doc[]=[];
        for (const receiptId of receiptIds) {
          const upload = this.app.store.get('mobile-upload', receiptId);
          requireThat(upload && upload.actorId === viewer.id && JSON.stringify(upload.key) === JSON.stringify(key), '附件不属于当前账号和聊天', 403);
          if(upload?.mediaType) {
            const data=await readFile(join(this.app.store.root,'mobile-uploads',upload.blob));
            requireThat(hash(data)===upload.sha256,'提交时的参考图原件发生变化',409);
            images.push({type:'image',mediaType:upload.mediaType,data:data.toString('base64'),name:upload.file.name});
          }
        }
        const args = {sessionId: key.nativeSessionId, requestId, mode: 'queue', content: [
          ...(text ? [{type: 'text', text}] : []), ...images, ...receiptIds.map((receiptId:string) => ({type:'file', receiptId}))]};
        await this.app.native.checkRoute(viewer, instance, '/api/session/prompt', Buffer.from(JSON.stringify({payload: {args: {request: args}}})));
        verify(); this.scope(viewer, key);
        this.app.store.put('mobile-receipt', {...base, state: 'dispatching'});
        dispatchStarted = true;
        const native = await this.app.native.rpc(instance, 'session/prompt', args);
        this.app.store.audit(viewer.id, 'mobile.native_chat.send', key.nativeSessionId, {project: key.projectId, member: owner.id, requestId});
        return this.app.store.put('mobile-receipt', {...base, state: 'accepted', native, acceptedAt: now()});
      } catch (error) {
        if ((error as any)?.nativeRejected) dispatchStarted = false;
        return this.app.store.put('mobile-receipt', {...base, state: dispatchStarted ? 'indeterminate' : 'notReceived',
          reason: dispatchStarted ? '原生回执未确认，请查询原请求；没有自动重发' : '尚未向原生聊天发送',
          error: error instanceof Error ? error.message : '请求未完成'});
      } finally { this.pending.delete(rid); }
    })();
    this.pending.set(rid, operation);
    return operation;
  }
  async route(req: IncomingMessage, res: ServerResponse, url: URL) {
    const {user} = this.app.authenticate(req);
    const verify = () => { requireThat(this.app.authenticate(req).user.id === user.id, '登录状态已变化', 401); };
    const path = url.pathname, method = req.method;
    const identity = new MobileIdentity(this.app.store,this.app.serverId);
    if(path === '/api/mobile/identity' && method === 'GET') {
      const {grant}=identity.authenticate(req);
      await companionRunners.ensure(this.app.store.root, user.id);
      verify(); identity.authenticate(req);
      return this.app.json(res,200,{serverId:this.app.serverId,accountId:user.id,namespace:identity.namespace(user.id),expires:grant.expires,label:grant.label,username:user.username});
    }
    if(path === '/api/mobile/devices' && method === 'GET') return this.app.json(res,200,{items:this.app.store.all('mobile-device',user.id).map(g=>identity.public(g))});
    if(path === '/api/mobile/devices' && method === 'POST') {
      requireThat(!req.headers.authorization,'新增配对请在已登录的原工作台操作',403);
      const body=await this.app.body(req);verify();return this.app.json(res,201,identity.issue(user,body.label));
    }
    if(path === '/api/mobile/devices/revoke' && method === 'POST') {
      const body=await this.app.body(req);verify();return this.app.json(res,200,identity.revoke(user,body.id));
    }
    if (path === '/api/mobile/bootstrap' && method === 'GET') {
      return this.app.json(res, 200, {serverId: this.app.serverId, protocol: 1, viewer: this.app.publicUser(user),
        capabilities: {nativeText: true, nativeHistory: true, receiptLookup: true, workbench: true,
          attachmentBridge: true, push: false, modelOverride: false, nativeHistoryStreaming: false}});
    }
    if (path === '/api/mobile/upload' && method === 'POST') {
      let key:Doc;
      try {key = JSON.parse(url.searchParams.get('key') || '{}');} catch {return this.app.json(res, 400, {error:'附件会话无效'});}
      const {owner} = this.scope(user, key);
      const name = url.searchParams.get('name') || 'attachment';
      requireThat(name.length <= 512 && !/[\x00-\x1f]/.test(name), '文件名无效', 400);
      await this.page(user, key);
      const instance = await this.app.native.get(owner, key.projectId);
      verify(); this.scope(user, key);
      const digest = createHash('sha256'); let bytes = 0;
      const directory=join(this.app.store.root,'mobile-uploads');await mkdir(directory,{recursive:true,mode:0o700});
      const blob=randomUUID(), saved=join(directory,blob), file=await open(saved,'wx',0o600);
      let prefix=Buffer.alloc(0), committed=false;
      // Stream exact bytes through the existing native upload authority; no image recompression.
      const stream = new Transform({transform(chunk, _encoding, done) {
        try {verify(); bytes += chunk.length; digest.update(chunk); if(prefix.length<12)prefix=Buffer.concat([prefix,chunk]).subarray(0,12);
          void file.writeFile(chunk).then(()=>done(null,chunk),e=>done(e));
        } catch(e) {done(e as Error);}
      }});
      const abort = new AbortController();
      req.once('aborted', () => abort.abort());
      req.pipe(stream);
      const origin = `http://127.0.0.1:${instance.port}`;
      const query = new URLSearchParams({sessionId:key.nativeSessionId, name});
      try {
        const response = await fetch(origin+'/api/session/uploadFileBinary?'+query, {
          method:'POST', headers:{Origin:origin, Cookie:instance.cookie, 'Content-Type':'application/octet-stream'},
          body:stream as any, duplex:'half', redirect:'error', signal:abort.signal} as any);
        const result = await response.json() as any;
        requireThat(response.ok && result.ok && result.value?.receiptId, result.error?.message || '原生附件上传失败', 502);
        verify(); this.scope(user, key);
        requireThat(result.value.file?.bytes === bytes, '附件上传字节数不一致', 502);
        const sha256 = digest.digest('hex');
        await file.sync();
        this.app.store.put('mobile-upload', {id:result.value.receiptId, actorId:user.id, key:this.canonicalKey(key), bytes, sha256, file:result.value.file, mediaType:imageType(prefix), blob, created:now()});
        committed=true;
        return this.app.json(res, 201, {...result.value, sha256, bytes});
      } finally {req.unpipe(stream); stream.destroy(); await file.close(); if(!committed)await rm(saved,{force:true});}
    }
    if (path === '/api/mobile/media' && ['GET','HEAD'].includes(method ?? '')) {
      let key:Doc;try{key=JSON.parse(url.searchParams.get('key')??'{}');}catch{return this.app.json(res,400,{error:'媒体会话无效'});}
      this.scope(user,key);const mediaId=url.searchParams.get('mediaId');
      const results=this.app.native.history.results(key.projectId,key.ownerId,key.nativeSessionId);
      requireThat(results.some((r:Doc)=>r.mediaId===mediaId),'原件不属于当前聊天',404);verify();
      res.setHeader('X-Wawu-Server',this.app.serverId);res.setHeader('X-Wawu-Account',user.id);
      const guard=setInterval(()=>{try{verify();this.scope(user,key);}catch{res.destroy();}},2000);guard.unref();res.once('close',()=>clearInterval(guard));
      try{return this.app.pickups.media.serve(req,res,String(mediaId),user);}catch(e){clearInterval(guard);throw e;}
    }
    if (path === '/api/mobile/navigation' && method === 'GET') {
      const value = await this.app.native.history.navigation(user); verify();
      return this.app.json(res, 200, value);
    }
    if (path === '/api/mobile/history' && method === 'POST') {
      const body = await this.app.body(req), data = await this.page(user, body.key, body.after); verify();
      return this.app.json(res, 200, data);
    }
    if (path === '/api/mobile/send' && method === 'POST') {
      const body = await this.app.body(req), receipt = await this.send(user, body, verify); verify();
      return this.app.json(res, receipt.state === 'accepted' ? 200 : 202, receipt);
    }
    if (path === '/api/mobile/receipt' && method === 'POST') {
      const body = await this.app.body(req);
      this.scope(user, body.key);
      let value = this.app.store.get('mobile-receipt', this.receiptId(user, body.requestId));
      requireThat(!value || JSON.stringify(this.canonicalKey(value.key)) === JSON.stringify(this.canonicalKey(body.key)), '提交所属聊天不匹配', 409);
      if (value?.state === 'indeterminate') {
        const {historyKey} = this.scope(user, body.key);
        const data = await this.app.native.history.read(historyKey, body.key.nativeSessionId);
        verify(); this.scope(user, body.key);
        if (data.rows?.some((row:Doc) => row.role === 'user' && row.source?.kind === 'user' && row.source.rpcId === body.requestId)) {
          const {error, reason, ...saved} = value;
          value = this.app.store.put('mobile-receipt', {...saved, state: 'accepted', recoveredFromNativeHistory: true, acceptedAt: now()});
        }
      }
      return this.app.json(res, 200, value ?? {state: 'notReceived', requestId: body.requestId});
    }
    if (path === '/api/mobile/cancel' && method === 'POST') {
      const body = await this.app.body(req), {owner} = this.scope(user, body.key);
      await this.page(user, body.key); const instance = await this.app.native.get(owner, body.key.projectId);
      verify(); this.scope(user, body.key);
      const value = await this.app.native.rpc(instance, 'session/cancel', {sessionId: body.key.nativeSessionId});
      this.app.store.audit(user.id, 'mobile.native_chat.cancel', body.key.nativeSessionId, {member: owner.id});
      return this.app.json(res, 200, {native: value, generationJobsCancelled: false});
    }
    return this.app.json(res, 404, {error: '手机原型接口不存在'});
  }
}
