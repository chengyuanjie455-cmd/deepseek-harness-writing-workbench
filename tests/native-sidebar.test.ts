import {test} from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {NativeSidebarLayers,clampSidebarWidth,sidebarWidthBounds} from '../web/native-sidebar.tsx';

test('docked native tools keep the original chat subtree while presenting one feature region',()=>{
 const chat=React.createElement('div',{'data-original-controller':'same-session'},'original chat and draft');
 const toolbar=React.createElement('nav',{'data-native-toolbar':'controls','aria-label':'原生操作'},'native controls');
 const base={chat,toolbar,onBack:()=>{}};
 const open=renderToStaticMarkup(React.createElement(NativeSidebarLayers,{...base,title:'原生插件',panel:React.createElement('div',{'data-native-tool':'plugins'},'registered plugin view')}));
 assert(open.includes('original chat and draft'));assert(open.includes('registered plugin view'));
 assert.match(open,/class="native-sidebar-chat" hidden=""/);assert(open.includes('aria-label="原生插件"'));assert(open.includes('返回聊天'));assert(open.includes('data-studio-settings-host="true"'));assert(open.includes('data-native-sidebar="docked-complete"'));assert(open.includes('data-native-sidebar-toolbar="true"'));assert(open.includes('native controls'));
 const closed=renderToStaticMarkup(React.createElement(NativeSidebarLayers,base));assert(closed.includes('original chat and draft'));assert(!closed.includes('hidden=""'));assert(!closed.includes('registered plugin view'));assert(!closed.includes('<iframe'));assert(!closed.includes('<dialog'));
 assert(closed.includes('data-native-sidebar-toolbar="true"'));
});

test('sidebar width adapts after a monitor resize and remains keyboard reachable at both bounds',()=>{
 for(const viewport of [0,390,760,1024,1440,1920,3440,NaN]){
  const {min,max}=sidebarWidthBounds(viewport);assert(max>=min);
  for(const size of [-100,0,320,420,900,100000,NaN]){const value=clampSidebarWidth(size,viewport);assert(Number.isFinite(value));assert(value>=min&&value<=max);}
  assert.equal(clampSidebarWidth(-1,viewport),min);assert.equal(clampSidebarWidth(100000,viewport),max);
 }
 assert(clampSidebarWidth(700,1024)<clampSidebarWidth(700,1920));
});
