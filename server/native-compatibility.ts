import {Script} from 'node:vm';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {hash,requireThat} from './store.ts';
import {NATIVE_VERSION,NATIVE_IMAGE} from './native-version.ts';
import {adaptNativeClient} from './native-page.ts';
// Explicit contracts for the remaining upstream gaps. No silent best-effort
// replacement: release verification checks installed artifacts before rollout.
const contracts=[
 {package:'dsh-api-session-controller',before:['var SessionEventStream = class extends','constructor(remote, address, options) {'],after:['const teamSyncToken =','sync?.update(teamSyncToken,\'reconnecting\')','const nativeOpen=this.open.bind(this)']},
 {package:'dsh-client-ui-conversation',before:['async sendSession(session, text, attachmentIds, mode, signal) {','conversation.input.dock'],after:['text = window.__TEAM_GENERATION_PROMPT__?.(session.sessionId, text) ?? text;']},
 {package:'dsh-client-ui-workspace',before:['function WorkspaceBrowser({ wide,','}, WorkspaceBrowser));'],after:['renderMemberGroups','window.__TEAM_WORKSPACE_BROWSER__']},
 {package:'dsh-client-ui-tool',before:['function ToolCallTree('],after:['teamGalleryTurn:node.location','teamGalleryOrder:node.anchorSeq']},
 {package:'dsh-client-ui-chat',before:['function UserStyleBubble({','const compactImages = attachments.length > 1;'],after:['const isGalleryMedia =','attachments.filter(isGalleryMedia)']},
 {package:'dsh-client-ui-deliverables',before:['function PresentedFileCard('],after:['window.__TEAM_WORKSPACE_DOWNLOAD_URL__']},
 {package:'dsh-client-ui-layout',before:['const productTitle = "DeepSeek Harness"'],after:['const productTitle = "team-harness-platform"']},
 {package:'dsh-client-ui-settings-general',before:['function SettingsRoot(props)','const { close, openSection } = actions;'],after:["team-open-settings","team-close-settings"]}
];
export function verifyNativeCompatibility(sourceRoot:string){
 const rows=contracts.map(c=>{const folder=join(sourceRoot,'native-harness/node_modules/@deepseek-ai',c.package),pkg=JSON.parse(readFileSync(join(folder,'package.json'),'utf8')),source=readFileSync(join(folder,'lib/client.js'),'utf8');
  requireThat(pkg.version===NATIVE_VERSION,`${c.package} 与已锁定版本不一致`,409);
  for(const marker of c.before)requireThat(source.includes(marker),`${c.package} 原生适配契约变化`,409);
  const transformed=adaptNativeClient(source);new Script(transformed,{filename:c.package+'.js'});for(const marker of c.after)requireThat(transformed.includes(marker),`${c.package} 原生功能适配缺失`,409);
  return {package:c.package,version:pkg.version,sourceSHA256:hash(source),adaptedSHA256:hash(transformed),passed:true};
 });return {version:NATIVE_VERSION,image:NATIVE_IMAGE,contracts:rows,passed:true,scope:'installed_artifacts_not_browser_visual'};
}
