import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const source = new URL('../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, source), 'utf8');

test('原生工作台不再用五秒无条件整页刷新', () => {
  const studio = read('web/native-studio.tsx');
  assert.doesNotMatch(studio, /setInterval\(read,5000\)/);
  assert.match(studio, /lastSignature/);
  assert.match(studio, /team-native-refresh/);
  assert.match(studio, /visibilitychange/);
});

test('智能体上下文没有模型和技能默认回退', () => {
  const studio = read('web/project-studio.tsx');
  const native = read('web/native-studio.tsx');
  assert.doesNotMatch(studio, /project\?\.chat\?\.defaultSkillId\?\?'screenwriter'/);
  assert.doesNotMatch(studio, /project\?\.model\?\.name\?\?project\?\.chat\?\.models/);
  assert.match(studio, /未确认/);
  // Native session headers are read first, then projected into the truthful
  // model value; keep this assertion tolerant of the local variable split.
  assert.match(native, /requestHeader\?\.\(\)/);
  assert.match(native, /__TEAM_GENERATION_SELECTION__/);
});

test('移动端原生工具菜单使用 body portal 和 fixed 定位', () => {
  const native = read('web/native-studio.tsx');
  const css = read('web/native-studio.css');
  assert.match(native, /createPortal/);
  assert.match(native, /data-floating-native-menu/);
  assert.match(css, /\.studio-native-tools-menu\[data-floating="true"\]\{position:fixed/);
});

test('聊天栏直接显示真实技能和模型状态', () => {
  const native = read('web/native-studio.tsx');
  const sidebar = read('web/native-sidebar.tsx');
  const css = read('web/native-studio.css');
  assert.match(native, /data-chat-context/);
  assert.match(native, /nativeSkill\?\?'未确认'/);
  assert.match(native, /nativeModel\?\?'未确认'/);
  assert.match(sidebar, /chatContext\?/);
  assert.match(css, /\.studio-chat-context\{/);
});

test('成员技能选择只读取已发布目录并通过选择桥传递 ID', () => {
  const native = read('web/native-studio.tsx');
  const client = read('native-harness/team-project/client.js');
  assert.match(native, /data-skill-host-only/);
  assert.match(native, /status==='published'&&skill\.memberAccess/);
  assert.match(native, /aria-label="选择技能"/);
  assert.match(native, /id:'team-native-skill-picker'/);
  assert.match(native, /ensureNativeSelectionBridge/);
  assert.doesNotMatch(native, /skill\.(prompt|content|body|path)/);
 assert.match(client, /generationChoices\.set\(id,kind,value\)/);
 assert.match(client, /team-settings\/api\/sessions\/'\+encodeURIComponent\(sessionId\)/);
});
