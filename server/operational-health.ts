import {statfsSync,readFileSync,existsSync,writeFileSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {freemem,totalmem,loadavg,cpus} from 'node:os';
import {now,type Store,type Doc} from './store.ts';
import {memorySnapshot} from './host-memory.ts';
export function backupStatus(root:string){try{return JSON.parse(readFileSync(join(root,'backup-status.json'),'utf8'));}catch{return {lastSuccess:null,lastAttempt:null};}}
export function recordBackupStatus(root:string,patch:Doc){const file=join(root,'backup-status.json');const current=backupStatus(root);writeFileSync(file+'.tmp',JSON.stringify({...current,...patch}),{mode:0o600});renameSync(file+'.tmp',file);}
export function residentStatus(root:string){try{return JSON.parse(readFileSync(join(root,'host-status.json'),'utf8'));}catch{return undefined;}}
const age=(value:unknown,clock:number)=>{const at=typeof value==='string'?Date.parse(value):NaN;return Number.isFinite(at)&&at<=clock+60000?Math.max(0,clock-at):Infinity;};
// Probe errors can contain provider URLs or credentials. Persist only their
// bounded type/code; keep the last successful sample distinguishable from now.
const probeError=(error:any)=>({name:typeof error?.name==='string'?error.name.replace(/[^a-zA-Z0-9_-]/g,'').slice(0,80):'Error',...(typeof error?.code==='string'?{code:error.code.replace(/[^a-zA-Z0-9_-]/g,'').slice(0,80)}:{})});
type MonitorState={state:'not_started'|'healthy'|'failed'|'stopped';checkedAt:string|null;lastSuccessAt:string|null;consecutiveFailures:number;error?:ReturnType<typeof probeError>};
export function operationalHealth(store:Store,clock=Date.now(),sample?:Doc,monitor?:Doc){
 const alerts:Doc[]=[],add=(id:string,severity:string,title:string,detail:string)=>alerts.push({id,severity,title,detail});
 let resource=sample;
 if(!resource)try{const disk=statfsSync(store.root);resource={...memorySnapshot(),diskFreeBytes:disk.bavail*disk.bsize,diskTotalBytes:disk.blocks*disk.bsize,memoryFreeBytes:freemem(),memoryTotalBytes:totalmem(),processRss:process.memoryUsage().rss,load1:loadavg()[0],cpuCount:cpus().length};}catch(error){resource={unavailable:true,error:probeError(error)};}
 if(resource.unavailable)add('resource-probe','warning','主机资源状态暂不可用','本次无法读取系统或存储指标，不能据此判断资源正常；请核对主机与数据盘。');
 if(resource.diskFreeBytes<10*1024**3)add('disk',resource.diskFreeBytes<2*1024**3?'critical':'warning','磁盘空间偏低','请检查备份、原片和临时文件占用；新媒体仍沿用容量检查。');
 if(resource.memorySource==='macos'){
  if(['warning','critical'].includes(resource.memoryPressure))add('memory',resource.memoryPressure==='critical'?'critical':'warning','主机内存压力'+(resource.memoryPressure==='critical'?'严重':'偏高'),'macOS 已报告内存压力，请结合交换空间和进程占用核对承载情况。');
  if(['unavailable','stale'].includes(resource.memoryProbe))add('memory-probe','info','内存压力指标暂不可用','当前压力未知，请检查系统指标；不会按正常状态处理。');
 }else if(resource.memoryFreeBytes/resource.memoryTotalBytes<0.08)add('memory','warning','主机可用内存偏低','观察容器和后台进程占用，超出承载能力时先排队。');
 if(resource.swapUsedBytes>=8*1024**3)add('swap','info','主机交换空间使用较多','交换空间使用量较高，请结合内存压力和磁盘空间观察；已有交换数据不等于当前内存不足。');
 const jobs=[...store.all('video-job'),...store.all('image-job')];
 const unknown=jobs.filter(j=>j.state==='submission_unknown');if(unknown.length)add('unknown-media','warning','有 '+unknown.length+' 条生成回执待核对','请在任务排查中关联原结果或核对结案。');
 const slow=jobs.filter(j=>['preparing','submitting','running','downloading','checking'].includes(j.state)&&clock-Date.parse(j.submitIntentAt??j.created)>3600000);if(slow.length)add('slow-media','warning','有 '+slow.length+' 条生成任务超过 1 小时','按原供应商编号核对进度；不要重复创建。');
 const polling=jobs.filter(j=>j.consecutiveErrors>=5&&['running','downloading','checking'].includes(j.state));if(polling.length)add('poll-errors','warning','有 '+polling.length+' 条任务连续恢复失败','检查供应商连接、原片地址和本机存储。');
 const calls=store.all('model-call'),recent=calls.filter(c=>clock-Date.parse(c.finished??c.created)<15*60000),failed=recent.filter(c=>c.providerStatus>=400);
 if(failed.length>=5&&failed.length/Math.max(recent.length,1)>=0.2)add('provider-errors','warning','近 15 分钟模型调用错误偏多',`${failed.length} / ${recent.length} 条调用异常，请核对渠道和模型。`);
 if(recent.some(c=>[401,403].includes(c.providerStatus)))add('credentials','critical','模型认证或访问权限异常','在模型设置核对密钥、席位与可用范围。');
 if(recent.some(c=>c.providerStatus===402))add('balance','critical','供应商余额或计费异常','请由管理员核对供应商账户。');
 const unknownUsage=calls.filter(c=>c.state==='unconfirmed');if(unknownUsage.length)add('usage','info','有 '+unknownUsage.length+' 条调用用量待核对','按模型汇总核对，未知用量不会按零费用处理。');
 const backup=backupStatus(store.root);if(backup.lastAttempt?.status==='failed')add('backup-failed','warning','最近备份失败',backup.lastAttempt.reason??'请查看备份日志并重新验证。');
 if(age(backup.lastSuccess?.at,clock)>26*3600000)add('backup-stale','info','最近备份已超过 26 小时、时间无效或尚未登记','请检查自动备份状态；只有一致性及文件核对通过后才登记成功。');
 if(backup.independentRequired&&(!backup.independent||backup.independent.status!=='verified'||age(backup.independent.at,clock)>26*3600000))add('backup-independent','warning','独立磁盘备份尚未完成、时间无效或已过期','检查指定备份盘是否挂载；主盘备份不能代替独立副本。');
 const resident=residentStatus(store.root);if(resident){if(age(resident.checkedAt,clock)>90000)add('resident-stale','warning','主机守护状态超过 90 秒未更新或时间无效','后台可能仍在运行，请核对主机守护进程。');else if(!['healthy','maintenance'].includes(resident.state))add('resident','critical','主机守护检测到异常',resident.error??resident.state);}
 if(monitor){if(monitor.state==='failed')add('monitor-probe','warning','后台监控采集失败','当前采集状态未知，已保留最近成功时间，下一轮将继续采集；页面响应不代表后台监控正常。');else if(monitor.state==='stopped'||monitor.state==='not_started')add('monitor-stopped','warning','后台监控尚未运行或已停止','本页可以读取当前状态，但后台定时采集未运行，请核对监控进程。');else if(age(monitor.checkedAt,clock)>90000)add('monitor-stale','warning','后台监控超过 90 秒未采集或时间无效','正在展示的采集心跳已过期，不能以页面刷新时间代替后台采集时间。');}
 return {checkedAt:new Date(clock).toISOString(),resource,backup,resident,monitor,alerts};
}
export class OperationsMonitor{
 timer?:ReturnType<typeof setInterval>;
 private last:MonitorState={state:'not_started',checkedAt:null,lastSuccessAt:null,consecutiveFailures:0};
 constructor(public store:Store,private collect=operationalHealth,private clock=()=>Date.now()){}
 snapshot(clock=this.clock()){const stale=this.last.state==='healthy'&&age(this.last.checkedAt,clock)>90000;return {...this.last,running:!!this.timer,stale,label:stale?'数据过期':({healthy:'运行中',failed:'采集失败',stopped:'已停止',not_started:'尚未启动'} as Doc)[this.last.state]??'状态未知',intervalMs:30000};}
 tick(){const clock=this.clock(),checkedAt=new Date(clock).toISOString(),next:MonitorState={state:'healthy',checkedAt,lastSuccessAt:checkedAt,consecutiveFailures:0};
 try{const health=this.collect(this.store,clock,undefined,{...next,running:!!this.timer}),before=this.store.get('operations-alerts','active')?.items??[],previous=new Map(before.map((a:Doc)=>[a.id,a])),current=new Map(health.alerts.map(a=>[a.id,a]));
  const changed=health.alerts.filter(a=>JSON.stringify(previous.get(a.id))!==JSON.stringify(a)),resolved=[...before.filter((a:Doc)=>!current.has(a.id)),...(this.last.state==='failed'?[{id:'monitor-probe',title:'后台监控采集失败'}]:[])];
  this.store.tx(()=>{this.store.put('operations-monitor',{id:'status',...next});if(changed.length||resolved.length){this.store.put('operations-alerts',{id:'active',items:health.alerts,checkedAt:health.checkedAt});for(const a of changed)this.store.audit('server','operations.alert',a.id,{severity:a.severity,title:a.title});for(const a of resolved)this.store.audit('server','operations.alert_resolved',a.id,{title:a.title});for(const user of this.store.all('user').filter(u=>u.active&&u.role==='admin'))this.store.event(user.id,'operations.alert',{changed:changed.map(a=>a.id),resolved:resolved.map((a:Doc)=>a.id)});}});this.last=next;return health;
 }catch(error){const previous=this.last;this.last={...previous,state:'failed',checkedAt,lastSuccessAt:previous.lastSuccessAt,consecutiveFailures:(previous.consecutiveFailures??0)+1,error:probeError(error)};
  try{this.store.tx(()=>{this.store.put('operations-monitor',{id:'status',...this.last});if(previous.state!=='failed'||JSON.stringify(previous.error)!==JSON.stringify(this.last.error)){this.store.audit('server','operations.monitor.failed','status',{error:this.last.error});for(const user of this.store.all('user').filter(u=>u.active&&u.role==='admin'))this.store.event(user.id,'operations.alert',{changed:['monitor-probe'],resolved:[]});}});}catch{/* The in-memory snapshot still exposes a failed heartbeat when persistence is unavailable. */}
  return {checkedAt,monitor:this.snapshot(clock),resource:{unavailable:true},alerts:[{id:'monitor-probe',severity:'warning',title:'后台监控采集失败',detail:'当前采集状态未知，下一轮将继续采集。'}]};
 }
 }
 start(){if(this.timer)return;this.timer=setInterval(()=>this.tick(),30000);this.timer.unref();this.tick();}
 close(){if(!this.timer&&this.last.state==='not_started')return;clearInterval(this.timer);this.timer=undefined;this.last={...this.last,state:'stopped'};try{this.store.put('operations-monitor',{id:'status',...this.last});}catch{}}
}
