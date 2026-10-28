import type {TokenUsage} from '@deepseek-ai/dsh-llm';
const counter=(n:unknown):n is number=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0;

/** A completed reply does not prove its token usage. Some gateways/adapters
 * fill missing counters with zeros. Keep these calls pending reconciliation;
 * never treat a placeholder as a free response or alter/retry the response. */
export function accountingUsage(value:unknown):TokenUsage|undefined{
 if(!value||typeof value!=='object'||Array.isArray(value))return;
 const v=value as Record<string,any>,parts=[v.inputTokens,v.outputTokens,v.cacheReadTokens??0,v.cacheWriteTokens??0];
 if(v.cacheReadTokens===null||v.cacheWriteTokens===null)return;
 if(!parts.every(counter))return;
 const total=parts.reduce((sum,n)=>sum+n,0);if(!counter(total)||total===0)return;
 if(v.totalTokens!==undefined&&(!counter(v.totalTokens)||v.totalTokens!==total))return;
 if(v.reasoningTokens!==undefined&&(!counter(v.reasoningTokens)||v.reasoningTokens>v.outputTokens))return;
 return {inputTokens:v.inputTokens,outputTokens:v.outputTokens,
  ...(v.cacheReadTokens!==undefined?{cacheReadTokens:v.cacheReadTokens}:{}),...(v.cacheWriteTokens!==undefined?{cacheWriteTokens:v.cacheWriteTokens}:{}),
  ...(v.totalTokens!==undefined?{totalTokens:v.totalTokens}:{}),...(v.reasoningTokens!==undefined?{reasoningTokens:v.reasoningTokens}:{})};
}

/** OpenAI Chat prompt counters include cached input; Harness counters are
 * disjoint. Reject contradictory cache aliases rather than silently clamp. */
export function chatAccountingUsage(value:unknown):TokenUsage|undefined{
 if(!value||typeof value!=='object'||Array.isArray(value))return;
 const v=value as Record<string,any>,details=v.prompt_tokens_details?.cached_tokens,legacy=v.prompt_cache_hit_tokens,cache=details??legacy??0;
 if(v.prompt_tokens_details!==undefined&&(!v.prompt_tokens_details||typeof v.prompt_tokens_details!=='object'||Array.isArray(v.prompt_tokens_details)))return;
 if(!counter(v.prompt_tokens)||!counter(v.completion_tokens)||!counter(cache)||cache>v.prompt_tokens)return;
 if(details!==undefined&&legacy!==undefined&&details!==legacy)return;
 if(details===null||legacy===null)return;
 return accountingUsage({inputTokens:v.prompt_tokens-cache,outputTokens:v.completion_tokens,cacheReadTokens:cache,...(v.total_tokens!==undefined?{totalTokens:v.total_tokens}:{})});
}
