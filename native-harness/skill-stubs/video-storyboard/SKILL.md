---
name: video-storyboard
description: 在项目聊天中调用主机的视频分镜技能，处理 Wan3.0、Seedance 的剧本片段、补抽和修正。此入口只提供调用方式，不包含主机内部技能正文。
metadata:
  execution: host-only
---
# 调用主机分镜技能

继续使用当前原生聊天与已有上下文。核对实时型号、剧本片段、补抽意见和本轮参考图 ID，保留成员指定的型号与规格。

工具目录有 `team_skill_execute` 时，可用 `skill_id=video-storyboard` 调用主机，传 `script`、`notes`、`model_id`、`params`、`reference_media_ids`。必要的既有剧情和连续性结论放在 `context`；已核实的资产名称对应放在 `asset_bindings`。

仅讨论或整理时，读取返回的分镜和具体缺项即可。成员已要求生成时，使用返回节点的提示词、参数、参考图顺序调用已有 `team_video_generate`，同时传 `skill_run_id` 与 `skill_node`。也可直接调用生成工具，由主机自动应用技能；无需新建流程、表单或审批。

如果返回 `needsInput=true`，说明具体缺项，不声称已经提交生成。成员补齐后在同一聊天继续。已经存在的生成和未知回执沿用主机原任务，不重复创建。

此入口不提供技能原文或主机文件路径。普通原生技能与插件仍照常使用。
