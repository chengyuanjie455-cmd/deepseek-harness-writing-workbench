import React from 'react';

/** Presentation layers only. The original chat stays mounted while a native
 * plugin, automation or file/terminal view is used in the same sidebar. */
export function NativeSidebarLayers({chat,panel,title,onBack,toolbar,chatContext}:{chat:React.ReactNode;panel?:React.ReactNode;title?:string;onBack:()=>void;toolbar?:React.ReactNode;chatContext?:React.ReactNode}){
 const open=panel!=null;
 return <div className="native-sidebar-layers" data-native-sidebar="docked-complete" aria-label="原生工作台侧栏">
  {toolbar&&<div className="native-sidebar-toolbar" data-native-sidebar-toolbar="true">{toolbar}</div>}
  <div className="native-sidebar-chat" hidden={open}>{chatContext}{chat}</div>
  {open&&<section className="native-sidebar-feature" aria-label={title??'工作台功能'}><header><button type="button" onClick={onBack}>← 返回聊天</button><strong>{title??'工作台功能'}</strong></header><div className="native-sidebar-feature-content">{panel}</div></section>}
  <div className="native-sidebar-settings-host" data-studio-settings-host="true"/>
 </div>;
}

export function sidebarWidthBounds(containerWidth:number){
 const width=Number.isFinite(containerWidth)?Math.max(0,containerWidth):1000;
 return {min:320,max:Math.max(320,Math.min(760,Math.round(width-440)))};
}
export function clampSidebarWidth(value:number,containerWidth:number){
 const {min,max}=sidebarWidthBounds(containerWidth);
 return Math.min(max,Math.max(min,Number.isFinite(value)?Math.round(value):420));
}
