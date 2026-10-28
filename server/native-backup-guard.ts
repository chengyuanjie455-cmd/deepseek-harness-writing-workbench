import {requireThat,type Doc} from './store.ts';
type Run=(args:string[])=>string;
const ids=(raw:string)=>[...new Set(raw.trim().split(/\s+/).filter(Boolean))].sort();
const same=(a:string[],b:string[])=>JSON.stringify(a)===JSON.stringify(b);

/** Docker inventory is not atomic: an unrelated container can disappear after
 * ps. Retry a changed inventory, never interpret an unverified one as stopped. */
export function assertNativeBackupStopped(data:string,run:Run,hasNativeState:boolean){
 const list=()=>ids(run(['ps','--no-trunc','-q']));let names:string[];
 try{names=list();}catch{requireThat(!hasNativeState,'无法检查 Docker，先确认原生环境停止再备份');return;}
 for(let attempt=0;attempt<3;attempt++){
  if(!names.length)return;
  let live:Doc[];
  try{live=JSON.parse(run(['inspect',...names]));}
  catch{
   let next:string[];try{next=list();}catch{requireThat(false,'无法核对 Docker 当前状态，备份未开始',409);}
   requireThat(!same(names,next!),'无法核对运行中的 Docker 容器，备份未开始',409);names=next!;continue;
  }
  requireThat(Array.isArray(live)&&live.length===names.length&&names.every(name=>live.filter(c=>c?.Id===name&&Array.isArray(c.Mounts)).length===1),'Docker 容器检查不完整，备份未开始',409);
  requireThat(!live.some(c=>c.Mounts.some((m:Doc)=>m.Source===data||String(m.Source).startsWith(data+'/native-harness/'))),'原生环境仍在运行，请先停止主机后备份',409);
  let next:string[];try{next=list();}catch{requireThat(false,'无法复核 Docker 当前状态，备份未开始',409);}
  if(same(names,next!))return;names=next!;
 }
 requireThat(false,'Docker 容器列表持续变化，未能确认离线状态；备份未开始，可稍后重试',409);
}
