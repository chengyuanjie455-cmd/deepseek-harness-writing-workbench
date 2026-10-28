import {readFileSync} from 'node:fs';
import {installPromptAdmissionGuard} from './prompt-admission.mjs';
export const name='team-native-policy';
export const inject=['tools','sessionController'];
export function apply(ctx,config){
 ctx.effect(()=>installPromptAdmissionGuard(ctx));
 const groups={shell:/bash|pwsh|shell|terminal|job/,files:/^(read|write|edit|glob|grep|read_image|present)$/,web:/web|fetch|browser/,skills:/skill/,subagents:/subagent|send_message|interrupt_agent|list_agents|wait_agent/,workflows:/workflow|ralph/,goals:/goal/,plugins:/cordis|code_exec|run_code/,questions:/ask_user/,plan:/todo|plan/,compact:/compact/,schedule:/schedule/};
 ctx.tools.guard(exec=>{let p;try{p=JSON.parse(readFileSync(config.policy,'utf8'));}catch{return '团队能力设置不可用';}if(!p.enabled)return '超级管理员已关闭 Harness';for(const [key,pattern]of Object.entries(groups))if(pattern.test(exec.name)&&p.features[key]===false)return '超级管理员已关闭此功能：'+key;});
}
