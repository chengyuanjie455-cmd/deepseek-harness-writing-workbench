import {privateSkillDefinitionStatus} from './private-skill-definition.ts';
import {NativeAttachments} from './native-attachments.ts';
import {ProjectLinks} from './project-links.ts';
import {EpisodeAssembly} from './episode-assembly.ts';
import {ProjectContent} from './project-content.ts';
import {MediaStore} from './media.ts';
import {ProviderReferences} from './provider-references.ts';
import {accountAccessBridge,accountGatewayCall,accountAccessConfig,acceptAccountBrowser} from './account-access.ts';
import {TrustedRelay} from './trusted-relay.ts';
import {MobileIdentity} from './mobile-identity.ts';
import {MobileGateway} from './mobile-gateway.ts';
import {serveMediaPreview} from './media-preview.ts';
import {MediaWorkerManager,activeMediaWorker} from './media-worker-manager.ts';
import {hostFiles} from './host-files.ts';
import {mediaGallery} from './media-gallery.ts';
import {serveGalleryBundle,prepareGalleryBundle} from './gallery-bundle.ts';
import {Incidents,type IncidentOptions} from './incidents.ts';
import {chatCapabilities} from './model-capabilities.ts';
import {routingPolicy,saveRoutingPolicy} from './model-routing.ts';
import {memberSubmissions} from './member-submissions.ts';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFileSync, existsSync, mkdirSync, writeFileSync, copyFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { isIPv4, type Socket } from 'node:net';
import { Store, Problem, requireThat, hash, id, now, passwordHash, verifyPassword, type Doc } from './store.ts';
import {ProjectUploads} from './project-uploads.ts';
import {documentText} from './document-text.ts';
import {objectInfo,objectPath,storeFile} from './file-objects.ts';
import { Projects, validPath } from './project.ts';
import {browseHostFolders} from './host-folders.ts';
import { modelPolicy, budgetStatus, type ModelConnection } from './model.ts';
import { HarnessHost } from './harness.ts';
import { Pickups } from './pickups.ts';
import {MAX_CONCURRENCY,MAX_PENDING_TASKS,concurrencyValue,videoCapacity,channelCapacity,imageCapacity,migrateImageCapacity} from './concurrency.ts';
import { MediaModelAdmin } from './media-model-admin.ts';
import { ImageGeneration, type ImageAdapter } from './image-generation.ts';
import type { VideoAdapter } from './video-catalog.ts';
import { IMAGE, sandboxAvailable, TerminationUnconfirmed, stopAndVerify } from './sandbox.ts';

import {MemberModels} from './member-models.ts';
import {ChatCatalog} from './chat-catalog.ts';
import {Billing,publicResponse} from './billing.ts';
import {OperationsMonitor} from './operational-health.ts';
import {taskTrace} from './task-trace.ts';
import {operations,normalizeCatalog,recoverOperation} from './operations.ts';
import {auditLog} from './audit-log.ts';
import {FairQueue} from './fair-queue.ts';
import {NativeHarness,NATIVE_FEATURES} from './native-harness.ts';

