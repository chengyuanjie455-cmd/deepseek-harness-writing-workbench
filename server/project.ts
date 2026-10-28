import {assertStoragePath} from './external-storage.ts';
import { existsSync, mkdirSync, mkdtempSync, unlinkSync, rmdirSync, readFileSync, writeFileSync, readdirSync, lstatSync, renameSync, realpathSync, openSync, closeSync, fstatSync, constants, copyFileSync, chmodSync } from 'node:fs';
import { join, dirname, resolve, basename, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store, hash, id, now, requireThat, Problem, type Doc } from './store.ts';

import {objectInfo,objectPath,storeFile,MAX_FILE_BYTES,diskSpace} from './file-objects.ts';

export type Manifest = Record<string, string>;
export const MAX_PROJECT_BYTES = 16 * 1024 * 1024;
const manifestHash = (manifest: Manifest) => hash(JSON.stringify(Object.entries(manifest).sort()));
export function validPath(p: unknown): string {
  requireThat(typeof p === 'string' && p.length > 0 && p.length <= 240, '无效文件路径');
  requireThat(p === p.normalize('NFC') && !p.includes('\\') && !/[\x00-\x1f:,]/.test(p), '路径含不支持字符');
  requireThat(p.split('/').every(s => s && !s.startsWith('.') && !s.endsWith(' ') && !s.endsWith('.') && !['__proto__', 'constructor', 'prototype'].includes(s)), '仅支持项目内普通相对路径');
  return p;
}
export class Projects {
  canonical: string; repo: string;
  constructor(public store: Store,public projectId='shared', initial?:Doc, recover=true) {
    this.canonical = store.get('project',projectId)?.directory ?? initial?.path ?? join(store.root, 'project'); this.repo = join(store.root, projectId==='shared'?'versions.git':`versions-${projectId}.git`);
    requireThat(!store.get('project',projectId)?.directory || store.get('project',projectId)?.directoryOwnerRoot===store.root,'检测到数据目录迁移，须先用 rebind-restored-project.ts 核验独立项目副本再启动；未操作原项目目录',409);
    requireThat(!store.all('intent').some(i=>i.phase!=='published'&&i.directoryChange&&i.directoryChange.dataRoot!==store.root),'迁移副本包含未完成目录绑定，需先核对原事务，未操作原项目目录',409);
    for (const d of ['blobs', 'snapshots', 'recovery']) mkdirSync(join(store.root, d), { recursive: true });
    if (!existsSync(this.repo)) this.git(['init', '--bare', this.repo], false);
    if (!store.get('project', projectId)) {
      requireThat(projectId==='shared'||initial,'项目不存在',404);
      const manifest: Manifest = initial?.manifest?? { 'README.md': this.blob('# 共享测试项目\n\n这是平台搭建阶段的虚拟资料，与实际业务项目无关。\n'), '资料/协作说明.md': this.blob('# 协作说明\n\n每个人拥有独立聊天。提交成果后，由超级管理员审核并发布到共享项目。\n') };
      const revision = this.makeRevision(manifest);
      this.git(['update-ref', 'refs/heads/main', revision.id]);
      if(!initial)this.materialize(revision);
      store.put('project', { id: projectId, name: initial?.name??'共享测试项目', revision: revision.id, created: now(), pilot: false, ...(initial?{directory:initial.path,directoryOwnerRoot:store.root,createdBy:initial.owner,creationPreview:initial.id,...(initial.mode==='managed'?{managed:true}:{})}: {}) });
    }
    assertStoragePath(this.canonical);
    if(recover)this.recover();
  }
  git(args: string[], bare = true, input?: string | Buffer, env: Record<string, string> = {}) {
    return execFileSync('git', [...(bare ? ['--git-dir', this.repo] : []), ...args], { input, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 30_000,
      env: { PATH: process.env.PATH, HOME: this.store.root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Team Platform', GIT_AUTHOR_EMAIL: 'platform@localhost', GIT_COMMITTER_NAME: 'Team Platform', GIT_COMMITTER_EMAIL: 'platform@localhost', ...env }, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  }
  blob(content: string | Buffer) { const b = Buffer.from(content); requireThat(b.length <= 4 * 1024 * 1024, '基础版单文件上限 4 MiB'); const digest = hash(b); const p = join(this.store.root, 'blobs', digest); if (!existsSync(p)) writeFileSync(p, b, { flag: 'wx', mode: 0o600 }); return digest; }
  bytes(digest: string) { requireThat(/^[a-f0-9]{64}$/.test(digest), '无效内容哈希'); const b = readFileSync(join(this.store.root, 'blobs', digest)); requireThat(hash(b) === digest, '文件完整性检查失败', 503); return b; }
  current() { return this.store.get('project', this.projectId)!; }
  revision(rev = this.current().revision) { const r = this.store.get('revision', rev); requireThat(r, '项目版本不存在', 404); return r; }
  pending() { return this.store.all('intent').filter(i => i.phase !== 'published'); }
  publication() { const pending = this.pending().length; return { state: pending ? 'recovery_required' : 'ready', pending }; }
  assertReady() { requireThat(!this.pending().length, '项目有未完成发布，请由超级管理员恢复后再提交或执行', 503); }
  manifestBytes(manifest: Manifest) { return Object.values(manifest).reduce((size, digest) => size + objectInfo(this.store.root,digest).bytes, 0); }
  textBytes(manifest:Manifest){return Object.values(manifest).reduce((n,d)=>{const info=objectInfo(this.store.root,d);return n+(info.text?info.bytes:0);},0);}
  fileInfo(path:string,rev?:string):Doc{const digest=this.revision(rev).manifest[validPath(path)];requireThat(digest,'文件不存在',404);return {path,digest,...objectInfo(this.store.root,digest)};}
  files(rev?:string):Doc[]{const uploads=new Map(this.store.all('file-upload').filter(u=>u.state==='published').map(u=>[u.path,u]));return Object.keys(this.revision(rev).manifest).map(path=>{const u=uploads.get(path);return {...this.fileInfo(path,rev),...(u?{uploadedBy:this.store.get('user',u.owner)?.name,uploadedAt:u.publishedAt}:{})};});}
  validateCapacity(manifest: Manifest, previous?: Manifest) {
    const size = this.textBytes(manifest);
    requireThat(Object.keys(manifest).length<=10000 && this.manifestBytes(manifest)<=8*1024*1024*1024,'项目超过10000文件或8 GiB总量上限',413);
    // Old versions may already exceed the limit. Only a strict reduction may stay over it.
    requireThat(size <= MAX_PROJECT_BYTES || previous && size < this.textBytes(previous), '发布后项目将超过 16 MiB；请缩减内容后重新提交，当前版本未改变', 409);
  }
  read(path: string, rev?: string) { const digest = this.revision(rev).manifest[validPath(path)]; requireThat(digest, '文件不存在', 404); return this.bytes(digest); }
  makeRevision(manifest: Manifest, parent?: string) {
    this.validateCapacity(manifest, parent ? this.revision(parent).manifest : undefined);
    const keys = Object.keys(manifest).sort(); requireThat(new Set(keys.map(k => k.toLocaleLowerCase())).size === keys.length, '文件名大小写冲突');
    requireThat(!keys.some((p, i) => keys.slice(i + 1).some(other => other.startsWith(p + '/'))), '文件和目录路径冲突');
    const index = join(this.store.root, 'recovery', `index-${id()}`); const env = { GIT_INDEX_FILE: index };
    this.git(['read-tree', '--empty'], true, undefined, env);
    // Bound both argv and stdin: one process per file blocks other requests,
    // while an unbounded synchronous pipe can stall on macOS.
    const batches = <T>(entries: T[], payload: (entry: T) => string) => {
      const groups: T[][] = []; let group: T[] = [], bytes = 0;
      for (const entry of entries) {
        const size = Buffer.byteLength(payload(entry)) + 1;
        if (group.length && (group.length >= 128 || bytes + size > 48 * 1024)) { groups.push(group); group = []; bytes = 0; }
        group.push(entry); bytes += size;
      }
      if (group.length) groups.push(group); return groups;
    };
    const temporary = mkdtempSync(join(this.store.root, 'recovery', 'git-objects-')), stubs: string[] = [];
    try {
      const inputs = new Map<string, string>(), objects = new Map<string, string>();
      for (const path of keys) {
        validPath(path); const digest = manifest[path]; if (inputs.has(digest)) continue;
        const info = objectInfo(this.store.root, digest);
        if (info.text) inputs.set(digest, objectPath(this.store.root, digest));
        else {
          const stub = join(temporary, digest); stubs.push(stub);
          writeFileSync(stub, `team-file-v1\nsha256 ${digest}\nbytes ${info.bytes}\n`, { flag: 'wx', mode: 0o600 }); inputs.set(digest, stub);
        }
      }
      for (const group of batches([...inputs], entry => entry[1])) {
        const receipts = this.git(['hash-object', '-w', '--no-filters', '--', ...group.map(entry => entry[1])]).split('\n');
        requireThat(receipts.length === group.length && receipts.every(oid => /^[a-f0-9]{40}$/.test(oid)), '版本对象写入回执无效', 503);
        group.forEach(([digest], n) => objects.set(digest, receipts[n]));
      }
      const entries = keys.map(path => `100644 ${objects.get(manifest[path])}\t${path}\0`);
      for (const group of batches(entries, entry => entry)) this.git(['update-index', '-z', '--index-info'], true, group.join(''), env);
    } finally {
      for (const stub of stubs) if (existsSync(stub)) unlinkSync(stub);
      rmdirSync(temporary);
    }
    const tree = this.git(['write-tree'], true, undefined, env);
    const rev = this.git(['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', `Platform revision ${id()}`]);
    const doc = { id: rev, manifest, parent: parent ?? null, created: now() }; this.store.put('revision', doc);
    const dir = join(this.store.root, 'snapshots', rev); mkdirSync(dir, { recursive: true });
    for (const path of keys) { const dest = join(dir, path); mkdirSync(dirname(dest), { recursive: true }); copyFileSync(objectPath(this.store.root,manifest[path]),dest,constants.COPYFILE_FICLONE);chmodSync(dest,0o444); }
    return doc;
  }
  scan(dir = this.canonical, maxBytes = MAX_PROJECT_BYTES): Manifest {
    requireThat(existsSync(dir) && lstatSync(dir).isDirectory() && !lstatSync(dir).isSymbolicLink() && realpathSync(dir)===resolve(dir),'项目目录不存在或包含符号链接，暂停读取',409);
    const out: Manifest = {};let size=0,count=0,textSize=0;
    const walk=(base:string,rel='')=>{for(const entry of readdirSync(base)){const p=rel?`${rel}/${entry}`:entry;validPath(p);const full=join(base,entry),st=lstatSync(full);requireThat(!st.isSymbolicLink()&&realpathSync(full)===full,'检测到符号链接，暂停导入',409);if(st.isDirectory())walk(full,p);else{requireThat(st.isFile(),'检测到特殊文件',409);size+=st.size;requireThat(st.size<=MAX_FILE_BYTES&&size<=8*1024*1024*1024&&++count<=10000,'目录超过单文件256 MiB、总量8 GiB或10000文件上限',413);const digest=storeFile(this.store.root,full);out[p]=digest;const info=objectInfo(this.store.root,digest);if(info.text)textSize+=info.bytes;requireThat(textSize<=maxBytes,'文本资料合计超过16 MiB，原件未改动',409);}}};walk(dir);return out;
  }
  assertClean(allowOversized = false) { this.assertReady(); const b = this.revision().manifest; const a = this.scan(this.canonical, allowOversized ? Math.max(MAX_PROJECT_BYTES, this.textBytes(b)) : MAX_PROJECT_BYTES); requireThat(manifestHash(a) === manifestHash(b), '检测到平台外修改，请先由超管查看差异并导入', 409); }
  materialize(rev: Doc) {
    const external=this.canonical!==join(this.store.root,'project');
    requireThat(realpathSync(dirname(this.canonical))===dirname(this.canonical),'项目父目录身份改变，暂停发布',409);
    const stage = external?join(dirname(this.canonical),`.${basename(this.canonical)}.platform-publish-${id()}`):join(this.store.root, 'recovery', `publish-${id()}`); mkdirSync(stage,{mode:0o700});
    diskSpace(dirname(this.canonical),this.manifestBytes(rev.manifest));
    for (const [path, digest] of Object.entries(rev.manifest) as [string, string][]) { const dest = join(stage, validPath(path)); mkdirSync(dirname(dest), { recursive: true }); objectInfo(this.store.root,digest);copyFileSync(objectPath(this.store.root,digest),dest,constants.COPYFILE_FICLONE); }
    if (existsSync(this.canonical)) renameSync(this.canonical, external?join(dirname(this.canonical),`.${basename(this.canonical)}.platform-previous-${id()}`):join(this.store.root, 'recovery', `previous-${id()}`));
    renameSync(stage, this.canonical);
  }
  finish(intent: Doc) {
    const currentRef = this.git(['rev-parse', 'refs/heads/main']);
    requireThat(currentRef === intent.old || currentRef === intent.next, 'Git 引用存在未登记变化，需恢复检查', 503);
    const old = this.revision(intent.old), next = this.revision(intent.next);
    const target=intent.directoryChange?.path??this.canonical;
    if(intent.directoryChange)this.directoryPath(target);
    if (existsSync(target)) {
      const actual = manifestHash(this.scan(target, Math.max(MAX_PROJECT_BYTES, this.textBytes(old.manifest), this.textBytes(next.manifest))));
      requireThat((!intent.directoryChange && actual === manifestHash(old.manifest)) || actual === manifestHash(next.manifest), '恢复期间发现新的外部文件变更，原件已保留；请先核对，未覆盖目录', 409);
    }
    if (currentRef === intent.old) this.git(['update-ref', 'refs/heads/main', intent.next, intent.old]);
    this.store.put('intent', { ...intent, phase: 'ref_updated' });
    if(!intent.directoryChange)this.materialize(next);
    this.store.tx(() => {
      this.store.put('project', { ...this.current(), revision: intent.next, ...(intent.directoryChange?{directory:target,directoryOwnerRoot:this.store.root,name:intent.directoryChange.name}: {}) });
      if(intent.directoryChange){const preview=this.store.get('directory-preview',intent.directoryChange.preview)!;this.store.put('directory-preview',{...preview,state:'bound',boundRevision:intent.next});}
      const c = this.store.get('change', intent.change)!; this.store.put('change', { ...c, state: 'committed', revision: intent.next });
      if (c.task) { const t = this.store.get('task', c.task)!; this.store.put('task', { ...t, state: 'completed' }); }
      this.store.put('intent', { ...intent, phase: 'published' });
      this.store.event('*', 'project.updated', { revision: intent.next, files: Object.keys(c.writes), author: c.authorName });
      this.store.audit(intent.actor, 'project.publish', c.id, { revision: intent.next });
    });
    this.canonical=target;
  }
  recover() { const pending = this.pending(); requireThat(pending.length <= 1, '存在多个未完成发布，需人工核对原提交顺序，未自动改写版本', 503); for (const i of pending) this.finish(i); requireThat(this.git(['rev-parse', 'refs/heads/main']) === this.current().revision, '版本存储不一致，暂停服务', 503); }
  candidate(user: Doc, base: string, writes: Record<string, string | null>, reads: Manifest, extra: Doc = {}) {
    requireThat(user.role==='admin'||Object.values(writes).every(v=>v!==null),'成员不能删除主机文件',403);
    requireThat(Object.keys(writes).length > 0 && Object.keys(writes).length <= 32, '候选需含 1–32 个文件');
    const frozen: Record<string, string | null> = {}; const before: Manifest = this.revision(base).manifest;
    for (const [p, text] of Object.entries(writes)) { validPath(p); requireThat(text === null || typeof text === 'string', '候选内容必须是文本'); frozen[p] = text === null ? null : this.blob(text); }
    return this.candidateObjects(user,base,frozen,reads,extra);
  }
  candidateObjects(user:Doc,base:string,frozen:Record<string,string|null>,reads:Manifest,extra:Doc={}) {
    requireThat(Object.keys(frozen).length>0&&Object.keys(frozen).length<=32,'候选需含 1–32 个文件');
    const before:Manifest=this.revision(base).manifest;
    for(const [p,digest]of Object.entries(frozen)){validPath(p);if(digest!==null)objectInfo(this.store.root,digest);}
    const digest = hash(JSON.stringify({ base, writes: frozen, reads }));
    const doc = { ...extra, id: id(), owner: user.id, authorName: user.name, base, writes: frozen, reads, digest, state: 'submitted', created: now(), before: Object.fromEntries(Object.keys(frozen).map(p => [p, before[p] ?? null])) };
    this.store.tx(() => { this.store.put('change', doc); this.store.event(user.id, 'change.submitted', { id: doc.id }); this.store.audit(user.id, 'change.submit', doc.id, { digest }); }); return doc;
  }
  addAttachment(user:Doc,path:string,digest:string,uploadId:string){
    const fresh=this.store.get('user',user.id);requireThat(fresh?.active,'账号已停用',403);validPath(path);objectInfo(this.store.root,digest);
    const old=this.store.all('change').find(c=>c.uploadId===uploadId);if(old){requireThat(old.writes[path]===digest,'上传内容已改变',409);if(old.state!=='committed')this.recover();return this.store.get('change',old.id)!;}
    this.assertClean();const manifest=this.revision().manifest;requireThat(!manifest[path],'上传不能覆盖现有文件',409);
    const base=this.current().revision,next=this.makeRevision({...manifest,[path]:digest},base),change:Doc={id:id(),owner:user.id,authorName:user.name,base,writes:{[path]:digest},before:{[path]:null},reads:{},digest:hash(JSON.stringify({path,digest,base})),state:'approved',created:now(),uploadId,automaticAddition:true};
    const intent={id:id(),old:base,next:next.id,change:change.id,actor:user.id,phase:'prepared',created:now()};this.store.tx(()=>{this.store.put('change',change);this.store.put('intent',intent);});this.finish(intent);return this.store.get('change',change.id)!;
  }
  approvePickup(c: Doc, actor: Doc, digest: string, jobId: string) {
    const j = this.store.get('video-job', jobId); const saved = this.store.get('change', c.id);
    requireThat(j && j.owner === actor.id && j.state === 'ready' && j.technicalQA?.passed && saved?.pickupJobId === jobId && j.changeId === c.id, '补抽采用授权无效', 403);
    return this.approve(c, actor, digest, jobId);
  }
  publishNative(c:Doc,actor:Doc){const saved=this.store.get('change',c.id);requireThat(saved?.nativeWorkspace&&saved.owner===actor.id,'只能发布本人当前项目的工作区改动',403);return this.approve(saved,actor,saved.digest,undefined,true);}
  assertMemberPublication(c:Doc,actor:Doc){
    if(actor.role==='admin')return;
    const before:Manifest=this.revision(c.base).manifest,remaining=new Map<string,number>();
    // A filesystem rename appears as remove+add. Every removed original must
    // survive, byte-for-byte, at a distinct newly introduced path. Existing
    // destinations and one copy replacing multiple originals are not renames.
    for(const [path,digest] of Object.entries(c.writes) as [string,string|null][]){
      if(digest!==null&&!before[path])remaining.set(digest,(remaining.get(digest)??0)+1);
    }
    for(const [path,digest] of Object.entries(c.writes))if(digest===null){
      const original=before[path],count=remaining.get(original)??0;
      requireThat(!!original&&count>0,'成员不能删除主机文件；重命名需同时发布原路径和保留原内容的新路径',403);
      remaining.set(original,count-1);
    }
  }
  approve(c: Doc, actor: Doc, digest: string, pickupJobId?: string, nativePublish=false) {
    actor = this.store.get('user', actor.id)!; requireThat(actor?.active, '审核账号已停用', 403);
    c = this.store.get('change', c.id)!;
    if(nativePublish)this.assertMemberPublication(c,actor);
    requireThat(actor.role === 'admin' || nativePublish&&c.nativeWorkspace&&c.owner===actor.id || pickupJobId && c.pickupJobId === pickupJobId && c.owner === actor.id, '仅超级管理员可审核', 403); requireThat(c.state === 'submitted', '候选状态已改变', 409); requireThat(c.digest === digest, '候选版本已改变，需重新审核', 409);
    this.assertReady();
    if (c.external) { requireThat(manifestHash(this.scan(this.canonical, Math.max(MAX_PROJECT_BYTES, this.textBytes(this.revision().manifest)))) === c.externalDigest, '外部资料已再次变化，请重新检测', 409); } else this.assertClean(true);
    const current = this.revision().manifest;
    const conflict = Object.keys({ ...c.reads, ...c.before }).filter(p => (current[p] ?? null) !== (p in c.reads ? c.reads[p] : c.before[p]));
    if (conflict.length || (c.treeDependency && c.base !== this.current().revision)) { this.store.put('change', { ...c, state: 'conflict', conflicts: conflict }); throw new Problem(409, `资料已变化，需重新生成候选：${conflict.join('、') || '输入目录版本'}`); }
    requireThat(this.store.get('user', c.owner)?.active, '作者账号已停用，不能继续提交', 409);
    const manifest = { ...current }; for (const [p, digest] of Object.entries(c.writes)) { if (digest === null) delete manifest[p]; else manifest[p] = digest; }
    const next = this.makeRevision(manifest, this.current().revision);
    const intent = { id: id(), old: this.current().revision, next: next.id, change: c.id, actor: actor.id, phase: 'prepared', created: now() };
    this.store.tx(() => { this.store.put('change', { ...c, state: 'approved', approvedBy: actor.id, approvedDigest: digest }); this.store.put('intent', intent); this.store.audit(actor.id, 'change.approve', c.id, { digest }); });
    this.finish(intent); return this.store.get('change', c.id)!;
  }
  directoryPath(value:unknown,creating=false) {
    requireThat(typeof value==='string' && value.length<=1000 && value===resolve(value) && value!==sep && existsSync(value),'请输入主机上已存在目录的绝对路径');
    assertStoragePath(value as string);
    const path=value as string, internal=resolve(this.store.root);
    requireThat(path===join(internal,'project') || !(path===internal || path.startsWith(internal+sep) || internal.startsWith(path+sep)), '不能将平台数据、凭据、备份目录或其上级设为项目目录',403);
    requireThat(lstatSync(path).isDirectory() && !lstatSync(path).isSymbolicLink() && realpathSync(path)===path,'项目目录及上级不能经过符号链接',409);
    for(const p of this.store.global.all('project')){if(!creating&&p.id===this.projectId)continue;const other=p.directory??(p.id==='shared'?join(internal,'project'):undefined);requireThat(!other||!(path===other||path.startsWith(other+sep)||other.startsWith(path+sep)),'项目目录不能与另一项目相同、重叠或互为上下级',409);}
    return path;
  }
  managedDirectory(projectId:string) {
    requireThat(/^[a-f0-9-]{36}$/.test(projectId),'项目编号无效');
    const base=join(this.store.root,'member-projects');
    if(!existsSync(base))mkdirSync(base,{mode:0o700});
    requireThat(lstatSync(base).isDirectory()&&!lstatSync(base).isSymbolicLink()&&realpathSync(base)===base,'项目存储目录身份改变，暂停创建',409);
    const target=join(base,projectId);
    if(!existsSync(target))mkdirSync(target,{mode:0o700});
    requireThat(lstatSync(target).isDirectory()&&!lstatSync(target).isSymbolicLink()&&realpathSync(target)===target,'项目文件夹身份改变，暂停创建',409);
    assertStoragePath(target);return target;
  }
  previewManaged(user:Doc,name:unknown,requestId:unknown) {
    const fresh=this.store.global.get('user',user.id);requireThat(fresh?.active&&['admin','member'].includes(fresh.role),'账号无权新建项目',403);
    requireThat(typeof name==='string'&&name.trim()&&name.trim().length<=80&&!/[\x00-\x1f\x7f]/.test(name),'请输入 1–80 字的项目名称');
    requireThat(typeof requestId==='string'&&(/^[a-f0-9]{32}$/.test(requestId)||/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(requestId)),'创建请求编号无效');
    const normalized=name.trim().normalize('NFC'),key='managed-'+hash(JSON.stringify([user.id,requestId]));
    const old=this.store.global.get('project-create-preview',key);
    if(old){requireThat(old.name===normalized&&old.owner===user.id&&old.mode==='managed','同一创建请求的名称已改变',409);return old;}
    const same=(value:string)=>value.normalize('NFC').toLocaleLowerCase()===normalized.toLocaleLowerCase();
    requireThat(!this.store.global.all('project').some(p=>same(p.name))&&!this.store.global.all('project-create-preview').some(p=>p.mode==='managed'&&p.state!=='created'&&same(p.name)),'项目名称已存在',409);
    const projectId=id(),target=this.managedDirectory(projectId);
    const preview:Doc={id:key,projectId,owner:user.id,path:target,name:normalized,mode:'managed',manifest:{},files:0,bytes:0,requestId,created:now(),state:'preview'};
    preview.digest=hash(JSON.stringify(preview));this.store.global.put('project-create-preview',preview);return preview;
  }
  previewNew(user:Doc,path:unknown,name:unknown) {
    const fresh=this.store.get('user',user.id);requireThat(fresh?.active&&fresh.role==='admin','仅超级管理员可新建项目',403);
    const target=this.directoryPath(path,true);requireThat(typeof name==='string'&&name.trim()&&name.trim().length<=80,'请输入项目名称');
    requireThat(!this.store.global.all('project').some(p=>p.name.normalize('NFC').toLocaleLowerCase()===name.trim().normalize('NFC').toLocaleLowerCase()),'项目名称已存在',409);
    const manifest=this.scan(target);
    const preview:Doc={id:id(),projectId:id(),owner:user.id,path:target,name:name.trim(),manifest,files:Object.keys(manifest).length,bytes:this.manifestBytes(manifest),created:now(),state:'preview'};
    preview.digest=hash(JSON.stringify(preview));this.store.global.put('project-create-preview',preview);this.store.audit(user.id,'project.create.preview',preview.id,{path:target,files:preview.files});return preview;
  }
  previewDirectory(user:Doc, path:unknown, name:unknown) {
    requireThat(this.store.get('user',user.id)?.active && this.store.get('user',user.id)?.role==='admin','仅超级管理员可配置项目目录',403);this.assertReady();
    const target=this.directoryPath(path);requireThat(typeof name==='string' && name.trim() && name.trim().length<=80,'请输入项目名称');
    requireThat(!this.store.global.all('project').some(p=>p.id!==this.projectId&&p.name.normalize('NFC').toLocaleLowerCase()===name.trim().normalize('NFC').toLocaleLowerCase()),'项目名称已存在',409);
    const manifest=this.scan(target);
    const current=this.revision().manifest;
    const diff=[...new Set([...Object.keys(current),...Object.keys(manifest)])].filter(p=>current[p]!==manifest[p]).map(p=>({path:p,action:!manifest[p]?'removed':!current[p]?'added':'modified'}));
    const preview:Doc={id:id(),owner:user.id,path:target,name:name.trim(),base:this.current().revision,manifest,diff,files:Object.keys(manifest).length,bytes:this.manifestBytes(manifest),created:now(),state:'preview'};
    preview.digest=hash(JSON.stringify(preview));this.store.put('directory-preview',preview);this.store.audit(user.id,'project.directory.preview',preview.id,{path:target,files:preview.files});return preview;
  }
  bindDirectory(user:Doc, previewId:string, digest:string) {
    requireThat(this.store.get('user',user.id)?.active && this.store.get('user',user.id)?.role==='admin','仅超级管理员可配置项目目录',403);
    const p=this.store.get('directory-preview',previewId);requireThat(p && p.owner===user.id && p.digest===digest,'目录预览不存在或已改变，请重新预览',409);
    if(p.state==='bound')return this.current();this.assertClean();requireThat(p.base===this.current().revision,'项目版本已变化，请重新预览目录',409);
    requireThat(!this.store.global.all('project').some(other=>other.id!==this.projectId&&other.name.normalize('NFC').toLocaleLowerCase()===p.name.normalize('NFC').toLocaleLowerCase()),'项目名称已存在，请重新预览',409);
    this.directoryPath(p.path);requireThat(manifestHash(this.scan(p.path))===manifestHash(p.manifest),'目录内容在预览后已改变，请重新预览',409);
    const old=this.revision(), next=this.makeRevision(p.manifest,old.id);const writes:Doc={},before:Doc={};
    for(const row of p.diff){writes[row.path]=p.manifest[row.path]??null;before[row.path]=old.manifest[row.path]??null;}
    const change:Doc={id:id(),owner:user.id,authorName:user.name,base:old.id,writes,before,reads:{},digest:p.digest,state:'approved',created:now(),directoryBinding:true};
    const intent={id:id(),old:old.id,next:next.id,change:change.id,actor:user.id,phase:'prepared',created:now(),directoryChange:{path:p.path,name:p.name,preview:p.id,dataRoot:this.store.root}};
    this.store.tx(()=>{this.store.put('change',change);this.store.put('intent',intent);this.store.audit(user.id,'project.directory.bind',p.id,{digest:p.digest,path:p.path});});
    this.finish(intent);return this.current();
  }
  external(user: Doc) {
    this.assertReady();const current=this.revision().manifest,actual=this.scan(this.canonical,Math.max(MAX_PROJECT_BYTES,this.textBytes(current))),writes:Doc={};
    for(const p of new Set([...Object.keys(actual),...Object.keys(current)]))if(actual[p]!==current[p])writes[p]=actual[p]??null;
    requireThat(Object.keys(writes).length,'没有检测到外部差异');const base=this.current().revision,digest=hash(JSON.stringify({base,writes,reads:current}));
    const doc={id:id(),owner:user.id,authorName:user.name,base,writes,reads:current,digest,state:'submitted',created:now(),before:Object.fromEntries(Object.keys(writes).map(p=>[p,current[p]??null])),external:true,treeDependency:true,externalDigest:manifestHash(actual)};
    this.store.tx(()=>{this.store.put('change',doc);this.store.event(user.id,'change.submitted',{id:doc.id});this.store.audit(user.id,'change.submit',doc.id,{digest});});return doc;
  }
}
