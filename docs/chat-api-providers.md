# 聊天 API 全部模型目录（2026-09-25）

后台管理 → 成员模型 → 选择渠道 → 复用已保存密钥或填写新密钥 → 刷新 API 全部模型 → 搜索并保存模型 → 勾选当前项目开放范围 → 保存项目聊天范围。成员刷新原生工作台后可选择管理员开放的模型。

各渠道以服务器端携带所选密钥请求 `/models`，不再以代码中的几个预设限制管理员的选择。目录按供应商和密钥隔离并持久缓存，刷新失败明确显示旧目录及时间；切换密钥不会套用另一个账户的目录。后台仅返回模型元数据，不返回密钥。预设仅供首次配置和兼容旧配置。

本次现有密钥返回：DeepSeek 2 个、智谱 Coding Plan 11 个、OpenCode Zen 80 个。Zen 中 2 个 Jev 是结构化判断模型，完整展示但不能作为聊天模型，其余 78 个可以配置。目录中列出不代表已逐一执行或有足够余额，实际调用仍受供应商模型权限和套餐限制。

| 渠道 | 固定 Base URL | 调用适配 |
| --- | --- | --- |
| DeepSeek 官方 | https://api.deepseek.com | Chat Completions |
| OpenCode Zen | https://opencode.ai/zen/v1 | Chat Completions、Responses、Messages、Gemini |
| 智谱 GLM Coding Plan | https://open.bigmodel.cn/api/coding/paas/v4 | Chat Completions |

Zen 协议按官方模型家族映射，标准协议转换使用固定版本 AI SDK Provider（OpenAI 4.0.75、Anthropic 4.0.63、Google 4.0.80）。原生工作台和旧任务入口共用转换层，保留聊天文本、工具定义、调用 ID 和工具结果；Gemini 工具签名在主机按模型凭据和成员工作区保存。跨模型切换不保证供应商隐藏推理缓存复用；持久聊天和工具上下文保留。非聊天协议采用供应商默认推理设置，后台不提供无效档位切换。

密钥保存在主机 0600 文件。增加同渠道模型可直接复用已有密钥，切换渠道不能误用旧渠道密钥。Coding Plan 复用连接保留原席位归属；本机当前个人套餐绑定管理员。成员看不到、不能调用他人的套餐连接。成员也无法访问管理员模型目录接口。

未知模型价格保持“待核对”，不套用 GLM 或 DeepSeek Flash 的费率，不将未知金额记成 0。调用用量、供应商状态和实际账单核对都留在后台。套餐按用量记录，余额不足、权限拒绝、断流均不自动重发，也不自动换到其他付费渠道。

本次正式主机真实验收：GPT 5 Nano、Claude Haiku 4.5、Gemini 3 Flash，各完成工具调用和带工具结果的续接，共 6 次 HTTP 200，续接均回复 OK。测试只传入合成场景，工具结果由验收脚本模拟，没有读取项目文件或生成视频。新增 3 个验收过的连接只允许管理员，原项目开放范围在验收后恢复，由管理员选择是否开放。未逐个付费验证目录中所有模型。

官方资料：
- [DeepSeek 模型目录](https://api-docs.deepseek.com/api/list-models/)
- [OpenCode Zen 模型目录、协议与价格](https://opencode.ai/docs/zen/)
- [Coding Plan 专用端点](https://docs.bigmodel.cn/cn/coding-plan/tool/opencode)
- [Coding Plan 团队席位](https://docs.bigmodel.cn/cn/coding-plan/team)
