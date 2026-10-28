import React,{Component,Suspense,lazy,useMemo,useState,type ComponentType,type ReactNode} from 'react';
import {recoverableModule} from './module-retry';

class PanelBoundary extends Component<{label:string;retry:()=>void;children:ReactNode},{failed:boolean}>{
  state={failed:false};
  static getDerivedStateFromError(){return {failed:true};}
  render(){return this.state.failed?<section role="alert"><p>{this.props.label}暂未打开，当前聊天保持运行。</p><button onClick={this.props.retry}>重试加载</button></section>:this.props.children;}
}
function panel<T extends ComponentType<any>>(label:string,key:string,exportName:string,initial:()=>Promise<{default:T}>):T{
  const load=recoverableModule(initial,key,undefined,(value:any)=>({default:value[exportName]})),Initial=lazy(()=>load());
  return function DeferredPanel(props:Record<string,unknown>){
    const [attempt,retry]=useState(0),Content=useMemo(()=>attempt?lazy(()=>load(attempt)):Initial,[attempt]);
    return <PanelBoundary key={attempt} label={label} retry={()=>retry(v=>v+1)}><Suspense fallback={<p role="status">正在加载{label}…</p>}><Content {...props as any}/></Suspense></PanelBoundary>;
  } as T;
}

// These are view boundaries only. NativeWorkspace keeps its existing identity and lifetime.
export const MediaLibrary=panel('媒体资料','media-library.tsx','MediaLibrary',()=>import('./media-library').then(m=>({default:m.MediaLibrary})));
export const ProjectFileTree=panel('项目文件','project-hub.tsx','ProjectFileTree',()=>import('./project-hub').then(m=>({default:m.ProjectFileTree})));
export const MemberTaskCenter=panel('任务中心','project-hub.tsx','MemberTaskCenter',()=>import('./project-hub').then(m=>({default:m.MemberTaskCenter})));
export const ReviewCenter=panel('项目记录','project-hub.tsx','ReviewCenter',()=>import('./project-hub').then(m=>({default:m.ReviewCenter})));
export const EmbeddedSettings=panel('设置','team-settings.tsx','EmbeddedSettings',()=>import('./team-settings').then(m=>({default:m.EmbeddedSettings})));
export const TeamSettingsContent=panel('设置','team-settings.tsx','TeamSettingsContent',()=>import('./team-settings').then(m=>({default:m.TeamSettingsContent})));
export const ChatAdmin=panel('聊天模型','chat-admin.tsx','ChatAdmin',()=>import('./chat-admin').then(m=>({default:m.ChatAdmin})));
export const MemberModelPolicy=panel('生成模型范围','member-model-policy.tsx','MemberModelPolicy',()=>import('./member-model-policy').then(m=>({default:m.MemberModelPolicy})));
export const BillingAdmin=panel('计费核对','billing-admin.tsx','BillingAdmin',()=>import('./billing-admin').then(m=>({default:m.BillingAdmin})));
export const OperationsAdmin=panel('运行与审计','operations-admin.tsx','OperationsAdmin',()=>import('./operations-admin').then(m=>({default:m.OperationsAdmin})));
