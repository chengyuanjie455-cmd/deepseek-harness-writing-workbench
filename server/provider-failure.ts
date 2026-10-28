import type {Doc} from './store.ts';
/** Provider diagnostics are data. Never expose signed URLs, credentials or full prompts. */
export function providerFailure(receipt:Doc){
 const error=receipt?.error??receipt?.data?.error;
 const raw=typeof error==='object'?error?.code??error?.type:receipt?.code;
 const code=typeof raw==='string'&&/^[a-zA-Z0-9_.-]{1,80}$/.test(raw)?raw:undefined;
 const reasons:Record<string,string>={media_fetch_timeout:'供应商读取参考图片连接超时',invalid_media:'供应商无法读取参考素材',content_review:'供应商内容审核未通过',content_policy_violation:'供应商内容审核未通过',insufficient_quota:'供应商额度不足',rate_limit_exceeded:'供应商限流',invalid_api_key:'供应商认证失败',model_not_found:'供应商模型不可用',model_not_available:'供应商模型暂不可用',invalid_parameter:'供应商拒绝了此型号的参数',invalid_reference:'供应商拒绝了参考素材',upstream_task_failed:'供应商生成任务失败',upstream_timeout:'供应商执行超时'};
 return {providerErrorCode:code,error:code&&reasons[code]?reasons[code]:code?'供应商返回失败（'+code+'）':'供应商返回任务失败，未提供可公开的错误代码'};
}
