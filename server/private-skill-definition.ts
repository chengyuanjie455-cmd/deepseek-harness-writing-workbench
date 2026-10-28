import {openSync,closeSync,fstatSync,readFileSync,constants} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {hash,requireThat,type Doc} from './store.ts';
import {STORYBOARD_SKILL,STORYBOARD_VERSION} from './video-storyboard.ts';
const hostRoot=fileURLToPath(new URL('..',import.meta.url));
/** Read the same host-owned definition for execution and read-only version
 * checks. A status check never creates a private Skill snapshot. */
export function readPrivateSkillDefinition(codeRoot=hostRoot){
 const fd=openSync(join(codeRoot,'video-skills/video-storyboard/SKILL.md'),constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const before=fstatSync(fd);requireThat(before.isFile(),'主机技能源文件身份改变',409);const body=readFileSync(fd,'utf8'),after=fstatSync(fd);requireThat(before.size===after.size&&before.mtimeMs===after.mtimeMs&&before.ctimeMs===after.ctimeMs,'主机技能定义正在更新，请稍后核对',409);return {body,metadata:{id:STORYBOARD_SKILL,version:STORYBOARD_VERSION,sha256:hash(body)}};}finally{closeSync(fd);}
}
export function privateSkillDefinitionStatus(codeRoot=hostRoot):Doc {
 try{return {state:'ready',metadata:readPrivateSkillDefinition(codeRoot).metadata};}
 catch{return {state:'unknown',note:'主机当前技能定义暂未核实，原任务输入和原件保留。'};}
}
