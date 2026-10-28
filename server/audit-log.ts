import {Store,requireThat,type Doc} from './store.ts';
import {billingPeriod} from './billing-summary.ts';
import {auditCategories,auditCategory,auditLabels} from '../shared/operations.ts';

export function safeAuditDetail(value:any,depth=0):any{
 if(depth>10)return '[层级过深，已省略]';
 if(typeof value==='string')return value.slice(0,16000).replace(/(Bearer\s+)\S+/gi,'$1[已隐藏]').replace(/([?&](?:token|api_key|key|secret)=)[^&\s]+/gi,'$1[已隐藏]');
 if(Array.isArray(value))return value.slice(0,200).map(v=>safeAuditDetail(v,depth+1));
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).slice(0,200).map(([k,v])=>[k,/(?:password|passwd|api.?key|secret|authorization|cookie|access.?token|refresh.?token|^token$)/i.test(k)?'[已隐藏]':safeAuditDetail(v,depth+1)]));
 return value;
}
/** Stable keyset pages: new events never shift the currently inspected history. */
export function auditLog(store:Store,query:URLSearchParams){
 const q=(query.get('q')??'').trim(),actor=query.get('actor')??'',category=query.get('category')??'',action=query.get('action')??'',project=query.get('auditProject')??'';
 requireThat(q.length<=200&&actor.length<=100&&action.length<=150&&project.length<=100,'审计筛选内容过长');requireThat(!category||category in auditCategories,'审计类别无效');
 const includeReads=query.get('includeReads')??'1';requireThat(['0','1'].includes(includeReads),'查阅记录筛选无效');
 const period=billingPeriod(query.get('from')??'',query.get('to')??'');
 const integer=(name:string,fallback:number,min:number,max:number)=>{const raw=query.get(name),n=raw===null?fallback:Number(raw);requireThat(raw!==''&&Number.isSafeInteger(n)&&n>=min&&n<=max,'审计分页参数无效');return n;};
 const max=Number((store.db.prepare('SELECT COALESCE(MAX(seq),0) AS n FROM audit').get() as any).n),snapshot=integer('snapshot',max,0,Number.MAX_SAFE_INTEGER),before=integer('before',snapshot+1,1,Number.MAX_SAFE_INTEGER),limit=integer('limit',50,1,100);
 const clauses=['seq<=?'],args:any[]=[snapshot];const users=store.all('user'),projects=store.all('project');
 if(includeReads==='0'&&category!=='access')clauses.push("action NOT LIKE 'admin.%'");
 if(actor){clauses.push('actor=?');args.push(actor);}if(action){clauses.push('action=?');args.push(action);}
 const actions=(store.db.prepare('SELECT DISTINCT action FROM audit').all() as Doc[]).map(r=>r.action);
 if(category){const values=actions.filter(a=>auditCategory(a)===category);clauses.push(values.length?'action IN ('+values.map(()=>'?').join(',')+')':'0');args.push(...values);}
 if(project){clauses.push("CASE WHEN json_valid(detail) THEN json_extract(detail,'$.project') ELSE NULL END = ?");args.push(project);}
 if(period.from){clauses.push('created>=?');args.push(new Date(period.from+'T00:00:00+08:00').toISOString());}if(period.to){clauses.push('created<?');args.push(new Date(Date.parse(period.to+'T00:00:00+08:00')+86400000).toISOString());}
 if(q){const like='%'+q.replace(/[!%_]/g,'!$&')+'%',actorIds=users.filter(u=>[u.name,u.username].some(s=>String(s??'').toLowerCase().includes(q.toLowerCase()))).map(u=>u.id),labelActions=actions.filter(a=>(auditLabels[a]??'').includes(q));if('系统服务'.includes(q))actorIds.push('server');const extra=[];if(actorIds.length)extra.push('actor IN ('+actorIds.map(()=>'?').join(',')+')');if(labelActions.length)extra.push('action IN ('+labelActions.map(()=>'?').join(',')+')');clauses.push("(action LIKE ? ESCAPE '!' OR target LIKE ? ESCAPE '!' OR actor LIKE ? ESCAPE '!'"+(extra.length?' OR '+extra.join(' OR '):'')+')');args.push(like,like,like,...actorIds,...labelActions);}
 const where=clauses.join(' AND '),total=Number((store.db.prepare('SELECT count(*) AS n FROM audit WHERE '+where).get(...args) as any).n);
 const rows=store.db.prepare('SELECT * FROM audit WHERE '+where+' AND seq<? ORDER BY seq DESC LIMIT ?').all(...args,before,limit+1) as Doc[],hasMore=rows.length>limit;
 const items:Doc[]=rows.slice(0,limit).map(r=>{let detail:any;try{detail=JSON.parse(r.detail);}catch{detail={note:'旧记录内容无法解析'};}const user=users.find(u=>u.id===r.actor);return {...r,detail:safeAuditDetail(detail),label:auditLabels[r.action]??r.action,category:auditCategory(r.action),actorName:r.actor==='server'?'系统服务':user?.name??user?.username??'历史账号',username:user?.username??'',project:detail?.project??null,projectName:detail?.project?(projects.find(p=>p.id===detail.project)?.name??detail.project):'系统 / 未标注项目'};});
 return {items,total,readRecordsHidden:includeReads==='0'&&category!=='access',snapshot,nextBefore:hasMore?items.at(-1)?.seq:null,hasMore,limit,period,timezone:'Asia/Shanghai',actors:[{id:'server',name:'系统服务'},...users.map(u=>({id:u.id,name:u.name??u.username,username:u.username,active:u.active}))],projects:projects.map(p=>({id:p.id,name:p.name})),actions:actions.map(action=>({action,label:auditLabels[action]??action,category:auditCategory(action)}))};
}
