# OpenCode Zen GLM 5.3 Flash 接入（候选环境）

本版在原 DeepSeek 路由之外增加 `opencode-zen / glm-5.3-flash`，沿用 Harness 的兼容 Chat Completions 流式传输。仅允许核验过的固定 HTTPS 入口；模型目录中的其他模型并未自动获得接入能力。DeepSeek 页面样式保留，模型标签读取实际任务配置。

服务器专用数据目录内 `model-connection.json`，权限 `0600`：

```json
{
  "provider": "opencode-zen",
  "model": "glm-5.3-flash",
  "reasoningEffort": "max",
  "baseURL": "https://opencode.ai/zen/v1",
  "apiKey": "仅在本机填写现有 OpenCode Zen API key"
}
```

密钥不得提交代码库、写入前端或交付报告。改变配置后在无文字任务执行时由主机重新载入；历史任务和用量保留原配置。正式 `4317` 本轮保持原配置，独立真实验收 `4325` 使用新路由。

`max` 是请求中的 `reasoning_effort`，不是输出长度。GLM 单请求输出上限 32,768 tokens，目录上限为 131,072；补抽解析保持明确选择的 `max`，不套用 DeepSeek 的 `off` 解析策略。任务最多 4 次文字调用；真实单镜验收进一步限为 1 次且禁用工具。网络失败不自动重发，不自动换渠道或降档。

每次调用保存提供方、模型、配置摘要、请求 SHA-256、实际传输 effort、token 上限、用量和当次费率快照。OpenCode 与 DeepSeek 分别计算；GLM 输入 USD 0.15 / 百万、缓存读取 USD 0.03 / 百万、输出 USD 0.50 / 百万（2026-09-24 核对）。输出用量已包含推理 tokens，不重复收费计算；估算不冒充最终账单。

资料来源：[OpenCode Zen 官方入口与费率](https://opencode.ai/docs/zen/)，本机已刷新模型目录的 `reasoning_options`。本版支持文字输入和当前受控工具协议，未宣称 GLM 全模态上传能力已验收。

自动验证覆盖两路端点/模型/effort、用量计价、密钥不返回前端、管理员流程、受控工具、单次失败不重试及补抽解析。真实验收以独立现场收据为准；模型目录可见不等于每个模型推理通过。
