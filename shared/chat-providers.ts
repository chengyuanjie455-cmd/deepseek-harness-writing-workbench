// Public connection presets only. Credentials and billing stay on the host.
export const CHAT_PROVIDERS = [
  {id:'ruiyun',name:'瑞云 API 中转站',baseURL:'https://154.64.253.71/ruiyun/v1',models:['gpt-6-luna','gpt-5.4-mini','deepseek-v4.1-flash'],efforts:['off','low','high','max'],help:'使用工作台专用瑞云 Key；模型目录按该 Key 实际授权同步。',docs:'https://154.64.253.71/ruiyun/ruiyun-guide.html'},
  {id:'deepseek-official',name:'DeepSeek 官方',baseURL:'https://api.deepseek.com',models:['deepseek-flash'],efforts:['off','low','high','max'],help:'使用 DeepSeek 开放平台 API Key。',docs:'https://api-docs.deepseek.com/'},
  {id:'opencode-zen',name:'OpenCode Zen',baseURL:'https://opencode.ai/zen/v1',models:['glm-5.3-flash','glm-5.3'],efforts:['low','high','max'],help:'使用 OpenCode Zen API Key；可同步完整聊天模型目录，包括 GPT、Claude、Gemini、GLM 等。',docs:'https://opencode.ai/docs/zen/'},
  {id:'zhipu-coding',name:'ZCode / 智谱 GLM Coding Plan',baseURL:'https://open.bigmodel.cn/api/coding/paas/v4',models:['glm-5.3-flash','glm-5.3'],efforts:['low','high','max'],help:'使用 Coding Plan 专用 Key；所有成员可选择已启用模型。套餐适用范围与额度以供应商为准，不自动切换到按量付费接口。',docs:'https://docs.bigmodel.cn/cn/coding-plan/tool/opencode'},
] as const;
export type ChatProvider = typeof CHAT_PROVIDERS[number]['id'];
export const chatProvider = (id:string) => CHAT_PROVIDERS.find(p=>p.id===id);
