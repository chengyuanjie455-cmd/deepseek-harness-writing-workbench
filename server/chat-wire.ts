import type {ModelConnection} from './model.ts';

/** Adapt the body without changing conversation messages, tools or the selected route. */
export function adaptChatRequest(c:ModelConnection,b:Record<string,any>){
  if(c.provider==='deepseek-official'){
    // Harness UI calls the disabled setting "off"; it is not a wire effort.
    if(b.reasoning_effort==='off'){delete b.reasoning_effort;b.thinking={type:'disabled'};}
    return;
  }
  delete b.dsh_plugin_packages;delete b.dsh_session_log;
  if(c.provider==='ruiyun'){
    delete b.thinking;delete b.tool_stream;
    // Ruiyun's compatibility layer owns model-specific thinking parameters.
    // Preserve every message/tool and avoid leaking a DeepSeek-only effort.
    delete b.reasoning_effort;return;
  }
  if(!['low','high','max'].includes(b.reasoning_effort))b.reasoning_effort=c.reasoningEffort==='off'?'high':c.reasoningEffort;
  if(c.provider==='opencode-zen'){delete b.thinking;if(!/^(glm-5\.3|deepseek-)/.test(c.model))delete b.reasoning_effort;}

  else {
    // Harness does not promise a byte-exact preserved-thinking transcript across
    // model switches. Clear hidden thinking at new turns; keep chat/tool history.
    if(!c.model.startsWith('glm-5.3'))delete b.reasoning_effort;
    b.thinking={type:'enabled',clear_thinking:true};
    if(b.stream)b.tool_stream=true;
  }
}

/** Missing/subscription prices are unknown amounts, never zero-dollar estimates. */
export function estimateUsd(pricing:Record<string,any>,input:number,cache:number,output:number):number|undefined{
  if(pricing.billingMode==='subscription'||pricing.currency!=='USD'||![pricing.inputPerMillion,pricing.cacheReadPerMillion,pricing.outputPerMillion].every(n=>typeof n==='number'&&Number.isFinite(n)&&n>=0))return;
  return (input*pricing.inputPerMillion+cache*pricing.cacheReadPerMillion+output*pricing.outputPerMillion)/1e6;
}
