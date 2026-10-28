import {useEffect,useRef} from 'react';
import {ProjectRead} from './project-read';
type Options<T>={scope?:string;refresh:string;identity:unknown;read:()=>Promise<T>;commit:(value:T)=>void;fail:(error:any)=>void;busy?:(value:boolean)=>void;delayMs?:number;intervalMs?:number};
/** Query changes replace the reader; refresh events only mark it dirty.
 * No editor, conversation or generation state is owned by this read hook. */
export function useProjectRead<T>(options:Options<T>){
 const latest=useRef(options),reader=useRef<ProjectRead<T>|undefined>(undefined);latest.current=options;
 useEffect(()=>{
  const value=latest.current;if(!value.scope){value.busy?.(false);return;}
  const current=new ProjectRead(value);reader.current=current;
  const timer=value.intervalMs?setInterval(()=>void current.refresh(),value.intervalMs):undefined;
  return()=>{current.close();clearInterval(timer);if(reader.current===current)reader.current=undefined;};
 },[options.scope,options.identity]);
 useEffect(()=>{
  const current=reader.current;if(!options.scope||!current)return;
  const timer=setTimeout(()=>void current.refresh(),options.delayMs??0);
  return()=>clearTimeout(timer);
 },[options.scope,options.identity,options.refresh]);
}
