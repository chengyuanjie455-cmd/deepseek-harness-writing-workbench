# DeepSeek Harness Writing Workbench

这是一个本地优先的多人编剧工作台源码包。它以项目文件夹为边界，提供项目内容检索、剧本／分镜／资产／视频／剪辑的统一展示，以及右侧智能体聊天入口。成员聊天按账号隔离，管理员负责主机目录、模型、技能和 API 配置。

## 运行前提

- Node.js 22.13.x（见 `package.json`）
- Git、Docker、ffmpeg/ffprobe
- 真实 API 密钥只通过本机未跟踪的环境变量或管理员配置注入，绝不写入仓库

## 本地启动

```sh
npm ci --ignore-scripts
cd native-harness && npm ci --ignore-scripts
cd ..
npm run check
npm run build
npm test
npm start
```

原生 DeepSeek Harness 适配位于 `native-harness/`；Magpie 上游源码位于 `vendor/magpie/`。生成的前端、运行时二进制、数据库、媒体、日志和主机凭据不在本源码包内。

## 配置原则

1. 先复制 `.env.example`（如需）为本机配置，并使用权限受限文件。
2. 不要把 API key、Cookie、Bearer token、签名身份、项目业务文件或聊天记录提交到 Git。
3. 生产数据根、外接盘绑定、成员账号和模型渠道由主机管理员在部署环境配置。
4. 修改后先运行类型检查、构建和测试，再进行人工登录、项目展示、三栏工作台和移动端验收。

## 目录速览

- `server/`：HTTP API、项目权限、聊天、任务、媒体和存储逻辑
- `web/`：网页工作台和三栏项目界面
- `desktop/`：主机管理桌面端及连接/打包代码
- `native-harness/`：原生会话和项目工作台桥接
- `shared/`：跨端协议与数据结构
- `vendor/magpie/`：Magpie 上游源码
- `tests/`：单元、协议和合成验收测试
- `docs/`：脱敏后的设计与操作说明

## 交接

请先阅读 `HANDOFF_PUBLIC.md` 和 `SECURITY_REVIEW.md`。它们记录了本包的范围、排除项、验证命令和下一位开发者的接入步骤。
