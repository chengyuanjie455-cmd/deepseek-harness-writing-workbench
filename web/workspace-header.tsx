import React, { useEffect, useRef, useState } from 'react';
import deepseekMark from './deepseek.svg';
import { Icon } from './chat-ui';
import './workspace-header.css';

type Props = {
  placement?: 'top' | 'sidebar';
  page: string;
  onPage: (page: string) => void;
  admin: boolean;
  name: string;
  projectId: string;
  projects: { id: string; name: string }[];
  projectName?: string;
  onProject: (id: string) => void;
  reviews: number;
  onLogout: () => void;
};

const projectTools = [
  { id: 'files', name: '项目文件', icon: 'folder' },
  { id: 'tasks', name: '任务中心', icon: 'settings' },
];

export function WorkspaceHeader(props: Props) {
  const [menu, setMenu] = useState<'tools' | 'account'>();
  const toolsButton = useRef<HTMLButtonElement>(null);
  const accountButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!menu) return;
    const dismiss = (event: PointerEvent | FocusEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest(`[data-header-menu="${menu}"]`)) setMenu(undefined);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      (menu === 'tools' ? toolsButton : accountButton).current?.focus();
      setMenu(undefined);
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('focusin', dismiss);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('focusin', dismiss);
      document.removeEventListener('keydown', escape);
    };
  }, [menu]);
  useEffect(() => { setMenu(undefined); }, [props.page, props.projectId]);
  const selectedTool = projectTools.find(tool => tool.id === props.page);
  const navigate = (page: string) => { setMenu(undefined); props.onPage(page); };
  const projects = props.projects.length ? props.projects : [{ id: props.projectId, name: props.projectName || '正在加载项目…' }];

  return <header className="team-workspace-header" data-layout={props.placement??'top'}>
    {props.page!=='projects'&&<button className="team-top-tab" onClick={()=>navigate('projects')}>← 项目空间</button>}{props.placement!=='sidebar'&&<span className="team-environment-label">{props.page==='projects'?'项目空间':props.projectName??'项目工作台'}</span>}
    {props.page!=='native'&&props.page!=='projects'&&<button className="team-top-tab" onClick={()=>navigate('native')}>返回项目聊天</button>}
    <div className="team-header-account-area">
      {(props.placement==='sidebar'||props.page!=='native'&&props.page!=='projects')&&<label className="team-project-select" title={projects.find(project => project.id === props.projectId)?.name}>
        <Icon name="folder"/><span className="sr-only">切换团队项目</span>
        <select aria-label="切换团队项目" value={props.projectId} onChange={event => props.onProject(event.target.value)}>{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select><Icon name="chevron"/>
      </label>}
      <div className="team-header-dropdown" data-header-menu="account">
        <button ref={accountButton} className="team-account-trigger" aria-label={`账号菜单：${props.name}`} title={props.name} aria-expanded={menu === 'account'} aria-controls="team-account-menu" onClick={() => setMenu(menu === 'account' ? undefined : 'account')}><span className="team-account-avatar">{Array.from(props.name)[0] || '团'}</span><Icon name="chevron"/></button>
        {menu === 'account' && <div id="team-account-menu" className="team-header-popover team-account-popover"><div className="team-account-info"><strong>{props.name}</strong><span>{props.admin ? '超级管理员' : '团队成员'}</span></div><button onClick={() => {setMenu(undefined);if(window.teamDesktop)window.dispatchEvent(new Event("wawu-account-entry"));else location.assign("https://work.cyj123.top/account-api/portal#hosts");}}>可访问的主机</button><button onClick={() => { setMenu(undefined); props.onLogout(); }}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 4H4v16h6M9 12h12m-4-4 4 4-4 4"/></svg>退出登录</button></div>}
      </div>
    </div>
  </header>;
}
