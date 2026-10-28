---
name: screenwriter
description: 调用主机的编剧技能，整理当前项目中的剧本、人物、场次、对白与连续性。成员只能调用，技能正文留在主机。
metadata:
  execution: host-only
---

# 调用主机编剧技能

继续使用当前项目聊天和已有上下文。先用 `team_project_files` 检索当前项目资料，再用 `team_skill_execute` 的 `skill_id=screenwriter` 让主机整理本轮剧本任务。传入 `script`、`notes`，必要时传 `context`、`reference_media_ids` 和已经核实的资料引用。

返回的是可审核的候选稿、结构化场次和具体缺项，不会自动改写项目正史。需要继续修改时在同一聊天提出新的意见；不要读取、复制或提供主机技能原文、主机路径或内部提示词。视频生成仍使用 `video-storyboard`，不要把编剧结果当成视频生成节点。
