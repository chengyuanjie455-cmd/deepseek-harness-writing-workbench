import React,{type ReactNode} from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import {CopyButton} from './chat-primitives';
export default function MarkdownContent({text}:{text:string}){return <div className="chat-markdown"><Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={{
  a:({node,...props})=><a {...props} target="_blank" rel="noopener noreferrer"/>,
  img:({alt})=><span className="muted">{alt?`[图片：${alt}]`:'[图片]'}（原件见附件）</span>,
  pre:({children})=>{const child=React.Children.toArray(children)[0] as React.ReactElement<{children?:ReactNode,className?:string}>;function flatten(v:ReactNode):string{return typeof v==='string'?v:Array.isArray(v)?v.map(flatten).join(''):React.isValidElement<{children?:ReactNode}>(v)?flatten(v.props.children):'';}const code=flatten(child);return <div className="chat-code"><div><span>{child?.props?.className?.match(/language-([^ ]+)/)?.[1]??'代码'}</span><CopyButton text={code} label="复制代码"/></div><pre>{children}</pre></div>;}
}}>{text}</Markdown></div>;}
