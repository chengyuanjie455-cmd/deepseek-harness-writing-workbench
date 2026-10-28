import {test} from 'node:test';
import assert from 'node:assert/strict';
import {accountingUsage,chatAccountingUsage} from '../server/model-usage.ts';

test('usage evidence rejects placeholders and malformed counters while retaining legitimate cached/input/output-only samples',()=>{
 for(const v of [undefined,null,[],{}, {inputTokens:0,outputTokens:0},{inputTokens:0,outputTokens:0,totalTokens:1}])assert.equal(accountingUsage(v),undefined);
 for(const bad of [-1,NaN,Infinity,0.1,'20',null,Number.MAX_SAFE_INTEGER+1])assert.equal(accountingUsage({inputTokens:bad,outputTokens:5}),undefined);
 assert.equal(accountingUsage({inputTokens:20,outputTokens:5,totalTokens:99}),undefined);
 assert.equal(accountingUsage({inputTokens:20,outputTokens:5,cacheReadTokens:null}),undefined);
 assert.equal(accountingUsage({inputTokens:20,outputTokens:5,cacheWriteTokens:null}),undefined);
 assert.equal(accountingUsage({inputTokens:20,outputTokens:5,reasoningTokens:6}),undefined);
 assert.equal(accountingUsage({inputTokens:Number.MAX_SAFE_INTEGER,outputTokens:1}),undefined);
 for(const sample of [{inputTokens:2,outputTokens:0},{inputTokens:0,outputTokens:3},{inputTokens:0,outputTokens:0,cacheReadTokens:8},{inputTokens:0,outputTokens:0,cacheWriteTokens:8},{inputTokens:2,outputTokens:3,cacheReadTokens:4,cacheWriteTokens:5,totalTokens:14,reasoningTokens:2}])assert.deepEqual(accountingUsage(sample),sample);
});
test('wire usage counts cache once and treats inconsistent evidence as unknown without mutating the source',()=>{
 const sample={prompt_tokens:20,completion_tokens:10,total_tokens:30,prompt_tokens_details:{cached_tokens:8},prompt_cache_hit_tokens:8},before=structuredClone(sample);
 assert.deepEqual(chatAccountingUsage(sample),{inputTokens:12,outputTokens:10,cacheReadTokens:8,totalTokens:30});assert.deepEqual(sample,before);
 for(const patch of [{prompt_tokens:0,completion_tokens:0,total_tokens:0,prompt_tokens_details:undefined,prompt_cache_hit_tokens:undefined},{prompt_tokens_details:{cached_tokens:21}},{prompt_tokens_details:{cached_tokens:null}},{prompt_cache_hit_tokens:7},{prompt_tokens:1.5},{completion_tokens:-1},{total_tokens:31}])assert.equal(chatAccountingUsage({...sample,...patch}),undefined);
 assert.deepEqual(chatAccountingUsage({prompt_tokens:20,completion_tokens:0,prompt_tokens_details:{cached_tokens:20}}),{inputTokens:0,outputTokens:0,cacheReadTokens:20});
});