type Options = { nativeProjectSurface?:boolean; mobilePrototype?:boolean; mediaWorker?:boolean; workerFixtureModule?:string; incidents?:IncidentOptions; nativeOnly?:boolean; imageAdapter?:ImageAdapter; videoConcurrency?: number; videoAdapter?: VideoAdapter; simulatedVideo?: boolean; dataDir: string; staticDir?: string; mockDelay?: number; concurrency?: number; model?: ModelConnection; allowLanHttp?: boolean; tls?: { key: string; cert: string } };
export function privateIPv4(address: string) { if (!isIPv4(address)) return false; const [a, b] = address.split('.').map(Number); return a === 10 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168; }
type Workspace={links:ProjectLinks;attachments:NativeAttachments;assembly:EpisodeAssembly;content:ProjectContent;store:Store;projects:Projects;pickups:Pickups;images:ImageGeneration;host:HarnessHost;uploads:ProjectUploads;initializing?:Promise<void>};
export class Platform {
  private mobileGateway?:MobileGateway;
  private billingResponses=new WeakSet<ServerResponse>();
  operationsMonitor:OperationsMonitor; incidents:Incidents; mediaWorker?:MediaWorkerManager;
  catalog:ChatCatalog; native:NativeHarness; textQueue:FairQueue; providerReferences:ProviderReferences;
  workspaces=new Map<string,Workspace>();
  additionalServers: ReturnType<typeof createServer>[] = [];
  private additionalHosts = new Set<string>();
  private lanListeners = new Map<string, ReturnType<typeof createServer>>();
  private listenerSockets = new WeakMap<object, Set<Socket>>();
  private handler: (req:IncomingMessage,res:ServerResponse)=>void;
  instanceId = process.env.PLATFORM_INSTANCE_ID ?? id();
  serverId: string;
  trustedRelay: TrustedRelay;
  images:ImageGeneration; pickups: Pickups; store: Store; projects: Projects; host: HarnessHost; server; active = new Map<string, AbortController>(); closing = false; lastOwner = ''; sandboxReady = false;
  constructor(public options: Options) {
    requireThat(options.mediaWorker||!activeMediaWorker(resolve(options.dataDir)),'媒体执行器仍在运行，请使用独立执行模式连接',409);
    this.trustedRelay = new TrustedRelay(resolve(options.dataDir));
    this.store = new Store(resolve(options.dataDir));this.providerReferences=new ProviderReferences(this.store,new MediaStore(this.store));this.operationsMonitor=new OperationsMonitor(this.store);
    migrateImageCapacity(this.store);
    const capacity=this.store.get('runtime-concurrency','active');
    this.options.concurrency=concurrencyValue(capacity?.text??options.concurrency??4);
    this.options.videoConcurrency=concurrencyValue(capacity?.video??options.videoConcurrency??2);
    this.textQueue=new FairQueue(Math.min(this.options.concurrency,this.store.get('runtime-concurrency','active')?.testedText??96));
    this.catalog=new ChatCatalog(this.store,options.model);
    const identity = this.store.get('runtime', 'server-identity') ?? this.store.put('runtime', { id: 'server-identity', serverId: id(), created: now() });
    this.serverId = identity.serverId;
    try {const shared=this.addWorkspace('shared');this.projects=shared.projects;this.pickups=shared.pickups;this.images=shared.images;this.host=shared.host;
      for(const p of this.store.all('project'))if(p.id!=='shared')this.addWorkspace(p.id);
    }catch(error){this.store.close();throw error;}
    if (!this.store.get('config', 'active')) {
      this.store.put('release', { id: id(), title: '资料整理与人工审核', instruction: '读取指定资料，输出整理报告，等待超级管理员审核。', ...modelPolicy(options.model), allowScripts: false, created: now() });
      this.store.put('config', { id: 'active', release: this.store.all('release')[0].id });
    }
    const route = modelPolicy(options.model);
    if (this.release().provider !== route.provider || this.release().model !== route.model || this.release().configId !== ('configId' in route ? route.configId : undefined) || this.release().limits?.taskUsd !== undefined) { const r = { ...this.release(), ...route, id: id(), created: now(), source: 'server-model-configuration' }; this.store.put('release', r); this.store.put('config', { id: 'active', release: r.id }); this.store.audit('server', 'model.configuration.loaded', r.id, { provider: r.provider, model: r.model }); }
    for (const t of this.store.all('task')) if (['running', 'cancel_requested','steering'].includes(t.state)) { this.store.put('task', { ...t, state: t.container ? 'termination_unconfirmed' : 'interrupted', error: t.container ? '服务重启，执行器停止状态需核对。' : '服务重启中断了执行，未自动重发。', generation: t.generation + 1 }); }
    for (const t of this.store.all('task')) if (t.state === 'awaiting_candidate') { const c = this.store.all('change', t.owner).find(c => c.task === t.id); this.store.put('task', { ...t, state: c ? 'awaiting_review' : 'interrupted', ...(c ? { change: c.id } : { error: '生成候选时服务中断，未自动重发。' }) }); }
    for(const projectId of this.workspaces.keys())for(const user of this.store.all('user'))this.fixedChat(user,projectId);
    for(const c of this.store.all('model-call').filter(c=>c.native&&['queued','pending'].includes(c.state)))this.store.put('model-call',{...c,state:c.state==='queued'?'cancelled_before_send':'unconfirmed',reservedUsd:c.state==='queued'?0:c.reservedUsd,finished:now(),error:c.state==='queued'?'服务重启，排队请求尚未发送':'服务重启，请在后台核对原调用用量'});
    this.native=new NativeHarness(this.store,this.catalog,p=>this.workspace(p),undefined,this.textQueue);this.native.projectSurface=options.nativeProjectSurface===true;
    this.incidents=new Incidents(this,options.incidents);
    this.native.team.issueReporter=(user,project,body)=>this.incidents.report(user,project,undefined,body);
    const handler = (req: IncomingMessage, res: ServerResponse) => { this.route(req, res).catch(e => { if (!res.headersSent) this.json(res, e instanceof Problem ? e.status : 500, { error: e instanceof Problem ? e.message : '服务器操作失败，操作未确认完成' }); else res.end(); if (!(e instanceof Problem)) console.error('request_error', e instanceof Error ? e.message : 'unknown'); }); };
    this.handler=handler;
    this.server = options.tls ? createHttpsServer({ key: readFileSync(options.tls.key), cert: readFileSync(options.tls.cert), minVersion: 'TLSv1.2' }, handler) : createServer(handler);
    if(options.mediaWorker)this.mediaWorker=new MediaWorkerManager(this.store,{simulated:options.simulatedVideo,fixtureModule:options.workerFixtureModule});
    this.nativeUpgrade(this.server);
    this.server.headersTimeout = 10000; this.server.requestTimeout = 30000; this.server.keepAliveTimeout = 5000;
  }
  nativeUpgrade(server:any){const sockets=new Set<Socket>();this.listenerSockets.set(server,sockets);server.on('connection',(socket:Socket)=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});server.on('upgrade',(req:IncomingMessage,socket:any,head:Buffer)=>{void(async()=>{this.trustedRelay.context(req);const url=new URL(req.url??'/',`http://${req.headers.host}`),match=url.pathname.match(/^\/harness\/([^/]+)(\/.*)$/);requireThat(match&&req.headers.origin===`http${this.options.tls?'s':''}://${req.headers.host}`,'原生流来源无效',403);const permittedHosts=new Set(['127.0.0.1','localhost','[::1]',...this.additionalHosts,...(process.env.PLATFORM_ALLOWED_HOSTS??'').split(',').filter(Boolean)]);requireThat(permittedHosts.has(url.hostname),'此主机名未配置为平台入口',403);const target=this.nativeTarget(req,match[1]);await this.native.upgrade(req,socket,head,{...target,csrf:target.auth.csrf},match[2],'/harness/'+match[1],()=>{try{this.nativeTarget(req,match[1]);return true;}catch{return false;}});})().catch(()=>socket.destroy());});}
  private settingsRequests=new WeakSet<IncomingMessage>();
  nativeTickets=new Map<string,{user:string;auth:string;csrf:string;expires:number;project?:string;member?:string}>();
  nativeAuth(req:IncomingMessage,nativeOnly=false):{user:Doc;auth:Doc;grant?:{project?:string;member?:string}}{
    try{if(nativeOnly)throw new Error();return this.authenticate(req);}catch{
      const cookies=(req.headers.cookie??'').split(';').map(v=>v.trim());const token=cookies.find(v=>v.startsWith(this.nativeCookieName+'='))?.slice(this.nativeCookieName.length+1)??cookies.find(v=>v.startsWith('team_native='))?.slice(12);
      const saved=token?this.nativeTickets.get(token):undefined,auth=saved&&this.store.db.prepare('SELECT * FROM auth WHERE token=?').get(saved.auth) as any,user=auth&&this.store.get('user',auth.user_id);
      requireThat(saved&&auth&&auth.expires>Date.now()&&user?.active&&user.accountGatewayAllowed!==false,'原生登录已过期',401);
      if(saved.member)requireThat(user.role==='admin'&&this.store.get('user',saved.member)?.active,'成员聊天访问已失效',403);
      if(!['GET','HEAD'].includes(req.method??'GET'))requireThat(req.headers['x-csrf-token']===auth.csrf,'请求校验失败',403);
      return {user,auth,grant:saved};
    }
  }
  nativeOwner(viewer:Doc,project:string,member?:string){
    this.workspace(project);if(!member)return viewer;
    this.admin(viewer);requireThat(/^[a-f0-9-]{36}$/.test(member),'成员编号无效',400);
    const owner=this.store.get('user',member);requireThat(owner?.active,'成员已停用或不存在',403);return owner;
  }
  nativeTarget(req:IncomingMessage,segment:string){
    const match=/^(shared|[a-f0-9-]{36})(?:~([a-f0-9-]{36}))?$/.exec(segment);requireThat(match,'项目入口无效',400);
    const {user:viewer,auth,grant}=this.nativeAuth(req),project=match[1],member=match[2];
    if(grant?.member)requireThat(grant.project===project&&grant.member===member,'成员聊天入口不匹配',403);
    const user=this.nativeOwner(viewer,project,member);
    return {user,viewer,auth,project,scope:viewer.id+':'+project+(member?':'+member:'')};
  }
  async start(port = 4317, bind = '127.0.0.1') {
    if (bind !== '127.0.0.1') {
      requireThat(this.store.all('user').some(u => u.active && u.role === 'admin'), '局域网开放需先设置有效超级管理员');
      requireThat(this.options.tls || this.options.allowLanHttp && privateIPv4(bind), 'HTTP 局域网模式需由服务器明确开启，且只能绑定具体私网 IPv4');
    }
    for(const ws of this.workspaces.values())await this.startWorkspace(ws); this.sandboxReady = await sandboxAvailable(); await new Promise<void>((resolve, reject) => { this.server.once('error', reject); this.server.listen(port, bind, () => resolve()); }); if(this.mediaWorker)await this.mediaWorker.start();for(const ws of this.workspaces.values()){ws.pickups.start();ws.images.start();ws.assembly.start();} this.pump();this.operationsMonitor.start();this.incidents.start(); return (this.server.address() as any).port as number;
  }
  async close(options:{keepMediaWorker?:boolean}={}) {
    this.closing = true;this.operationsMonitor.close();const contentClosing=Promise.all([...this.workspaces.values()].map(ws=>ws.content.close()));
    await this.incidents.close();await this.native.close();await this.mediaWorker?.close(options.keepMediaWorker);
    const servers=[this.server,...this.additionalServers];
    const disconnected = Promise.all(servers.map(s=>new Promise<void>(r => s.close(() => r()))));
    for(const s of servers)s.closeIdleConnections();
    const drain = setTimeout(() => {for(const s of servers)s.closeAllConnections();}, 2000);
    for (const c of this.active.values()) c.abort();
    await new Promise<void>(r => { const timer = setInterval(() => { if (!this.active.size) { clearInterval(timer); r(); } }, 20); });
    await contentClosing;for(const ws of this.workspaces.values()){await ws.assembly.close();await ws.images.close();await ws.pickups.close();await ws.host.close();} await this.catalog.magpie.close();await disconnected; clearTimeout(drain); this.store.close();
  }
  async addLanListener(bind:string,port=(this.server.address() as any)?.port) {
    requireThat(this.server.listening&&!this.closing&&this.options.allowLanHttp&&!this.options.tls,'附加入口只用于已经启动的显式 HTTP 局域网服务');
    requireThat(bind==='127.0.0.1'||privateIPv4(bind),'附加入口只能绑定具体私网 IPv4');
    requireThat(this.store.all('user').some(u=>u.active&&u.role==='admin'),'局域网开放需先设置有效超级管理员');
    const server=createServer(this.handler);this.nativeUpgrade(server);server.headersTimeout=10000;server.requestTimeout=30000;server.keepAliveTimeout=5000;
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(port,bind,resolve);});
    const actualPort=(server.address() as any).port as number;
    this.additionalHosts.add(bind);this.additionalServers.push(server);this.lanListeners.set(`${bind}:${actualPort}`,server);return actualPort;
  }
  async removeLanListener(bind:string,port:number) {
    const key=`${bind}:${port}`,server=this.lanListeners.get(key);
    if(!server)return;
    this.lanListeners.delete(key);this.additionalServers=this.additionalServers.filter(s=>s!==server);
    if(![...this.lanListeners.keys()].some(k=>k.startsWith(bind+':')))this.additionalHosts.delete(bind);
    // Close only the vanished network socket. Workers, storage and the loopback listener stay alive.
    const closed=new Promise<void>(r=>server.close(()=>r()));server.closeIdleConnections();
    const drain=setTimeout(()=>{server.closeAllConnections();for(const socket of this.listenerSockets.get(server)??[])socket.destroy();},250);
    await closed;clearTimeout(drain);
  }
  async startWorkspace(ws:Workspace){
    if(ws.host.ready)return;
    if(!ws.initializing)ws.initializing=ws.host.init().then(()=>{if(this.server?.listening&&!this.closing){ws.pickups.start();ws.images.start();ws.assembly.start();this.pump();}}).catch(async e=>{await ws.host.close();ws.host=new HarnessHost(ws.store,ws.projects,this.options.mockDelay,this.options.model,this.catalog);if(ws.projects.projectId==='shared')this.host=ws.host;throw e;}).finally(()=>{ws.initializing=undefined;});
    await ws.initializing;
  }
  workspace(projectId='shared'):Workspace {const ws=this.workspaces.get(projectId);requireThat(ws,'项目不存在，请刷新项目列表',404);return ws;}
  addWorkspace(projectId:string,initial?:Doc):Workspace {
    requireThat(projectId==='shared'||/^[a-f0-9-]{36}$/.test(projectId),'项目编号无效',400);
    const store=this.store.scoped(projectId),projects=new Projects(store,projectId,initial),pickups=new Pickups(store,projects,this.options.videoAdapter,this.options.simulatedVideo,this.options.videoConcurrency,!this.options.mediaWorker);
    const images=new ImageGeneration(store,projects,pickups.catalog,pickups.media,pickups.storage,this.options.imageAdapter,this.options.simulatedVideo,!this.options.mediaWorker),host=new HarnessHost(store,projects,this.options.mockDelay,this.options.model,this.catalog);
    const uploads=new ProjectUploads(store,projects,pickups.media);const attachments=new NativeAttachments(store,()=>this.native.history);const currentSkill=()=>privateSkillDefinitionStatus(this.native?.codeRoot);const content=new ProjectContent(store,projects,documentText,attachments,currentSkill);const assembly=new EpisodeAssembly(store,pickups.media,projects,currentSkill);const links=new ProjectLinks(store,projects,content,pickups.media);const ws={store,projects,pickups,images,host,uploads,content,assembly,attachments,links};this.workspaces.set(projectId,ws);return ws;
  }
  async createProject(user:Doc,b:Doc){
    this.admin(user);const p=this.store.get('project-create-preview',b.previewId);requireThat(p&&p.owner===user.id&&p.digest===b.digest,'项目预览不存在或已改变',409);
    const existing=this.store.get('project',p.projectId);
    if(existing){requireThat(existing.creationPreview===p.id,'项目编号冲突',409);for(const u of this.store.all('user'))this.fixedChat(u,p.projectId);await this.startWorkspace(this.workspace(p.projectId));return this.publicProject(p.projectId);}
    this.projects.directoryPath(p.path,true);requireThat(!this.store.all('project').some(v=>v.name.normalize('NFC').toLocaleLowerCase()===p.name.normalize('NFC').toLocaleLowerCase()),'项目名称已存在',409);
    const stable=(v:Doc)=>JSON.stringify(Object.entries(v).sort());requireThat(stable(this.projects.scan(p.path))===stable(p.manifest),'目录在预览后已修改，请重新预览',409);
    const ws=this.addWorkspace(p.projectId,p);for(const u of this.store.all('user'))this.fixedChat(u,p.projectId);
    this.store.tx(()=>{this.store.put('project-create-preview',{...p,state:'created',createdProject:p.projectId});this.store.event('*','project.created',{id:p.projectId,name:p.name});this.store.audit(user.id,'project.create',p.projectId,{path:p.path,files:p.files,allMembers:true});});
    await this.startWorkspace(ws);return this.publicProject(p.projectId);
  }
  async createManagedProject(user:Doc,b:Doc){
    const p=this.projects.previewManaged(user,b.name,b.requestId),existing=this.store.get('project',p.projectId);
    if(existing){requireThat(existing.managed&&existing.creationPreview===p.id,'项目编号冲突',409);const ws=this.workspaces.get(p.projectId)??this.addWorkspace(p.projectId);requireThat(ws.projects.canonical===this.projects.managedDirectory(p.projectId),'项目目录身份改变',409);this.finishManagedProject(user,p);await this.startWorkspace(ws);return this.publicProject(p.projectId);}
    requireThat(!this.store.all('project').some(v=>v.name.normalize('NFC').toLocaleLowerCase()===p.name.normalize('NFC').toLocaleLowerCase()),'项目名称已存在',409);
    requireThat(p.path===this.projects.managedDirectory(p.projectId),'项目目录身份改变',409);
    requireThat(Object.keys(this.projects.scan(p.path)).length===0,'新项目文件夹已有外部内容，请由管理员核对',409);
    const ws=this.addWorkspace(p.projectId,p);this.finishManagedProject(user,p);
    await this.startWorkspace(ws);return this.publicProject(p.projectId);
  }
  finishManagedProject(user:Doc,p:Doc){
    for(const u of this.store.all('user'))this.fixedChat(u,p.projectId);
    this.store.tx(()=>{const current=this.store.get('project-create-preview',p.id)!;if(current.state==='created')return;this.store.put('project-create-preview',{...current,state:'created',createdProject:p.projectId});this.store.event('*','project.created',{id:p.projectId,name:p.name,createdBy:user.id});this.store.audit(user.id,'project.create',p.projectId,{mode:'managed',files:0,allMembers:true});});
  }
  release() { return this.store.get('release', this.store.get('config', 'active')!.release)!; }
  get nativeCookieName() { return 'team_native_'+this.serverId.replaceAll('-',''); }
  get browserCookieName() { return 'team_account_'+this.serverId.replaceAll('-',''); }
  get cookieName() { return this.options.tls ? 'team_session' : 'team_session_http'; }
  publicUser(u: Doc) { return { id: u.id, username: u.username, name: u.name, role: u.role, active: u.active, created: u.created }; }
  json(res: ServerResponse, status: number, body: unknown) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body,this.billingResponses.has(res)?undefined:publicResponse)); }
  async body(req: IncomingMessage) { const chunks: Buffer[] = []; let size = 0; for await (const c of req) { size += c.length; requireThat(size <= (['/api/image-assets','/api/admin/operations/recover'].includes(req.url?.split('?')[0]??'')?34:2) * 1024 * 1024, '请求过大', 413); chunks.push(c); } try { requireThat(!this.closing, '服务器正在停止，请稍后重试', 503); const b = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); requireThat(b && typeof b === 'object' && !Array.isArray(b), '请求格式错误'); if (!['/api/setup', '/api/login'].includes((req.url ?? '').split('?')[0])) this.authenticate(req); return b as Doc; } catch (e) { if (e instanceof Problem) throw e; throw new Problem(400, '无效 JSON'); } }
  authenticate(req: IncomingMessage):{user:Doc;auth:Doc} {
    if(this.settingsRequests.has(req))return this.nativeAuth(req,true);
    if(this.options.mobilePrototype && req.url?.startsWith("/api/mobile/") && req.headers.authorization) return new MobileIdentity(this.store,this.serverId).authenticate(req);
    const prefix = `${this.cookieName}=`;
    const cookies=(req.headers.cookie??'').split(';').map(x=>x.trim());
    const token=cookies.find(x=>x.startsWith(this.browserCookieName+'='))?.slice(this.browserCookieName.length+1)??cookies.find(x=>x.startsWith(prefix))?.slice(prefix.length);
    requireThat(token, '请先登录', 401); const auth = this.store.db.prepare('SELECT * FROM auth WHERE token=?').get(hash(token)) as any;
    const user = auth && this.store.get('user', auth.user_id); requireThat(auth && auth.expires > Date.now() && user?.active && user.accountGatewayAllowed!==false, '登录已过期或账号已停用', 401);
    if (['GET', 'HEAD'].includes(req.method!) && req.url?.split('?')[0] !== '/api/me' && req.headers['x-csrf-token']) requireThat(req.headers['x-csrf-token'] === auth.csrf, '登录状态已变更，请刷新页面', 401);
    if (!['GET', 'HEAD'].includes(req.method!)) requireThat(req.headers['x-csrf-token'] === auth.csrf, '请求校验失败，请重新登录', 403);
    return { user: user!, auth };
  }
  owner(kind: string, objectId: string, user: Doc, store=this.store) { const obj = store.get(kind, objectId); requireThat(obj && (obj.owner === user.id || user.role === 'admin'), '对象不存在或无权限', 404); return obj; }
  admin(user: Doc) { requireThat(user.role === 'admin', '仅超级管理员可操作', 403); }
  fields(body: Doc, allowed: string[]) { requireThat(Object.keys(body).every(k => allowed.includes(k)), '包含不允许的请求字段'); }
  loginWindow = new Map<string, { start: number; count: number }>();
  async route(req: IncomingMessage, res: ServerResponse):Promise<void|ServerResponse> {
    requireThat(!this.closing, '服务器正在停止，请稍后重试', 503);
    const relay = this.trustedRelay.context(req);
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Frame-Options', 'DENY');
    if (this.options.tls) res.setHeader('Strict-Transport-Security', 'max-age=86400');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const proto = this.options.tls ? 'https' : 'http'; const base = `${proto}://${req.headers.host}`;
    const url = new URL(req.url ?? '/', base); const path = url.pathname; const method = req.method ?? 'GET';
    const permittedHosts = new Set(['127.0.0.1', 'localhost', '[::1]', ...this.additionalHosts, ...(process.env.PLATFORM_ALLOWED_HOSTS ?? '').split(',').filter(Boolean)]);
    requireThat(permittedHosts.has(new URL(base).hostname), '此主机名未配置为平台入口', 403);
    if(path==='/api/account-entry/accept')return acceptAccountBrowser(this,req,res,relay);
    if(path==='/api/account-access/bridge')return accountAccessBridge(this,req,res);
    if (!['GET', 'HEAD'].includes(method)) requireThat(req.headers.origin === base && !(req.headers['sec-fetch-site'] === 'cross-site'), '请求来源不匹配', 403);
    const nativePath=path.match(/^\/harness\/([^/]+)(\/.*)$/);
    if(nativePath){const ticket=url.searchParams.get('ticket');if(ticket){const saved=this.nativeTickets.get(ticket);requireThat(saved&&saved.expires>Date.now(),'原生登录入口已过期',401);requireThat(!saved.project||nativePath[1]===saved.project+(saved.member?'~'+saved.member:''),'原生入口不匹配',403);saved.expires=0;const cookie=randomBytes(32).toString('hex');this.nativeTickets.set(cookie,saved);this.nativeTickets.delete(ticket);res.setHeader('Set-Cookie',`${this.nativeCookieName}=${cookie}; HttpOnly; SameSite=Strict; Path=${saved.member?'/harness/'+nativePath[1]+'/':'/harness/'}${this.options.tls?'; Secure':''}`);res.writeHead(302,{Location:path});return res.end();}const target=this.nativeTarget(req,nativePath[1]);const {user,auth,project}=target;res.setHeader("X-Wawu-Server",this.serverId);res.setHeader("X-Wawu-Account",user.id);
    if(nativePath[2].startsWith('/team-settings/')){
     const prefix='/harness/'+nativePath[1]+'/team-settings',inner=nativePath[2].slice('/team-settings'.length);
     if(inner.startsWith('/api/')){requireThat(!['/api/setup','/api/login','/api/logout','/api/native/open'].includes(inner),'设置接口无效',404);url.searchParams.set('project',project);this.settingsRequests.add(req);req.url=inner+'?'+url.searchParams;return this.route(req,res);}
     requireThat(['GET','HEAD'].includes(method),'请求方法无效',405);const rel=inner==='/'?'index.html':decodeURIComponent(inner.slice(1));requireThat(rel==='index.html'||/^assets\/[a-zA-Z0-9_.-]+$/.test(rel),'设置资源不存在',404);
     const file=join(this.options.staticDir??'',rel);requireThat(this.options.staticDir&&existsSync(file),'设置页面尚未构建',404);
     res.removeHeader('X-Frame-Options');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'self' team:; object-src 'none'");
     const mime=rel.endsWith('.js')?'application/javascript':rel.endsWith('.css')?'text/css':rel.endsWith('.svg')?'image/svg+xml':'text/html';res.setHeader('Content-Type',mime+'; charset=utf-8');res.setHeader('Cache-Control','no-store');
     let body=readFileSync(file);if(rel==='index.html')body=Buffer.from(body.toString().replaceAll('/assets/',prefix+'/assets/'));return res.end(method==='HEAD'?undefined:body);
    }
    return this.native.proxy(req,res,{...target,csrf:auth.csrf,authorized:()=>{try{this.nativeTarget(req,nativePath[1]);return true;}catch{return false;}}},nativePath[2]+url.search,'/harness/'+nativePath[1]);}
    const providerReference=path.match(/^\/api\/provider-reference\/([a-f0-9]{48})$/);
    if(providerReference&&['GET','HEAD'].includes(method)){
      return this.providerReferences.serve(req,res,providerReference[1]);
    }
    if (path === '/api/status' && method === 'GET') return this.json(res, 200, { version: '0.7.2', accountPortal:accountAccessConfig(this) ? accountAccessConfig(this)!.gateway.replace(/\/$/,'')+'/account-api/portal' : undefined, protocol: { min: 1, max: 1 }, capabilities: [...(this.options.nativeProjectSurface?['native-project-surface']:[]),...(this.options.nativeOnly?['native-only-chat']:[]),'incident-reports','request-lookup', 'event-resume', 'video-pickups', 'video-catalog', 'image-generation', 'xiaopei-directory', 'private-media', 'fixed-project-chat','harness-chat','multi-session-chat','chat-model-selection','skill-selection','chat-queue','native-harness', 'project-directory', 'multiple-projects','member-project-create','project-attachments','project-chat-files','project-content-pages','host-files'], serverId: this.serverId, transport: relay || this.options.tls ? 'https' : 'http', loginRequired: true, serverInstance: this.instanceId, stage: 'foundation', needsSetup: this.store.all('user').length === 0, runtime: 'DeepSeek Harness 0.2.0-rc.2', modelMode: this.options.model ? 'online' : 'mock', onlineModel: this.options.model ? this.options.model.model : 'not_configured', onlineBudgetEnabled: true, budgetMode: 'unlimited', sandbox: this.sandboxReady, pilotConnected: false, videoMode:this.options.simulatedVideo?'simulated':'admin_configured', videoConcurrency:this.pickups.maxConcurrency, textConcurrency:this.options.concurrency??4 });
    if (path === '/api/setup' && method === 'POST') {
      requireThat(!relay&&['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? ''), '初始化仅限服务器本机', 403);
      requireThat(this.store.all('user').length === 0, '管理员已初始化', 409); const b = await this.body(req); requireThat(this.store.all('user').length === 0, '管理员已初始化', 409); const user = this.newUser(b, 'admin'); this.store.audit(user.id, 'platform.setup', user.id); return this.json(res, 201, this.publicUser(user));
    }
    if (path === '/api/login' && method === 'POST') {
      const key = relay ? 'relay:'+relay.clientAddress : req.socket.remoteAddress ?? ''; let limit = this.loginWindow.get(key); if (!limit || Date.now() - limit.start > 60000) { limit = { start: Date.now(), count: 0 }; this.loginWindow.set(key, limit); }
      requireThat(++limit.count <= 30, '登录尝试过于频繁，请稍后再试', 429); const b = await this.body(req);
      const users=this.store.all('user'),normalized=typeof b.username==='string'?b.username.normalize('NFC'):'';
      const aliases=users.filter(u=>u.username.normalize('NFC')===normalized);
      const user = users.find(u => u.username === b.username)??(aliases.length===1?aliases[0]:undefined); const valid = verifyPassword(String(b.password ?? ''), user?.password ?? passwordHash('invalid-fixture-password'));
      requireThat(user?.active && user.accountGatewayAllowed!==false && !user.accountGatewayShadow && valid, '账号或密码错误', 401);
      const token = randomBytes(32).toString('hex'); const csrf = randomBytes(24).toString('hex');
      this.store.db.prepare('INSERT INTO auth VALUES(?,?,?,?)').run(hash(token), user.id, csrf, Date.now() + 12 * 3600000);
      res.setHeader('Set-Cookie', `${this.cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${this.options.tls ? '; Secure' : ''}`);
      this.store.audit(user.id, 'auth.login', user.id); return this.json(res, 200, { user: this.publicUser(user), csrf });
    }
    if (this.options.mobilePrototype && path.startsWith('/api/mobile/')) return (this.mobileGateway ??= new MobileGateway(this)).route(req,res,url);
    if (path.startsWith('/api/')) {
      const { user, auth } = this.authenticate(req);
      res.setHeader("X-Wawu-Server",this.serverId);res.setHeader("X-Wawu-Account",user.id);
      if(path.startsWith('/api/host-files')){
       this.admin(user);
       const files=hostFiles(this.store),verify=()=>{const current=this.authenticate(req).user;requireThat(current.id===user.id,'登录身份已变化',401);};
       if(method==='DELETE')throw new Problem(403,'成员不能删除主机文件');
       if(path==='/api/host-files'&&method==='GET')return this.json(res,200,await files.list(user,Object.fromEntries(url.searchParams)));
       if(path==='/api/host-files/text'&&method==='GET')return this.json(res,200,await files.text(user,url.searchParams.get('path')));
       if(path==='/api/host-files/history'&&method==='GET')return this.json(res,200,{items:await files.revisions(user,url.searchParams.get('path'))});
       if(path==='/api/host-files/content'&&['GET','HEAD'].includes(method))return files.stream(user,url.searchParams.get('path'),req,res,()=>{try{verify();return true;}catch{return false;}},url.searchParams.get('download')==='1');
       if(path==='/api/host-files/action'&&method==='POST'){const b=await this.body(req);return this.json(res,200,await files.action(this.authenticate(req).user,b));}
       if(path==='/api/host-files/bundle'&&method==='POST'){const b=await this.body(req);requireThat(Array.isArray(b.paths)&&b.paths.length>0&&b.paths.every((p:unknown)=>typeof p==='string'),'请选择文件');const receipt={id:id(),owner:user.id,paths:b.paths,expires:Date.now()+30*60000};this.store.put('host-bundle',receipt);return this.json(res,201,{id:receipt.id});}
       if(path==='/api/host-files/bundle'&&['GET','HEAD'].includes(method)){if(url.searchParams.has('selection')){const receipt=this.store.get('host-bundle',url.searchParams.get('selection')!);requireThat(receipt&&receipt.owner===user.id&&receipt.expires>Date.now(),'下载选择已过期，请重新点击',410);return files.bundle(user,receipt.paths,res,verify,method==='HEAD');}let paths;try{paths=JSON.parse(url.searchParams.get('paths')??'[]');}catch{throw new Problem(400,'打包选择无效');}return files.bundle(user,paths,res,verify,method==='HEAD');}
       if(path==='/api/host-files/uploads'&&method==='GET')return this.json(res,200,this.store.all('host-upload',user.id).filter(u=>u.state==='receiving'));
       if(path==='/api/host-files/uploads'&&method==='POST')return this.json(res,201,await files.upload(this.authenticate(req).user,await this.body(req)));
       const transfer=path.match(/^\/api\/host-files\/uploads\/([a-f0-9]{64})(?:\/(chunk|complete))?$/);
       if(transfer&&method==='GET')return this.json(res,200,files.owned(user,transfer[1]));
       if(transfer&&method==='POST'){const b=await this.body(req);verify();if(transfer[2]==='chunk')return this.json(res,200,await files.chunk(user,transfer[1],b));if(transfer[2]==='complete')return this.json(res,200,await files.finish(user,transfer[1]));}
       throw new Problem(405,'此文件操作不支持；成员不能删除主机文件');
      }
      if(path.startsWith('/api/admin/')){this.admin(user);this.billingResponses.add(res);}
      if(path==='/api/admin/account-host-access'&&method==='GET')return this.json(res,200,await accountGatewayCall(this,{action:'list',actor:user.id}));
      if(path==='/api/admin/account-host-access'&&method==='POST'){const b=await this.body(req);this.fields(b,['accountId','hosts','defaultHost']);const result=await accountGatewayCall(this,{action:'update',actor:user.id,...b});this.store.audit(user.id,'account.host.assign',b.accountId,{hosts:b.hosts,defaultHost:b.defaultHost,pending:result.pending});return this.json(res,200,result);}
      if(path==='/api/admin/account-host-access/refresh'&&method==='POST'){await this.body(req);return this.json(res,200,await accountGatewayCall(this,{action:'refresh',actor:user.id}));}
      if(path==='/api/incidents'&&method==='GET')return this.json(res,200,this.incidents.list(user,url.searchParams.get('project')??'shared',url.searchParams.get('member')??undefined,url.searchParams.get('session')??undefined));
      if(path==='/api/incidents'&&method==='POST'){const b=await this.body(req);this.fields(b,['requestId','description','session','task','client','attachments']);return this.json(res,202,this.incidents.report(user,url.searchParams.get('project')??'shared',url.searchParams.get('member')??undefined,b));}
      if(path==='/api/incident-attachments'&&method==='POST'){const b=await this.body(req);this.fields(b,['name','data']);return this.json(res,201,this.incidents.upload(user,url.searchParams.get('project')??'shared',url.searchParams.get('member')??undefined,b));}
      if(path==='/api/admin/incidents'&&method==='GET')return this.json(res,200,{items:this.incidents.list(user),status:this.incidents.status()});
      if(path==='/api/admin/incidents/settings'&&method==='POST'){const b=await this.body(req);this.fields(b,['enabled','autoFailures','concurrency']);return this.json(res,200,this.incidents.configure(user,b));}
      const incidentPath=path.match(/^\/api\/incidents\/([a-f0-9-]{36})(?:\/(supplement|cancel|retry|client-check))?$/);
      if(incidentPath){const i=this.incidents.owned(user,incidentPath[1]);if(method==='GET'&&!incidentPath[2])return this.json(res,200,this.incidents.public(i,user.role==='admin'));if(method==='POST'){const b=await this.body(req);if(incidentPath[2]==='client-check'){this.fields(b,['nonce','loaded']);return this.json(res,200,this.incidents.clientCheck(user,i.id,b));}if(incidentPath[2]==='supplement'){this.fields(b,['text']);return this.json(res,202,this.incidents.supplement(user,i.id,b));}this.fields(b,[]);if(incidentPath[2]==='cancel')return this.json(res,200,this.incidents.cancel(user,i.id));if(incidentPath[2]==='retry')return this.json(res,202,this.incidents.retry(user,i.id));}}
      const evidencePath=path.match(/^\/api\/admin\/incidents\/([a-f0-9-]{36})\/evidence\/([a-f0-9-]{36})\/(.+)$/);
      if(evidencePath&&method==='GET')return this.incidents.serveEvidence(user,evidencePath[1],evidencePath[2],evidencePath[3],req,res);
      if(path==='/api/workspace-navigation'&&method==='GET')return this.json(res,200,await this.native.history.navigation(user));
      if(path==='/api/admin/native-chats'&&method==='GET'){const project=url.searchParams.get('project')??'shared';this.workspace(project);return this.json(res,200,await this.native.history.list(user,project));}
      const historyPath=path.match(/^\/api\/admin\/native-chats\/([a-f0-9-]{36})\/(session-[a-zA-Z0-9-]+)(?:\/attachments\/(\d+)\/(\d+))?$/);
      if(historyPath&&['GET','HEAD'].includes(method)){const project=url.searchParams.get('project')??'shared';this.workspace(project);if(historyPath[3])return this.native.history.attachment(user,project,historyPath[1],historyPath[2],Number(historyPath[3]),Number(historyPath[4]),req,res);requireThat(method==='GET','请求方法无效',405);return this.json(res,200,await this.native.history.page(user,project,historyPath[1],historyPath[2],url.searchParams));}
      if(path==='/api/admin/audit-log'&&method==='GET')return this.json(res,200,auditLog(this.store,url.searchParams));
      if(path==='/api/admin/operations/trace'&&method==='GET')return this.json(res,200,taskTrace(this.store,url.searchParams.get('kind')??'',url.searchParams.get('id')??''));
      if(path==='/api/admin/operations'&&method==='GET')return this.json(res,200,operations(this,url.searchParams));
      if(path==='/api/admin/operations/recover'&&method==='POST'){const b=await this.body(req);this.fields(b,['kind','id','action','remoteTaskId','evidence','outcome','receipt']);return this.json(res,200,await recoverOperation(this,user,b));}
      if(path==='/api/admin/operations/catalog'&&method==='POST'){const b=await this.body(req);this.fields(b,['fingerprint']);return this.json(res,200,normalizeCatalog(this,user,b.fingerprint));}
      if(path==='/api/admin/operations/idle'&&method==='POST'){const b=await this.body(req);this.fields(b,['idleMinutes']);requireThat(Number.isInteger(b.idleMinutes)&&(b.idleMinutes===0||b.idleMinutes>=5&&b.idleMinutes<=1440),'休眠时间须为 5–1440 分钟，0 表示关闭');const setting={id:'active',idleMinutes:b.idleMinutes,updated:now()};this.store.put('native-runtime-policy',setting);this.store.audit(user.id,'native.idle_policy','active',setting);return this.json(res,200,setting);}
      if(path==='/api/admin/billing'&&method==='GET')return this.json(res,200,new Billing(this.store,this.catalog).list(user,{from:url.searchParams.get('from')??'',to:url.searchParams.get('to')??'',details:url.searchParams.get('details')==='1'}));
      if(path==='/api/admin/billing/prices/verify'&&method==='POST'){const b=await this.body(req);return this.json(res,200,new Billing(this.store,this.catalog).reviewPrice(this.authenticate(req).user,b));}
      if(path==='/api/admin/billing/models/reconcile'&&method==='POST'){const b=await this.body(req);return this.json(res,200,new Billing(this.store,this.catalog).reconcileModel(this.authenticate(req).user,b));}
      if(path==='/api/admin/billing/reconcile'&&method==='POST'){const b=await this.body(req);return this.json(res,200,new Billing(this.store,this.catalog).reconcile(this.authenticate(req).user,b));}
      if(path==='/api/admin/concurrency'&&method==='GET'){this.admin(user);return this.json(res,200,{text:this.options.concurrency,video:this.options.videoConcurrency,image:imageCapacity(this.store),max:MAX_CONCURRENCY,queueCapacity:MAX_PENDING_TASKS,testedText:this.store.get('runtime-concurrency','active')?.testedText??96,effectiveText:this.textQueue.limit,...videoCapacity(this.store,this.options.videoConcurrency!),channels:this.store.all('video-channel').map(c=>({id:c.id,name:c.name,...channelCapacity(this.store,c.id)}))});}
      if(path==='/api/admin/concurrency'&&method==='POST'){
        this.admin(user);const b=await this.body(req);this.fields(b,['text','video','image','testedText','testedVideo','testedChannels']);const previous=this.store.get('runtime-concurrency','active');const testedVideo=concurrencyValue(b.testedVideo??previous?.testedVideo??1),testedChannels={...previous?.testedChannels};
        if(b.testedChannels!==undefined){requireThat(b.testedChannels&&typeof b.testedChannels==='object'&&!Array.isArray(b.testedChannels),'渠道执行阈值格式无效');for(const [key,value] of Object.entries(b.testedChannels)){const channel=this.store.get('video-channel',key);requireThat(channel,'渠道不存在',404);testedChannels[key]={limit:concurrencyValue(value),revision:channel.revision};}}
        const testedText=concurrencyValue(b.testedText??this.store.get('runtime-concurrency','active')?.testedText??96);const text=concurrencyValue(b.text),video=concurrencyValue(b.video),image=concurrencyValue(b.image??imageCapacity(this.store));
        this.store.put('runtime-concurrency',{...previous,id:'active',text,video,image,testedText,testedVideo,testedChannels,updated:now()});this.options.concurrency=text;this.options.videoConcurrency=video;this.textQueue.setLimit(Math.min(text,testedText));
        for(const ws of this.workspaces.values())ws.pickups.maxConcurrency=video;
        this.store.audit(user.id,'concurrency.update','active',{text,video,image,testedText,testedVideo,testedChannels});this.pump();for(const ws of this.workspaces.values()){ws.pickups.pump();ws.images.pump();}
        return this.json(res,200,{text,video,image,max:MAX_CONCURRENCY,queueCapacity:MAX_PENDING_TASKS,testedText:this.store.get('runtime-concurrency','active')?.testedText??96,effectiveText:this.textQueue.limit,...videoCapacity(this.store,video),channels:this.store.all('video-channel').map(c=>({id:c.id,name:c.name,...channelCapacity(this.store,c.id)}))});
      }
      if (path === '/api/me' && method === 'GET') return this.json(res, 200, { user: this.publicUser(user), csrf: auth.csrf });
      if (path === '/api/logout' && method === 'POST') { this.store.db.prepare('DELETE FROM auth WHERE token=?').run(auth.token); res.setHeader('Set-Cookie', [this.cookieName,this.browserCookieName].map(name=>`${name}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${this.options.tls||relay ? '; Secure' : ''}`)); return this.json(res, 200, { ok: true }); }
      if(path==='/api/gallery'&&method==='GET')return this.json(res,200,await mediaGallery(this,user,url.searchParams));
      if(path==='/api/gallery/bundle'&&method==='POST'){const b=await this.body(req);this.fields(b,['mode','ids']);return this.json(res,200,await prepareGalleryBundle(this,user,url.searchParams,req,b));}
      if(path==='/api/gallery/bundle'&&['GET','HEAD'].includes(method)){try{return await serveGalleryBundle(this,user,url.searchParams,req,res);}catch(e){if(!res.headersSent&&method==='HEAD')res.setHeader('X-Gallery-Error',encodeURIComponent(e instanceof Problem?e.message:'打包准备失败，请稍后重试'));throw e;}}
      if(path==='/api/gallery/attachment'&&['GET','HEAD'].includes(method))return this.native.history.galleryAttachment(user,url.searchParams,req,res);
      if(path==='/api/member-submissions'&&method==='GET')return this.json(res,200,memberSubmissions(this.store,user,url.searchParams,await this.native.history.submissions(user)));
      if(path==='/api/projects'&&method==='GET')return this.json(res,200,this.store.all('project').map(p=>this.publicProject(p.id)));
      if(path==='/api/projects'&&method==='POST'){const b=await this.body(req);this.fields(b,['name','requestId']);return this.json(res,201,await this.createManagedProject(this.authenticate(req).user,b));}
      if(path==='/api/admin/projects/preview'&&method==='POST'){this.admin(user);const b=await this.body(req);this.fields(b,['name','path']);return this.json(res,201,this.projects.previewNew(this.authenticate(req).user,b.path,b.name));}
      if(path==='/api/admin/projects'&&method==='POST'){this.admin(user);const b=await this.body(req);this.fields(b,['previewId','digest']);const p=await this.createProject(this.authenticate(req).user,b);return this.json(res,201,p);}
      const preview=path.match(/^\/api\/media\/([a-f0-9-]+)\/preview$/);
      if(preview&&['GET','HEAD'].includes(method)){const m=this.store.get('media',preview[1]);requireThat(m,'媒体不存在',404);return serveMediaPreview(this.workspace(m.project??'shared').pickups.media,req,res,preview[1],user,url.searchParams.get('variant')??'thumb');}
      const media=path.match(/^\/api\/media\/([a-f0-9-]+)$/);
      if(media&&['GET','HEAD'].includes(method)){const m=this.store.get('media',media[1]);requireThat(m,'媒体不存在',404);return this.workspace(m.project??'shared').pickups.media.serve(req,res,media[1],user);}
      const projectId=url.searchParams.get('project')??'shared';const {store,projects,pickups,images,host,uploads,content}=this.workspace(projectId);
      if(path==='/api/project-links'&&method==='GET')return this.json(res,200,this.workspace(projectId).links.read(user,{index_path:url.searchParams.get('index_path')??undefined,shot_id:url.searchParams.get('shot_id')??undefined,assignment_id:url.searchParams.get('assignment_id')??undefined,revision:url.searchParams.get('revision')??undefined,offset:url.searchParams.has('offset')?Number(url.searchParams.get('offset')):0}));
      if(path==='/api/project-links'&&method==='POST'){const b=await this.body(req);this.fields(b,['requestId','operation','index_path','revision','expected_index_sha256','shot_id','shot','assignment_id','assignment']);return this.json(res,200,await this.workspace(projectId).links.update(user,Object.fromEntries(Object.entries(b).filter(([key])=>key!=='requestId')),b.requestId));}
      if(path==='/api/video-assemblies'&&method==='GET')return this.json(res,200,this.workspace(projectId).assembly.list(user,url.searchParams.get('session')??undefined));
      if(path==='/api/video-assemblies'&&method==='POST'){const b=await this.body(req);this.fields(b,['session','requestId','name','episode','clips','width','height','fps']);return this.json(res,202,this.workspace(projectId).assembly.submit(user,b.session,b,b.requestId));}
      const assemblyMatch=path.match(/^\/api\/video-assemblies\/([a-f0-9-]{36})(?:\/(resume|cancel))?$/);
      if(assemblyMatch){const service=this.workspace(projectId).assembly;if(method==='GET'&&!assemblyMatch[2])return this.json(res,200,service.get(user,assemblyMatch[1]));if(method==='POST'&&assemblyMatch[2]){await this.body(req);return this.json(res,200,assemblyMatch[2]==='resume'?service.resume(user,assemblyMatch[1]):service.cancel(user,assemblyMatch[1]));}}
      const nativeAttachment=path.match(/^\/api\/native-attachments\/([a-f0-9]{64})\/(text|content)$/);
      if(nativeAttachment&&['GET','HEAD'].includes(method)){const service=this.workspace(projectId).attachments;if(nativeAttachment[2]==='text')return this.json(res,200,await service.read(user,nativeAttachment[1],Number(url.searchParams.get('offset')??0),Number(url.searchParams.get('limit')??24000)));const v=await service.original(user,nativeAttachment[1]);return this.native.history.galleryAttachment(user,new URLSearchParams({project:projectId,owner:v.item.owner,session:v.item.nativeSession,attachmentId:v.item.attachmentId,name:v.item.attachmentName,...(url.searchParams.has('download')?{download:'1'}:{})}),req,res);}
      if(path==='/api/project-content/page'&&method==='GET')return this.json(res,200,await content.page(user,{page:Number(url.searchParams.get('page')??1),limit:Number(url.searchParams.get('limit')??48),section:url.searchParams.get('section')??'all',episode:url.searchParams.get('episode')??'all',assetType:url.searchParams.get('assetType')??'all',query:url.searchParams.get('query')??'',revision:url.searchParams.get('revision')??undefined}));
      if(path==='/api/project-content'&&method==='GET')return this.json(res,200,await content.catalogue(user));
      if(path==='/api/project-content/search'&&method==='GET')return this.json(res,200,await content.search(user,{query:url.searchParams.get('query'),section:url.searchParams.get('section')??'all',episode:url.searchParams.get('episode')??'all',assetType:url.searchParams.get('assetType')??'all',offset:Number(url.searchParams.get('offset')??0),limit:Number(url.searchParams.get('limit')??20)}));
      if(path==='/api/uploads'&&method==='POST'){const b=await this.body(req);this.fields(b,['requestId','name','bytes','session']);return this.json(res,201,uploads.start(this.authenticate(req).user,b));}
      if(path==='/api/uploads'&&method==='GET')return this.json(res,200,store.all('file-upload',user.id).map(u=>uploads.public(u)));
      const upload=path.match(/^\/api\/uploads\/([a-f0-9]{32})(?:\/(chunk|complete|cancel))?$/);
      if(upload&&method==='GET'&&!upload[2])return this.json(res,200,uploads.public(uploads.owned(user,upload[1])));
      if(upload&&method==='POST'){const b=await this.body(req),u=this.authenticate(req).user;if(upload[2]==='chunk'){this.fields(b,['offset','base64']);return this.json(res,200,uploads.chunk(u,upload[1],b));}this.fields(b,[]);if(upload[2]==='complete')return this.json(res,200,await uploads.finish(u,upload[1]));if(upload[2]==='cancel')return this.json(res,200,uploads.cancel(u,upload[1]));}
      if(path==='/api/file-content'&&['GET','HEAD'].includes(method)){
        const filePath=validPath(url.searchParams.get('path')),revision=url.searchParams.get('revision')??undefined;
        if(!url.searchParams.has('download')&&url.searchParams.has('preview')){requireThat(url.searchParams.get('preview')==='thumb','缩略图类型无效');return uploads.serveThumbnail(req,res,filePath,revision,user);}
        return uploads.serve(req,res,filePath,revision);
      }
      if(path==='/api/file-reference'&&method==='POST'){const b=await this.body(req);this.fields(b,['path']);const m=await uploads.reference(this.authenticate(req).user,validPath(b.path));requireThat(m,'生成图仅供查看，请引用原始素材',409);return this.json(res,200,m);}
      if(path==='/api/admin/member-models'&&method==='GET')return this.json(res,200,new MemberModels(store,images.selection).list(user));
      if(path==='/api/admin/member-models'&&method==='POST')return this.json(res,200,new MemberModels(store).save(user,await this.body(req)));
      if(path==='/api/admin/media-models'&&method==='GET'){let pricingError:string|undefined;try{await images.refreshModels(user);}catch(error){pricingError=error instanceof Error?error.message:'单价目录暂时不可用';}return this.json(res,200,new MediaModelAdmin(store,pickups.catalog).list(user).map(m=>({...m,...(m.kind==='image'&&pricingError?{pricing:{error:pricingError}}:{})})));}
      if(path==='/api/admin/image-models'&&method==='POST'){const b=await this.body(req);return this.json(res,201,new MediaModelAdmin(store,pickups.catalog).saveImage(this.authenticate(req).user,b));}
      const removeModel=path.match(/^\/api\/admin\/media-models\/(video|image)\/([a-f0-9-]+)\/remove$/);
      if(removeModel&&method==='POST'){await this.body(req);return this.json(res,200,new MediaModelAdmin(store,pickups.catalog).remove(this.authenticate(req).user,removeModel[1],removeModel[2]));}
      if(path==='/api/xiaopei-models'&&method==='GET')return this.json(res,200,images.directory.list());
      if(path==='/api/image-models'&&method==='GET')return this.json(res,200,await images.refreshModels(user));
      if(path==='/api/image-assets'&&method==='GET')return this.json(res,200,images.originals(user));
      if(path==='/api/image-assets'&&method==='POST'){const b=await this.body(req);const u=this.authenticate(req).user,m=await images.upload(u,b);const name=String(m.name).normalize('NFC');validPath(name);const p=`成员附件/${m.id}/${name}`;storeFile(store.root,pickups.media.path(m.id));const change=projects.addAttachment(u,p,m.sha256,'image-'+m.id);const saved={...m,scope:'project',attachmentPath:p,revision:change.revision};store.put('media',saved);return this.json(res,201,saved);}
      if(path==='/api/images'&&method==='GET'){const all=user.role==='admin'&&url.searchParams.get('all')==='1';return this.json(res,200,store.all('image-plan',all?undefined:user.id).map(p=>images.get(p.id,user)));}
      const im=path.match(/^\/api\/images\/([a-f0-9-]+)(?:\/(confirm))?$/);
      if(im&&method==='GET'&&!im[2])return this.json(res,200,images.get(im[1],user));
      if(im&&method==='POST'&&im[2]==='confirm'){const b=await this.body(req);return this.json(res,200,images.confirm(im[1],this.authenticate(req).user,b));}
      const imageRecovery=path.match(/^\/api\/images\/jobs\/([a-f0-9-]+)\/recover$/);
      if(imageRecovery&&method==='POST'){await this.body(req);return this.json(res,200,images.recover(imageRecovery[1],this.authenticate(req).user));}
      const imageSync=path.match(/^\/api\/admin\/xiaopei-channels\/([a-f0-9-]+)\/sync$/);
      if(imageSync&&method==='POST'){this.admin(user);await this.body(req);return this.json(res,200,await images.directory.sync(this.authenticate(req).user,imageSync[1]));}
      if (path === '/api/video-models' && method === 'GET') return this.json(res, 200, pickups.catalog.models(user));
      if (path === '/api/pickups' && method === 'GET') {
        const all = user.role === 'admin' && url.searchParams.get('all') === '1';
        if (all) store.audit(user.id, 'admin.pickups.list', 'all');
        return this.json(res, 200, store.all('pickup', all ? undefined : user.id).map(p => pickups.get(p.id, user)));
      }
      const pm = path.match(/^\/api\/pickups\/([a-f0-9-]+)(?:\/(confirm))?$/);
      const quotaRequest=path.match(/^\/api\/pickups\/([a-f0-9-]+)\/quota-requests$/);
      if(quotaRequest&&method==='POST'){const b=await this.body(req);const u=this.authenticate(req).user;return this.json(res,200,pickups.quota.request(u,pickups.get(quotaRequest[1],u),b));}
      if (pm && method === 'GET' && !pm[2]) return this.json(res, 200, pickups.get(pm[1], user));
      if (pm && method === 'POST' && pm[2] === 'confirm') { const b = await this.body(req); return this.json(res, 200, pickups.confirm(pm[1], this.authenticate(req).user, b)); }
      const adopt = path.match(/^\/api\/pickups\/jobs\/([a-f0-9-]+)\/adopt$/);
      if (adopt && method === 'POST') { const b = await this.body(req); return this.json(res, 200, pickups.adopt(adopt[1], this.authenticate(req).user, b)); }
      if (path.startsWith('/api/admin/video-')) {
        this.admin(user);
        if(path==='/api/admin/video-quota-requests'&&method==='GET')return this.json(res,200,pickups.quota.list(user));
        const quotaDecision=path.match(/^\/api\/admin\/video-quota-requests\/([a-f0-9-]+)\/decision$/);
        if(quotaDecision&&method==='POST'){const b=await this.body(req);return this.json(res,200,pickups.quota.decide(this.authenticate(req).user,quotaDecision[1],b));}
        if (path === '/api/admin/video-jobs' && method === 'GET') return this.json(res,200,store.all('video-job').map(j => pickups.publicJob(j)));
        if (path === '/api/admin/video-storage' && method === 'GET') return this.json(res,200,pickups.storage.publicConfig());
        if (path === '/api/admin/video-storage' && method === 'POST') return this.json(res,201,pickups.storage.save(user,await this.body(req)));
        if (path === '/api/admin/video-channels' && method === 'GET') return this.json(res, 200, pickups.catalog.channels());
        if (path === '/api/admin/video-channels' && method === 'POST') return this.json(res, 201, pickups.catalog.saveChannel(user, await this.body(req)));
        const probe = path.match(/^\/api\/admin\/video-channels\/([a-f0-9-]+)\/probe$/);
        if (probe && method === 'POST') { await this.body(req); return this.json(res, 200, await pickups.catalog.probe(user, probe[1])); }
        if (path === '/api/admin/video-models' && method === 'GET') return this.json(res, 200, pickups.catalog.models(user));
        if (path === '/api/admin/video-models' && method === 'POST') return this.json(res, 201, pickups.catalog.saveModel(user, await this.body(req)));
        if (path === '/api/admin/video-templates' && method === 'GET') return this.json(res, 200, { templates: store.all('video-template').filter(t=>!t.projectId||t.projectId===projectId), versions: store.all('video-template-version').filter(t=>!t.projectId||t.projectId===projectId) });
        if (path === '/api/admin/video-templates' && method === 'POST') return this.json(res, 201, pickups.catalog.saveTemplate(user, await this.body(req),projectId));
        if (path === '/api/admin/video-index' && method === 'GET') { try { return this.json(res,200,pickups.index()); } catch { return this.json(res,200,{version:1,shots:[]}); } }
        if (path === '/api/admin/video-index' && method === 'POST') return this.json(res, 201, pickups.publishIndex(user, await this.body(req)));
        if (path === '/api/admin/video-assets' && method === 'GET') return this.json(res, 200, store.all('media').filter(m => m.scope === 'project'));
        if (path === '/api/admin/video-assets/import' && method === 'POST') { const b=await this.body(req);this.fields(b,['path']);requireThat(typeof b.path==='string','缺少主机文件路径');return this.json(res,201,await pickups.media.importOriginal(b.path,user)); }
        const recover = path.match(/^\/api\/admin\/video-jobs\/([a-f0-9-]+)\/recover$/);
        if(recover && method==='POST') return this.json(res,200,await pickups.recover(user,recover[1],await this.body(req)));
      }
      if (path === '/api/project' && method === 'GET') { const summary=url.searchParams.get('view')==='studio',files=summary?[]:projects.files();return this.json(res, 200, { ...this.publicProject(projectId), publication: projects.publication(), files, filesLoaded:!summary, fileCount:summary?Object.keys(projects.revision().manifest).length:files.length, release: this.release(), chat:this.catalog.options(user,projectId) }); }
      if (path === '/api/file' && method === 'GET') { const p = validPath(url.searchParams.get('path')); const rev = url.searchParams.get('revision') ?? undefined; return this.json(res, 200, { path: p, revision: rev ?? projects.current().revision, ...await documentText(store.root,projects.fileInfo(p,rev).digest,p,Number(url.searchParams.get('offset')??0)) }); }
      if (path === '/api/sessions' && method === 'GET') { const all = url.searchParams.get('all') === '1'; if (all) { this.admin(user); store.audit(user.id, 'admin.sessions.list', 'all'); } return this.json(res, 200, store.all('session', all ? undefined : user.id).map(s=>this.publicSession(s))); }
      if (path === '/api/sessions' && method === 'POST') { const b = await this.body(req); this.fields(b, ['title','fresh']); requireThat(b.fresh===undefined||typeof b.fresh==='boolean','新会话参数无效'); const s = b.fresh ? this.createChat(user,projectId,b.title) : this.fixedChat(user,projectId); return this.json(res, 201, this.publicSession(s)); }
      if(path==='/api/native/status'&&method==='GET'&&url.searchParams.get('connection')==='1')return this.json(res,200,{serverInstance:this.instanceId,...await this.native.connection(this.nativeOwner(user,projectId,url.searchParams.get('member')??undefined),projectId)});
      if(path==='/api/native/status'&&method==='GET')return this.json(res,200,{available:await this.native.available(),policy:this.native.policy(projectId),features:NATIVE_FEATURES,instances:user.role==='admin'?this.native.list(projectId):undefined});
      if(path==='/api/native/open'&&method==='POST'){
        await this.body(req);const member=url.searchParams.get('member')??undefined,owner=this.nativeOwner(user,projectId,member),started=Date.now(),instance=await this.native.open(owner,projectId);
        // Recheck after startup; an administrator can be revoked while it runs.
        const viewer=this.authenticate(req).user;this.nativeOwner(viewer,projectId,member);
        const ticket=randomBytes(32).toString('hex');this.nativeTickets.set(ticket,{user:viewer.id,auth:auth.token,csrf:auth.csrf,expires:Date.now()+60000,project:projectId,member});
        if(member)this.store.audit(viewer.id,'admin.native_chat.open',owner.id,{project:projectId});
        return this.json(res,200,{url:`${relay?.origin??base}/harness/${projectId}${member?'~'+member:''}/?ticket=${ticket}`,serverInstance:this.instanceId,generation:String(instance?.startup?.startedAt??''),scope:viewer.id+':'+projectId+(member?':'+member:''),openMs:Date.now()-started,reused:!!instance?.startup?.readyAt&&instance.startup.readyAt<started,startupMs:instance?.startup?.readyAt&&instance.startup.readyAt>=started?instance.startup.readyAt-instance.startup.startedAt:0,steps:instance?.startup?.readyAt&&instance.startup.readyAt>=started?instance.startup.steps:{}});
      }
      if(path==='/api/native/stop'&&method==='POST'){const b=await this.body(req);this.fields(b,['key']);await this.native.stop(user,projectId,b.key);return this.json(res,200,{stopped:true});}
      if(path==='/api/native/changes'&&method==='GET'){const i=await this.native.get(user,projectId);return this.json(res,200,await this.native.frozen(i,()=>this.native.changes(i)));}
      if(path==='/api/native/submit'&&method==='POST'){const b=await this.body(req);this.fields(b,['paths']);const i=await this.native.get(user,projectId);return this.json(res,201,await this.native.frozen(i,()=>this.native.submit(i,user,b.paths)));}
      if(path==='/api/native/sync'&&method==='POST'){await this.body(req);const i=await this.native.get(user,projectId);requireThat(i.active===0,'请先等待原生模型执行完成',409);return this.json(res,200,await this.native.frozen(i,()=>this.native.sync(i,user)));}
      if(path==='/api/chat-options'&&method==='GET')return this.json(res,200,this.catalog.options(user,projectId));
      const sessionPatch=path.match(/^\/api\/sessions\/([^/]+)$/);
      if(sessionPatch&&method==='PATCH'){
        const b=await this.body(req);this.fields(b,['title','archived','modelId','permission','skillId']);const s=this.owner('session',sessionPatch[1],user,store);requireThat(s.owner===user.id,'只能修改本人会话',403);
        requireThat(!store.all('task').some(t=>t.session===s.id&&['running','queued','cancel_requested','steering','termination_unconfirmed'].includes(t.state)),'请先处理本会话正在执行或排队的消息',409);
        requireThat(b.title===undefined||typeof b.title==='string'&&b.title.trim()&&b.title.length<=100,'会话名称无效');requireThat(b.archived===undefined||typeof b.archived==='boolean','归档状态无效');
        const selection=b.modelId!==undefined||b.permission!==undefined||b.skillId!==undefined?this.catalog.select(user,projectId,b.modelId??s.modelId,b.permission??s.permission,b.skillId??s.skillId):undefined;
        const next={...s,...(b.title===undefined?{}:{title:b.title.trim(),customTitle:true}),...(b.archived===undefined?{}:{archived:b.archived,multichat:true}),...(selection?{modelId:selection.modelId,permission:selection.permission,skillId:selection.skillId,skillRevision:selection.skillRevision,skillHash:selection.skillHash}:{}),updated:now()};store.put('session',next);store.audit(user.id,'chat.session.update',s.id,{fields:Object.keys(b)});return this.json(res,200,this.publicSession(next));
      }
      let match = path.match(/^\/api\/sessions\/([^/]+)\/messages$/);
      if (match && method === 'GET') { const session = this.owner('session', match[1], user,store); if (session.owner !== user.id) store.audit(user.id, 'admin.chat.read', session.id); return this.json(res, 200, store.all('message', session.id)); }
      const lookup = path.match(/^\/api\/requests\/([a-zA-Z0-9_-]{8,100})$/);
      if (lookup && method === 'GET') {
        const session = this.owner('session', url.searchParams.get('session') ?? '', user,store);
        requireThat(session.owner === user.id, '不能核对其他成员的提交', 403);
        const row = store.db.prepare('SELECT task_id FROM requests WHERE owner=? AND session_id=? AND request_id=?').get(user.id, session.id, lookup[1]) as any;
        const closed = !!store.get('closed-request', hash(JSON.stringify([user.id, session.id, lookup[1]])));
        return this.json(res, 200, { found: !!row, closed, task: row ? store.get('task', row.task_id) : null, serverId: this.serverId });
      }
      const closeRequest = path.match(/^\/api\/requests\/([a-zA-Z0-9_-]{8,100})\/close$/);
      if (closeRequest && method === 'POST') {
        const b = await this.body(req); this.fields(b, ['session']);
        const session = this.owner('session', b.session, user,store);
        requireThat(session.owner === user.id, '不能结束其他成员的提交', 403);
        const row = store.db.prepare('SELECT task_id FROM requests WHERE owner=? AND session_id=? AND request_id=?').get(user.id, session.id, closeRequest[1]) as any;
        if (row) return this.json(res, 200, { found: true, closed: false, task: store.get('task', row.task_id) });
        const key = hash(JSON.stringify([user.id, session.id, closeRequest[1]]));
        store.tx(() => {
          if (!store.get('closed-request', key)) {
            store.put('closed-request', { id: key, owner: user.id, session: session.id, requestId: closeRequest[1], created: now() });
            store.audit(user.id, 'request.close_unaccepted', closeRequest[1], { session: session.id });
          }
        });
        return this.json(res, 200, { found: false, closed: true });
      }
      if (path === '/api/tasks' && method === 'GET') { const all = user.role === 'admin' && url.searchParams.get('all') === '1'; if (all) store.audit(user.id, 'admin.tasks.read', 'all'); return this.json(res, 200, store.all('task', all ? undefined : user.id)); }
      if (path === '/api/tasks' && method === 'POST') {
        if(this.options.nativeOnly)return this.json(res,409,{error:'项目聊天已升级，请刷新页面进入原生工作台继续。历史对话已保留；本请求尚未执行。',code:'NATIVE_CHAT_REQUIRED'});
        const b = await this.body(req); this.fields(b, ['session', 'requestId', 'prompt', 'workflow', 'paths','delivery','modelId','permission','skillId']);
        const s = this.owner('session', b.session, user,store); requireThat(s.owner === user.id, '不能代替其他成员发起聊天', 403);
        requireThat(typeof b.prompt === 'string' && b.prompt.trim().length > 0 && b.prompt.length <= 16000, '请输入 1–16000 字符的请求');
        requireThat(typeof b.requestId === 'string' && /^[a-zA-Z0-9_-]{8,100}$/.test(b.requestId), '无效请求编号');
        requireThat(['chat', 'plan','organize', 'script', 'pickup', 'image'].includes(b.workflow), '流程不存在'); requireThat(Array.isArray(b.paths) && b.paths.length <= 16, '文件选择无效'); b.paths.forEach(validPath);
        const digest = hash(JSON.stringify(b)); const existing = store.db.prepare('SELECT * FROM requests WHERE owner=? AND session_id=? AND request_id=?').get(user.id, s.id, b.requestId) as any;
        if (existing) { requireThat(existing.digest === digest, '同一请求编号被用于不同内容', 409); return this.json(res, 200, store.get('task', existing.task_id)); }
        requireThat(!this.publicSession(s).archived,'请先恢复已归档的会话',409);
        requireThat(b.delivery===undefined||['queue','steer'].includes(b.delivery),'发送方式无效');
        requireThat(!store.get('closed-request', hash(JSON.stringify([user.id, s.id, b.requestId]))), '该请求编号已结束，迟到提交不会执行', 409);
        projects.assertReady();
        const running=store.all('task',user.id).find(t=>t.session===s.id&&['running','cancel_requested','termination_unconfirmed'].includes(t.state));
        requireThat(!running||!['cancel_requested','termination_unconfirmed'].includes(running.state),'请先等待停止结果确认',409);
        requireThat(this.store.all('task', user.id).filter(t => ['queued', 'running','steering'].includes(t.state)).length < 8 && this.store.all('task').filter(t => ['queued', 'running','steering'].includes(t.state)).length < MAX_PENDING_TASKS, '任务队列已满，请等待已有任务完成', 429);
        projects.assertClean(); const selection=this.catalog.select(user,projectId,b.modelId??s.modelId,b.permission??s.permission??'workspace-write',b.skillId??s.skillId);
        requireThat(!['organize','script'].includes(b.workflow)||selection.permission==='workspace-write','只读模式不能提交修改或执行脚本，请切换管理员允许的工作区写入模式',403);
        const release:Doc = {...this.release(),...selection}; requireThat(b.workflow !== 'script' || (release.allowScripts && this.sandboxReady), '超级管理员尚未开启脚本，或执行器不可用', 409);
        for (const p of b.paths) requireThat(projects.revision().manifest[p], '所选文件不存在', 404);
        const steering=b.delivery==='steer'&&running;
        if(steering)requireThat(['chat','plan'].includes(b.workflow)&&['chat','plan'].includes(running.workflow)&&b.paths.length===0&&running.release.configId===release.configId&&running.release.permission===release.permission&&running.release.skillId===release.skillId,'插话需要相同模型、权限和技能，且仅支持无附件的文字聊天；可改为排队发送',409);
        const task = { id: id(), requestId: b.requestId, owner: user.id, session: s.id, project: projectId, prompt: b.prompt, workflow: ['chat','pickup','image'].includes(b.workflow) && /^\s*图片模型\s*[:：]/m.test(b.prompt) ? 'image' : b.workflow === 'chat' && /补抽意见\s*[:：]/.test(b.prompt) ? 'pickup' : b.workflow, paths: b.paths, base: projects.current().revision, release, state: steering?'steering':'queued', ...(steering?{parentTask:running.id}:{}), generation: 1, created: now(), partial: '' };
        store.tx(() => { store.put('task', task); store.put('message', { id: id(), session: s.id, role: 'user', text: b.prompt, attachments:b.paths.map((path:string)=>{const f=projects.fileInfo(path,task.base);return {path,name:path.split('/').at(-1),revision:task.base,mime:f.mime,bytes:f.bytes};}), created: now(), task: task.id }, s.id); store.db.prepare('INSERT INTO requests VALUES(?,?,?,?,?)').run(user.id, s.id, b.requestId, digest, task.id); store.event(user.id, 'task.queued', { id: task.id }); });
        if(steering){try{host.steer(running.id,s.id,task.prompt);}catch(e){store.put('task',{...task,state:'failed',error:'插话未送达，未自动重发；请检查原任务状态',finished:now()});throw e;}}
        this.pump(); return this.json(res, 202, store.get('task',task.id));
      }
      const queueEdit=path.match(/^\/api\/tasks\/([^/]+)$/);
      if(queueEdit&&method==='PATCH'){
        const b=await this.body(req);this.fields(b,['prompt']);const t=this.owner('task',queueEdit[1],user,store);requireThat(t.owner===user.id,'只能编辑自己的排队消息',403);requireThat(t.state==='queued','消息已开始执行，不能再编辑',409);requireThat(typeof b.prompt==='string'&&b.prompt.trim()&&b.prompt.length<=16000,'消息长度需为 1–16000 字符');
        store.tx(()=>{store.put('task',{...t,prompt:b.prompt,edited:now()});const m=store.all('message',t.session).find(m=>m.task===t.id&&m.role==='user');if(m)store.put('message',{...m,text:b.prompt,edited:now()},t.session);store.audit(user.id,'chat.queue.edit',t.id);});return this.json(res,200,store.get('task',t.id));
      }
      match = path.match(/^\/api\/tasks\/([^/]+)\/cancel$/);
      if (match && method === 'POST') { const t = this.owner('task', match[1], user,store); requireThat(['queued', 'running', 'cancel_requested'].includes(t.state), '任务已经结束', 409); store.put('task', { ...t, state: t.state === 'queued' ? 'cancelled' : 'cancel_requested' }); this.active.get(t.id)?.abort(); store.audit(user.id, 'task.cancel', t.id); return this.json(res, 200, store.get('task', t.id)); }
      if (path === '/api/changes' && method === 'GET') return this.json(res, 200, store.all('change', user.role === 'admin' ? undefined : user.id));
      if (path === '/api/changes' && method === 'POST') { const b = await this.body(req); this.fields(b, ['base', 'writes']); requireThat(b.writes && typeof b.writes === 'object' && !Array.isArray(b.writes), '缺少修改内容'); return this.json(res, 201, projects.candidate(user, b.base, b.writes, {})); }
      match = path.match(/^\/api\/changes\/([^/]+)$/);
      if (match && method === 'GET') { const c = this.owner('change', match[1], user,store); return this.json(res, 200, { ...c, diff: Object.keys(c.writes).map(p => ({ path: p, before: c.before[p] ? (objectInfo(store.root,c.before[p]).text?projects.bytes(c.before[p]).toString('utf8'):`附件原件 · ${objectInfo(store.root,c.before[p]).bytes} 字节 · SHA256 ${c.before[p]}`) : null, after: c.writes[p] ? (objectInfo(store.root,c.writes[p]).text?projects.bytes(c.writes[p]).toString('utf8'):`附件原件 · ${objectInfo(store.root,c.writes[p]).bytes} 字节 · SHA256 ${c.writes[p]}`) : null })) }); }
      match = path.match(/^\/api\/changes\/([^/]+)\/(approve|reject)$/);
      if (match && method === 'POST') { this.admin(user); const b = await this.body(req); const c = this.owner('change', match[1], user,store); if (match[2] === 'approve') return this.json(res, 200, projects.approve(c, user, b.digest)); requireThat(c.state === 'submitted', '状态已改变', 409); requireThat(b.digest === c.digest, '候选版本已改变', 409); store.tx(() => { store.put('change', { ...c, state: 'rejected', reason: String(b.reason || '管理员退回').slice(0, 1000) }); if (c.task) store.put('task', { ...store.get('task', c.task)!, state: 'rejected' }); store.audit(user.id, 'change.reject', c.id); }); return this.json(res, 200, store.get('change', c.id)); }
      if (path === '/api/events' && method === 'GET') {
        const cursor = Number(url.searchParams.get('after') || 0); requireThat(Number.isSafeInteger(cursor) && cursor >= 0, '无效游标');
        const bounds = store.db.prepare('SELECT MIN(seq) AS first, MAX(seq) AS last FROM events').get() as any;
        const last = bounds.last ?? 0;
        if (cursor > last || cursor > 0 && bounds.first && cursor < bounds.first - 1) return this.json(res, 200, { cursor: 0, resetRequired: true, events: [], serverId: this.serverId });
        const rows = store.db.prepare("SELECT * FROM events WHERE seq>? AND (owner=? OR owner='*') ORDER BY seq LIMIT 200").all(cursor, user.id) as any[];
        return this.json(res, 200, { cursor: rows.length === 200 ? rows.at(-1).seq : last, resetRequired: false, hasMore: rows.length === 200 && rows.at(-1).seq < last, serverId: this.serverId, events: rows.map(r => ({ seq: r.seq, type: r.type, body: JSON.parse(r.body), created: r.created })) });
      }
      if (path.startsWith('/api/admin/')) {
        this.admin(user);
        if(path==='/api/admin/native-policy'&&method==='POST'){const b=await this.body(req);this.fields(b,['enabled','features','permissions']);return this.json(res,200,await this.native.savePolicy(user,projectId,b));}
        if(path==='/api/admin/chat-models'&&method==='GET')return this.json(res,200,{models:chatCapabilities(this.store,this.catalog),removedProviders:this.catalog.removedProviderIds(),policy:this.catalog.policy(projectId),routing:routingPolicy(this.store,projectId),magpie:this.catalog.magpie.status(),users:this.store.all('user').filter(u=>u.active).map(u=>({id:u.id,name:u.name,username:u.username,role:u.role}))});
        if(path==='/api/admin/model-routing'&&method==='POST')return this.json(res,200,saveRoutingPolicy(this.store,this.catalog,user,projectId,await this.body(req)));
        if(path==='/api/admin/chat-model-directory'&&method==='POST'){const b=await this.body(req);this.fields(b,['provider','sourceId','apiKey','refresh']);return this.json(res,200,await this.catalog.directory(user,b));}
        if(path==='/api/admin/chat-models'&&method==='POST'){const b=await this.body(req);this.fields(b,['id','name','provider','model','baseURL','reasoningEffort','apiKey','enabled','roles','accountUserId','sourceId']);return this.json(res,200,this.catalog.saveModel(user,b));}
        if(path==='/api/admin/chat-policy'&&method==='POST'){const b=await this.body(req);this.fields(b,['modelIds','permissions','multipleSessions']);return this.json(res,200,this.catalog.savePolicy(user,projectId,b));}
        if(path==='/api/admin/skills'&&method==='GET')return this.json(res,200,{skills:this.catalog.skills.all(),policy:this.catalog.skills.policy(projectId)});
        if(path==='/api/admin/skills'&&method==='POST'){const b=await this.body(req);this.fields(b,['skillIds','defaultSkillId']);return this.json(res,200,this.catalog.skills.savePolicy(user,projectId,b));}
        if(path==='/api/admin/host-folders'&&method==='GET'){const folders=await browseHostFolders(projects,url.searchParams.get('path'),url.searchParams.get('mode'),url.searchParams.get('q')??'');this.admin(this.authenticate(req).user);return this.json(res,200,folders);}
        if(path==='/api/admin/project-directory' && method==='GET')return this.json(res,200,{name:projects.current().name,path:projects.canonical,revision:projects.current().revision,scope:'shared-published-project-only',chatPolicy:'one-per-member'});
        if(path==='/api/admin/project-directory/preview' && method==='POST'){const b=await this.body(req);this.fields(b,['path','name']);return this.json(res,201,projects.previewDirectory(user,b.path,b.name));}
        if(path==='/api/admin/project-directory/bind' && method==='POST'){
          const b=await this.body(req);this.fields(b,['previewId','digest']);
          requireThat(!store.all('task').some(t=>['queued','running','cancel_requested','termination_unconfirmed','awaiting_candidate'].includes(t.state)) && !store.all('video-job').some(j=>['queued','preparing','submitting','submission_unknown','running','downloading','checking'].includes(j.state)) && !store.all('image-job').some(j=>['queued','preparing','submitting','submission_unknown','downloading'].includes(j.state)),'当前存在在途或待核对任务，请待原任务处理完毕后再绑定目录',409);
          projects.bindDirectory(user,b.previewId,b.digest);return this.json(res,200,this.publicProject(projectId));
        }
        if (path === '/api/admin/users' && method === 'GET') return this.json(res, 200, store.all('user').map(u => this.publicUser(u)));
        if (path === '/api/admin/users' && method === 'POST') { const b = await this.body(req); requireThat(['member', 'admin'].includes(b.role), '角色无效'); const u = this.newUser(b, b.role); store.audit(user.id, 'user.create', u.id, { role: u.role }); return this.json(res, 201, this.publicUser(u)); }
        match = path.match(/^\/api\/admin\/users\/([^/]+)$/);
        if (match && method === 'PATCH') { const b = await this.body(req); const target = store.get('user', match[1]); requireThat(target, '账号不存在', 404); this.fields(b, ['active', 'role', 'password']); requireThat(b.role === undefined || ['admin', 'member'].includes(b.role), '角色无效'); requireThat(b.active === undefined || typeof b.active === 'boolean', '账号状态无效'); const next = { ...target, ...(b.active === undefined ? {} : { active: b.active }), ...(b.role ? { role: b.role } : {}), ...(b.password ? { password: passwordHash(b.password) } : {}) }; requireThat(next.active && next.role === 'admin' || store.all('user').some(u => u.id !== target.id && u.active && u.role === 'admin'), '不能停用或降权最后一个超级管理员'); store.tx(() => { store.put('user', next); store.db.prepare('DELETE FROM auth WHERE user_id=?').run(target.id); store.audit(user.id, 'user.update', target.id, { active: next.active, role: next.role }); }); for (const t of this.store.all('task', target.id)) if (['running', 'queued'].includes(t.state)) { this.store.put('task', { ...t, state: t.state === 'queued' ? 'cancelled' : 'cancel_requested' }); this.active.get(t.id)?.abort(); } return this.json(res, 200, this.publicUser(next)); }
        match = path.match(/^\/api\/admin\/tasks\/([^/]+)\/confirm-stop$/);
        if (match && method === 'POST') { await this.body(req); const t = this.owner('task', match[1], user,store); requireThat(t.state === 'termination_unconfirmed' && t.container, '该任务没有待核对的执行器', 409); await stopAndVerify(t.container); this.authenticate(req); store.tx(() => { store.put('task', { ...t, state: 'interrupted', error: '管理员已确认执行器停止；原任务未自动重发。' }); store.audit(user.id, 'execution.stop_verified', t.id); }); this.pump(); return this.json(res, 200, store.get('task', t.id)); }
        if (path === '/api/admin/model-usage' && method === 'GET') { store.audit(user.id, 'admin.model_usage.read', 'all'); return this.json(res, 200, { budget: budgetStatus(store), calls: store.all('model-call').slice(-200) }); }
        if (path === '/api/admin/model-budget' && method === 'POST') { await this.body(req); throw new Problem(410, '平台费用已设为不限额，此预算设置入口已停用'); }
        if (path === '/api/admin/releases' && method === 'GET') return this.json(res, 200, store.all('release'));
        if (path === '/api/admin/releases' && method === 'POST') { const b = await this.body(req); this.fields(b, ['title', 'instruction', 'allowScripts']); requireThat(typeof b.title === 'string' && b.title.trim() && b.title.length < 100, '请输入模板名称'); requireThat(typeof b.instruction === 'string' && b.instruction.length <= 8000, '模板说明无效'); requireThat(typeof b.allowScripts === 'boolean', '脚本开关无效'); requireThat(!b.allowScripts || this.sandboxReady, '执行器不可用'); const r = { id: id(), title: b.title, instruction: b.instruction, allowScripts: b.allowScripts, ...modelPolicy(this.options.model), created: now(), author: user.id }; store.tx(() => { store.put('release', r); store.put('config', { id: 'active', release: r.id }); store.audit(user.id, 'release.publish', r.id); store.event('*', 'release.published', { id: r.id, title: r.title }); }); return this.json(res, 201, r); }
        if (path === '/api/admin/import-diff' && method === 'POST') return this.json(res, 201, projects.external(user));
        if (path === '/api/admin/project/recover' && method === 'POST') { await this.body(req); projects.recover(); store.audit(user.id, 'project.recover', projectId, { revision: projects.current().revision }); this.pump(); return this.json(res, 200, projects.publication()); }
        if (path === '/api/admin/audit' && method === 'GET') return this.json(res, 200, store.db.prepare('SELECT * FROM audit ORDER BY seq DESC LIMIT 200').all());
        if (path === '/api/admin/health' && method === 'GET') return this.json(res, 200, { checkedAt: now(), publication: projects.publication(), harnessReady: host.ready, video: { jobs: store.all('video-job').length, inFlight: store.all('video-job').filter(j => ['preparing','submitting','submission_unknown','running','downloading','checking'].includes(j.state)).length }, active: this.textQueue.active, queued: this.textQueue.pending+this.store.all('task').filter(t=>t.state==='queued'&&!this.active.has(t.id)).length, model: this.release().model, modelMode: this.options.model ? 'online' : 'mock', budget: budgetStatus(store), sandbox: this.sandboxReady, sandboxImage: IMAGE, sharedProject: projects.current().id, revision: projects.current().revision, pilotConnected: false, videoMode:this.options.simulatedVideo?'simulated':'admin_configured', videoConcurrency:pickups.maxConcurrency, textConcurrency:this.options.concurrency??4 });
      }
      throw new Problem(404, '接口不存在');
    }
    requireThat(method === 'GET' || method === 'HEAD', '不支持此方法', 405); const root = this.options.staticDir;
    requireThat(root, '网页尚未构建，请先运行 npm run build', 404);
    const rel = path === '/' ? 'index.html' : decodeURIComponent(path.slice(1)); requireThat(!rel.includes('..') && !rel.includes('\\'), '路径无效');
    const file = join(root!, rel); requireThat(existsSync(file), '页面不存在', 404);
    const mime = rel.endsWith('.svg') ? 'image/svg+xml' : rel.endsWith('.js') ? 'application/javascript' : rel.endsWith('.css') ? 'text/css' : rel.endsWith('.json') ? 'application/json' : 'text/html'; res.writeHead(200, { 'Content-Type': `${mime}; charset=utf-8`, 'Cache-Control': ['index.html','ui-module-map.json'].includes(rel) ? 'no-store' : 'public,max-age=3600' }); res.end(readFileSync(file));
  }
  publicProject(projectId='shared'):Doc {const p=this.store.get('project',projectId);requireThat(p,'项目不存在',404);const {directory,directoryOwnerRoot,...safe}=p;return {...safe,canCreateProjects:true};}
  fixedChat(user:Doc,projectId='shared'):Doc {
    const store=this.workspace(projectId).store;const key=`${projectId}:${user.id}`, assigned=store.get('member-chat',key);
    if(assigned){const s=store.get('session',assigned.session);if(s && s.owner===user.id && (s.project??'shared')===projectId)return s;}
    const existing=store.all('session',user.id).filter(s=>(s.project??'shared')===projectId);
    const active=store.all('task',user.id).find(t=>['queued','running','cancel_requested','termination_unconfirmed'].includes(t.state));
    const chosen=existing.find(s=>s.id===active?.session) ?? existing.find(s=>store.all('message',s.id).length>0) ?? existing[0] ?? {id:id(),project:projectId,owner:user.id,title:`${user.name} 的项目聊天`,created:now()};
    store.tx(()=>{if(!store.get('session',chosen.id))store.put('session',chosen);store.put('member-chat',{id:key,owner:user.id,project:projectId,session:chosen.id,created:now()});});return chosen;
  }
  createChat(user:Doc,projectId:string,title?:string){
    requireThat(this.catalog.policy(projectId).multipleSessions,'管理员尚未开放多会话',403);requireThat(title===undefined||typeof title==='string'&&title.length<=100,'会话名称无效');
    const selected=this.catalog.select(user,projectId);const s={id:id(),project:projectId,owner:user.id,title:title?.trim()||'新会话',multichat:true,archived:false,modelId:selected.modelId,permission:selected.permission,skillId:selected.skillId,skillRevision:selected.skillRevision,skillHash:selected.skillHash,created:now()};this.workspace(projectId).store.put('session',s);return s;
  }
  publicSession(s:Doc) {const user=this.store.get('user',s.owner)!;const fixed=this.fixedChat(user,s.project??'shared').id===s.id;return {...s,title:fixed&&!s.customTitle?`${user.name} 的项目聊天`:s.title,fixed,archived:s.archived??(!fixed&&!s.multichat),ownerName:user.name};}
  newUser(b: Doc, role: string) { const username=typeof b.username==='string'?b.username.normalize('NFC'):'';requireThat(/^[\p{L}\p{N}_-][\p{L}\p{M}\p{N}_-]{0,39}$/u.test(username), '账号需为 1–40 字，可用中文、字母、数字、下划线或短横线'); requireThat(!this.store.all('user').some(u => u.username.normalize('NFC') === username), '账号已存在', 409); requireThat(typeof b.password === 'string', '缺少密码'); const u = { id: id(), username, name: String(b.name || username).slice(0, 60), password: passwordHash(b.password), role, active: true, created: now() }; this.store.put('user', u);for(const projectId of this.workspaces.keys())this.fixedChat(u,projectId); return u; }
  pump() {
    if (this.closing) return;
    const queued = this.store.all('task').filter(t => t.state === 'queued'&&this.workspace(t.project??'shared').host.ready&&!this.workspace(t.project??'shared').projects.pending().length); queued.sort((a, b) => Number(a.owner === this.lastOwner) - Number(b.owner === this.lastOwner));
    for (const t of queued) {
      if (this.active.size + this.store.all('task').filter(t => t.state === 'termination_unconfirmed').length >= (this.options.concurrency ?? 4)) break;
      if(this.active.has(t.id))continue;
      if (!this.store.get('user', t.owner)?.active) { this.store.put('task', { ...t, state: 'cancelled' }); continue; }
      if ([...this.active.keys()].some(key => this.store.get('task', key)?.session === t.session)) continue;
      const controller = new AbortController(); this.active.set(t.id, controller); this.lastOwner = t.owner; const running = { ...t };
      void this.execute(running, controller).finally(() => { this.active.delete(t.id); this.pump(); });
    }
  }
  async execute(t: Doc, controller: AbortController) {
    const {store,projects,pickups,images,host}=this.workspace(t.project??'shared');
    let release:(()=>void)|undefined;try {
      release=await this.textQueue.acquire(t.owner,controller.signal,t.id);controller.signal.throwIfAborted();t={...store.get('task',t.id)!};requireThat(t.state==='queued','任务状态已改变',409);store.put('task',{...t,state:'running',started:now()});
      const allowed=this.catalog.select(store.get('user',t.owner)!,t.project??'shared',t.release.modelId,t.release.permission??'workspace-write');
      requireThat(allowed.configId===t.release.configId,'排队期间模型配置已改变，请重新选择后发送',409);
      if(t.workflow==='image'){
        controller.signal.throwIfAborted();requireThat(store.get('user',t.owner)?.active,'账号已停用',403);
        const p=images.prepare(t);
        store.tx(()=>{store.put('task',{...store.get('task',t.id)!,state:'completed',image:p.id,finished:now(),partial:''});store.put('message',{id:id(),session:t.session,task:t.id,image:p.id,role:'assistant',text:p.state==='awaiting_confirmation'?'图片方案已准备，请核对模型、提示词、尺寸与参考原图。确认后仅生成一张。':p.issues.join('\n'),created:now(),base:t.base},t.session);store.event(t.owner,'task.finished',{id:t.id,state:'completed'});});return;
      }
      if (t.workflow === 'pickup') {
        const context = pickups.context(t);
        const input = { ...t, pickupContext: context, paths: [] };
        const result = this.options.model ? await host.run(input, controller.signal, () => {}) : undefined;
        controller.signal.throwIfAborted(); requireThat(store.get('user', t.owner)?.active, '账号已停用', 403);
        const p = pickups.prepare(t, result?.text);
        store.tx(() => {
          store.put('task', { ...store.get('task', t.id)!, state: 'completed', pickup: p.id, finished: now(), partial: '' });
          store.put('message', { id:id(), session:t.session, task:t.id, pickup:p.id, role:'assistant', text:p.state === 'awaiting_confirmation' ? '补抽方案已准备，请核对下方镜头、素材、提示词及视频模型参数。确认前不会生成视频。' : p.issues.join('\n'), created:now(), base:t.base },t.session);
          store.event(t.owner,'task.finished',{id:t.id,state:'completed'});
        }); return;
      }
      const result = await host.run(t, controller.signal, text => { const current = store.get('task', t.id)!; if (current.state !== 'running' || current.generation !== t.generation) return; store.put('task', { ...current, partial: current.partial + text }); store.event(t.owner, 'task.delta', { id: t.id, text }); });
      const current = store.get('task', t.id)!; requireThat(current.state === 'running' && current.generation === t.generation && store.get('user', t.owner)?.active, '执行已失效', 409);
      store.tx(() => { store.put('message', { id: id(), role: 'assistant', text: result.text, attachments:result.attachments, session: t.session, task: t.id, created: now(), base: t.base, simulated: t.release.provider === 'platform-mock' }, t.session); store.put('task', { ...current, state: t.workflow === 'organize' ? 'awaiting_candidate' : 'completed', finished: now(), eventCount: result.eventCount }); });
      if (t.workflow === 'organize') { const change = projects.candidate(store.get('user', t.owner)!, t.base, { [`成果/整理报告-${t.id.slice(0, 8)}.md`]: result.text }, result.reads, { task: t.id, treeDependency: result.treeDependency }); store.put('task', { ...store.get('task', t.id)!, state: 'awaiting_review', change: change.id }); }
      for(const child of store.all('task',t.owner).filter(c=>c.parentTask===t.id&&c.state==='steering'))store.put('task',{...child,state:'completed',finished:now()});
      store.event(t.owner, 'task.finished', { id: t.id, state: store.get('task', t.id)!.state });
    } catch (e) { for(const child of store.all('task',t.owner).filter(c=>c.parentTask===t.id&&c.state==='steering'))store.put('task',{...child,state:controller.signal.aborted?'cancelled':'failed',error:'插话所属任务未完成，请检查原任务；未自动重发',finished:now()});const current = store.get('task', t.id)!; store.put('task', { ...current, state: e instanceof TerminationUnconfirmed ? 'termination_unconfirmed' : controller.signal.aborted ? 'cancelled' : 'failed', error: e instanceof Error ? e.message.slice(0, 1500) : '执行失败', finished: now() }); store.event(t.owner, 'task.finished', { id: t.id, state: store.get('task', t.id)!.state }); }finally{release?.();}
  }
}
