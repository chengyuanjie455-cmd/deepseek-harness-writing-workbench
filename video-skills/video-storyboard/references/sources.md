# 来源与适配

整理日期：2026-09-27。以下为官方来源，模板示例为本项目原创，未复制官方完整样例。

- [BytePlus Seedance 1.0 Pro / Pro Fast 提示词指南](https://docs.byteplus.com/en/docs/ModelArk/1631633)：覆盖文生、图生视频，说明多镜叙事能力。只作为旧系列结构参考。
- [火山方舟 Seedance 2.0 提示词指南](https://docs.volcengine.com/docs/ark/seedance-2-0-prompt-guide?lang=zh)：官方指南入口；本次抓取仅获取动态页面壳，不声称已读该页面全文。
- [火山方舟 Seedance 2.5 提示词指南](https://docs.volcengine.com/docs/ark/seedance-2-5-prompt-guide?lang=zh)：按素材上传顺序明确映射，分镜可用镜头序号；参考素材足够明确时减少外观复述。其版本差异说明指出 2.0 使用镜头序号，2.5 支持整数秒时间戳。因此平台采用两者均适用的镜头序号格式，不把 2.5 专属时间戳能力套用给 2.0。
- [字节 Seedance 2.0 模型介绍](https://seed.bytedance.com/en/seedance2_0)：多模态参考及音视频联合生成能力。
- [火山方舟创建视频任务 API](https://docs.volcengine.com/docs/ark/create-video-generation-task-api?lang=zh&redirect=1)：文本、图片角色、参考模式与数量等是接口字段，不应写成虚构的提示词语法。官方方舟参数不能直接当作小裴代理参数，执行仍走平台已有适配器。

本项目要求：只画内描述、名字定义、可单列简短风格、台词与反应近景、同期声；最长15秒及以内型号超过八秒台词独立节点（Wan3.0与Seedance2.5例外）。这些是用户的制作要求，不宣称为 Seedance 官方限制。时长估算用于预检，不是语音合成的实测时长；资产视觉核对是模型辅助审查，不承诺生成结果绝对一致。
