import React,{Component,Suspense,lazy,useMemo,useState,type ReactNode} from 'react';
import {recoverableModule} from './module-retry';

// Keep the loader outside renders: streaming text must not reset the renderer.
const loadMarkdown=recoverableModule(()=>import('./chat-markdown'),'chat-markdown.tsx');
const InitialMarkdown=lazy(()=>loadMarkdown());
class MarkdownBoundary extends Component<{text:string;retry:()=>void;children:ReactNode},{failed:boolean}>{
  state={failed:false};
  static getDerivedStateFromError(){return {failed:true};}
  render(){return this.state.failed?<div className="chat-markdown"><p role="status">排版组件暂未加载，原文仍可查看和复制。<button type="button" onClick={this.props.retry}>重试排版</button></p><PlainText text={this.props.text}/></div>:this.props.children;}
}
function PlainText({text}:{text:string}){return <div style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{text}</div>;}
export function DeferredMarkdown({text}:{text:string}){
  const [attempt,retry]=useState(0),MarkdownContent=useMemo(()=>attempt?lazy(()=>loadMarkdown(attempt)):InitialMarkdown,[attempt]);
  return <MarkdownBoundary key={attempt} text={text} retry={()=>retry(v=>v+1)}><Suspense fallback={<div className="chat-markdown"><PlainText text={text}/></div>}><MarkdownContent text={text}/></Suspense></MarkdownBoundary>;
}
