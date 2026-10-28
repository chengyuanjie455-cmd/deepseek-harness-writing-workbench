import {assertStoragePath} from './external-storage.ts';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync, existsSync, readFileSync, unlinkSync, chmodSync, lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export const id = () => randomUUID();
export const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const now = () => new Date().toISOString();
export class Problem extends Error { constructor(public status: number, message: string) { super(message); } }
export function requireThat(ok: unknown, message: string, status = 400): asserts ok { if (!ok) throw new Problem(status, message); }
export function passwordHash(password: string) { requireThat(password.length >= 12 && password.length <= 256, '密码长度需为 12–256 个字符'); const salt = randomBytes(16).toString('hex'); return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`; }
export function verifyPassword(password: string, saved: string) { if (password.length > 256) return false; const [salt, digest] = saved.split(':'); return timingSafeEqual(Buffer.from(digest, 'hex'), scryptSync(password, salt, 64)); }
export type Doc = Record<string, any>;
// Project-owned rows share one transactional database but are always read through a bound view.
const projectKinds=new Set(['native-attachment-index','assembly-job','project-content-file','project-content-index','private-skill-run','codex-run','codex-binding','incident','incident-request','incident-update','incident-action','incident-attachment','incident-failures','file-upload','revision','intent','change','directory-preview','session','message','member-chat','task','closed-request','pickup','video-job','image-plan','image-job','media','media-check','harness','video-quota-request','video-source-history','video-upload']);
export class Store {
  global: Store; projectId?: string;
  scoped(projectId:string){return new Store(this.root,this.global,projectId);}
  visible(kind:string,doc:Doc){return !this.projectId||!projectKinds.has(kind)||(doc.project??'shared')===this.projectId;}
  db: DatabaseSync;
  lock: string;
  constructor(public root: string, parent?:Store, projectId?:string, role:'api'|'media-worker'='api') {
    this.global=parent??this;this.projectId=projectId;
    if(parent){this.db=parent.db;this.lock=parent.lock;return;}
    assertStoragePath(root);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    requireThat(!lstatSync(root).isSymbolicLink(), '数据目录不能是符号链接');
    root=realpathSync(root);this.root=root;
    chmodSync(root, 0o700);
    // One API owner and one cooperating media executor. SQLite serializes their
    // short WAL transactions; neither process shares a connection or a network DB.
    this.lock = join(root, role==='media-worker'?'media-worker.lock':'writer.lock');
    if (existsSync(this.lock)) {
      let owner: number;
      try { owner = JSON.parse(readFileSync(this.lock, 'utf8')).pid; } catch { throw new Error('写者锁损坏，需人工检查'); }
      let live = true;
      try { process.kill(owner!, 0); } catch (e: any) { if (e.code === 'ESRCH') live = false; }
      if (live) throw new Error('该数据目录已有活动写者');
      unlinkSync(this.lock);
    }
    writeFileSync(this.lock, JSON.stringify({ pid: process.pid, instance:id(), started: now() }), { flag: 'wx', mode: 0o600 });
    this.db = new DatabaseSync(join(root, 'platform.sqlite'));
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS docs(kind TEXT NOT NULL,id TEXT NOT NULL,owner TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(kind,id));
      CREATE INDEX IF NOT EXISTS docs_owner ON docs(kind,owner);
      CREATE INDEX IF NOT EXISTS docs_state_project ON docs(kind,json_extract(body,'$.state'),coalesce(json_extract(body,'$.project'),'shared'));
      CREATE INDEX IF NOT EXISTS docs_delivery_time ON docs(kind,coalesce(json_extract(body,'$.finished'),json_extract(body,'$.created')));
      CREATE INDEX IF NOT EXISTS docs_plan ON docs(kind,json_extract(body,'$.planId'),owner);
      CREATE TABLE IF NOT EXISTS auth(token TEXT PRIMARY KEY,user_id TEXT NOT NULL,csrf TEXT NOT NULL,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS requests(owner TEXT,session_id TEXT,request_id TEXT,digest TEXT,task_id TEXT,PRIMARY KEY(owner,session_id,request_id));
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,owner TEXT NOT NULL,type TEXT NOT NULL,body TEXT NOT NULL,created TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audit(seq INTEGER PRIMARY KEY AUTOINCREMENT,actor TEXT NOT NULL,action TEXT NOT NULL,target TEXT NOT NULL,detail TEXT NOT NULL,created TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS audit_actor_seq ON audit(actor,seq);
      CREATE INDEX IF NOT EXISTS audit_action_seq ON audit(action,seq);
      CREATE INDEX IF NOT EXISTS audit_created ON audit(created);`);
  }
  get(kind: string, key: string): Doc | undefined { const row = this.db.prepare('SELECT body FROM docs WHERE kind=? AND id=?').get(kind, key) as any; const doc=row&&JSON.parse(row.body);return doc&&this.visible(kind,doc)?doc:undefined; }
  all(kind: string, owner?: string): Doc[] { const rows = owner === undefined ? this.db.prepare('SELECT body FROM docs WHERE kind=? ORDER BY rowid').all(kind) : this.db.prepare('SELECT body FROM docs WHERE kind=? AND owner=? ORDER BY rowid').all(kind, owner); return rows.map((r: any) => JSON.parse(r.body)).filter(d=>this.visible(kind,d)); }
  select(kind:string,options:{states?:string[];owner?:string;planId?:string;since?:string;due?:{field:'retryAt'|'nextPoll'|'nextRecoveryAt';at:number;missing?:boolean};limit?:number}={}):Doc[]{
    const where=['kind=?'],args:any[]=[kind];
    if(this.projectId&&projectKinds.has(kind)){where.push("coalesce(json_extract(body,'$.project'),'shared')=?");args.push(this.projectId);}
    if(options.states){if(!options.states.length)return [];where.push(`json_extract(body,'$.state') IN (${options.states.map(()=>'?').join(',')})`);args.push(...options.states);}
    if(options.owner!==undefined){where.push('owner=?');args.push(options.owner);}
    if(options.planId!==undefined){where.push("json_extract(body,'$.planId')=?");args.push(options.planId);}
    if(options.since!==undefined){requireThat(Number.isFinite(Date.parse(options.since)),'查询时间无效');where.push("coalesce(json_extract(body,'$.finished'),json_extract(body,'$.created'))>=?");args.push(options.since);}
    if(options.due){const {field,at,missing=true}=options.due;requireThat(['retryAt','nextPoll','nextRecoveryAt'].includes(field)&&Number.isFinite(at),'任务查询时间无效');where.push(`${missing?'coalesce(':''}json_extract(body,'$.${field}')${missing?',0)':''}<=?`);args.push(at);}
    if(options.limit!==undefined)requireThat(Number.isSafeInteger(options.limit)&&options.limit>0,'查询数量无效');
    const sql=`SELECT body FROM docs${options.since?' INDEXED BY docs_delivery_time':''} WHERE ${where.join(' AND ')} ORDER BY rowid${options.limit!==undefined?' LIMIT ?':''}`;
    if(options.limit!==undefined)args.push(options.limit);
    return (this.db.prepare(sql).all(...args) as any[]).map(r=>JSON.parse(r.body));
  }
  put(kind: string, doc: Doc, owner = doc.owner ?? '') { if(this.projectId&&projectKinds.has(kind)){const old=this.global.get(kind,doc.id);requireThat(!old||this.visible(kind,old),'对象不属于当前项目',409);requireThat(doc.project===undefined||doc.project===this.projectId,'对象项目不匹配',409);if(this.projectId!=='shared')doc={...doc,project:this.projectId};} this.db.prepare('INSERT INTO docs(kind,id,owner,body) VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET owner=excluded.owner,body=excluded.body').run(kind, doc.id, owner, JSON.stringify(doc)); return doc; }
  tx<T>(fn: () => T): T { if(this.global!==this)return this.global.tx(fn);this.db.exec('BEGIN IMMEDIATE'); try { const result = fn(); this.db.exec('COMMIT'); return result; } catch (e) { this.db.exec('ROLLBACK'); throw e; } }
  event(owner: string, type: string, body: Doc) { if(this.projectId)body={...body,project:this.projectId};this.db.prepare('INSERT INTO events(owner,type,body,created) VALUES(?,?,?,?)').run(owner, type, JSON.stringify(body), now()); }
  audit(actor: string, action: string, target: string, detail: Doc = {}) { if(this.projectId)detail={...detail,project:this.projectId};this.db.prepare('INSERT INTO audit(actor,action,target,detail,created) VALUES(?,?,?,?,?)').run(actor, action, target, JSON.stringify(detail), now()); }
  close() { if(this.global!==this)return;this.db.close(); if (existsSync(this.lock)&&JSON.parse(readFileSync(this.lock,'utf8')).pid===process.pid) unlinkSync(this.lock); }
}
