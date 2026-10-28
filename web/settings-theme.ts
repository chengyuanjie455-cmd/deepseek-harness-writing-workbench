import {useLayoutEffect} from 'react';

// Both documents are served under the same authenticated project origin. Read
// the native theme rather than guessing from the OS when the user chose a theme.
export function useNativeSettingsTheme(enabled=true) {
 useLayoutEffect(()=>{
  if(!enabled)return;
  const root=document.documentElement;root.dataset.teamSettingsUi='true';
  let parent:Document;
  try {parent=window.parent.document;if(parent===document)return;}catch{return;}
  const sync=()=>{
   const win=parent.defaultView;if(!win||!parent.body)return;
   const style=win.getComputedStyle(parent.body);
   for(const key of style)if(key.startsWith('--dsw-'))root.style.setProperty(key,style.getPropertyValue(key));
   const dark=parent.body.hasAttribute('data-ds-dark-theme');root.dataset.settingsTheme=dark?'dark':'light';root.style.colorScheme=dark?'dark':'light';
  };
  sync();
  const observer=new MutationObserver(sync);
  for(const target of [parent.documentElement,parent.body])observer.observe(target,{attributes:true,attributeFilter:['class','style','data-ds-dark-theme']});
  const media=parent.defaultView?.matchMedia('(prefers-color-scheme: dark)');media?.addEventListener('change',sync);
  return()=>{observer.disconnect();media?.removeEventListener('change',sync);};
 },[enabled]);
}
