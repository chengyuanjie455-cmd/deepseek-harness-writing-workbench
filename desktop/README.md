v0.1 提交次数更新（2026-09-24）：同项目同镜默认5次，超出由管理员审批追加；[现行规则](../docs/video-quota.md)。旧单次验收限制仅作历史。

主机超管记住登录（2026-09-24）：[使用与安全边界](../docs/admin-remember-login.md)。这是对下方历史“HTTP退出后需重新输入密码”的当前主机专属更新；成员网页不变。

# 当前：仅主机管理桌面端

成员统一使用浏览器；主机控制台显示一个系统局域网名称供 Wi-Fi／有线共同访问，备用 IP 只用于排查。当前部署与开发入口见 [主机桌面管理／成员网页访问](../docs/host-desktop-member-web.md)。`npm start` 和 `npm run host` 均启动主机控制台，打包只用 `node package.cjs host darwin arm64`。成员桌面构建已暂停。

以下为历史实现记录，不作为现行成员安装／打包指引。

---

B0.7.2 换网补充（2026-09-24）：独立验收主机支持 `live.automatic=true`，本机入口固定为 `127.0.0.1`，自动更新物理局域网接口；成员端可在已保存地址不可达时查找同一主机的新地址，再重新登录。使用方法和边界见 [公司与家庭网络切换](../docs/lan-roaming.md)。网页使用控制台显示的当前 IP；公司和家里不会因此互联。

B0.7.2 Mac 接通补充（2026-09-24）：验收主机支持 `mode=pickup-live`，只启动 `scripts/live-single-shot.ts`，保留现有一次创建门禁。静态 profile 的 `live` 包含 `bind`、`port`、`extraBinds` 和服务端 `textConfig` 绝对目录，自动模式见上文；端口不得使用 4317/4324。运行身份从独立验收根目录 `runtime.json` 核验 entry、PID、serverId、serverInstance 和 URL，任何不符均不能接管或停止。主机包只引用本机模型配置路径，不包含密钥；真实验收也必须使用 acceptance 应用身份。换用该主机前须备份原数据和指定目录，保留原 serverId，不重置创建门禁。

B0.7.2：登录自动进入本人固定项目聊天；超级管理员可在同一后台配置主机项目目录。成员只访问发布的项目资料和授权原片，继续自动接收视频。

B0.7.1 增加本人原片自动接收：登录后保存至系统下载目录 DeepSeek Team，逐文件核验 SHA-256。Mac 实包与模拟服务验收通过；Windows 真机仍待验收。后台 API 由超管配置，不由成员设置密钥。

# B0.7 桌面补抽接入

新增受限视频流、原片下载、确认卡、模型目录和超管视频配置。认证与任务仍使用同一后台协议。实际 Mac arm64 包完成登录、播放与保存地址重连验证；Windows x64 已打包，真机待验收。

打包验收版本可设置 TEAM_PACKAGE_ACCEPTANCE=1，使用独立名称、bundle ID 与本机配置目录，不覆盖原客户端连接配置。TEAM_PACKAGE_HOST_PROFILE 可在打包时指定经核对的 profile；mode=pickup-uat 仅允许验收身份，启动固定 scripts/uat-pickups.ts、独立 data/ 和非 4317 端口。正式主机模式仍使用 server/main.ts。

网页构建后从项目根执行 `rsync -a --delete dist/ desktop/ui/`；再按下文打包。不要使用下面旧版的错误相对 outDir 示例。

---

# DeepSeek Team 桌面接入 B0.6

成员端在本地显示随包交付的原有聊天页面，通过固定 IPC 接口访问服务器。不会从 HTTP 服务器下载执行网页代码，也不会将模型密钥或主机项目复制到成员端。

开发入口：

1. 后台在项目根目录执行 npm ci、npm run check 和 npm test。
2. desktop 内执行 npm ci，再执行 node node_modules/electron/install.js 获取与 lockfile 对应的官方运行时。
3. 项目根目录执行 node node_modules/vite/bin/vite.js build --outDir desktop/ui。
4. desktop 内执行 npm start；本机控制台使用 npm run host，需存在本机 host-profile.json。

host-profile.json 为当前机器的本地配置，字段 root、data、node 均为经过核对的绝对路径，autoStart 表示打开主机控制台时启动后台。renderer 不能提供这些路径或任意命令。开发 QA 可用 TEAM_DESKTOP_HOST_PROFILE 指向独立合成环境；打包版忽略此环境变量。

成员输入主机具体局域网 IPv4 地址，例如 http://192.168.1.10:4317。首次需要选定主机并登录，之后自动探测保存地址；HTTP 登录会话只存内存，退出应用后重新登录。IP 变化可查找局域网主机并重新确认，不自动向发现的新地址发送凭据。现阶段不支持 .local 名称输入、公网地址或自签名证书绕过校验。

常规主机只有明确设置 PLATFORM_DISCOVERY=1 且已经绑定局域网接口，才发布 DNS-SD 服务；独立 pickup-live 的 PLATFORM_AUTO_LAN=1 会随当前物理接口发布发现服务。loopback 不广播。未启用的部署保持原运行设置。发现只帮助找地址，不提供加密或身份认证。

关闭主机窗口不会结束后台。停止后台需要本机控制台的独立按钮和原生确认，服务停止后所有成员暂时断开。登录电脑时启动是安装版控制台的可选设置，不等于无人登录时开机运行，也不等于后台崩溃自动恢复。

原请求结果不明时，“核对提交”只查询原 requestId，不重发模型请求。仅持久保存服务器/用户分区下的请求编号和会话 ID，不保存聊天草稿、密码或 token。

如果始终未受理，可选择“结束未受理提交”：服务器先查原任务，已受理则返回原任务；未受理则永久封存编号，阻止迟到请求。该操作不重发模型任务，断线后可以继续核对原编号。

打包：node package.cjs member darwin arm64；node package.cjs member win32 x64；当前 Mac 主机可执行 node package.cjs host darwin arm64。输出在 desktop/out；阶段输出目录存在时脚本停止，避免无提示覆盖。主机包绑定当前平台目录并内置当前 Node 运行时，不是可以任意迁移到另一台机器的完整服务器安装器。

分发前必须检查具体 OS/架构、开发者签名/公证与真实设备。生成 .app/.exe 不等于已经通过这些验收。维护者不得关闭 Gatekeeper、证书验证或 Electron webSecurity 来消除安装/连接问题。8 台设备、签名分发、跨主机恢复和可信无感登录仍须单独验收。

## v0.1 内部测试安装版（2026-09-24）

当前桌面发布版本 `0.1.0 / v0.1 测试版`，产品名“DeepSeek 主机管理”。该发布编号与历史后台 B0.7 技术迭代编号独立，不降级数据库。Mac 包沿用 `local.teamharness.host` 和原用户配置目录以保留登录记录。

通过现有 `TEAM_PACKAGE_ACCEPTANCE=1`、`TEAM_PACKAGE_HOST_PROFILE` 指向已核验本机 profile 打包，输出包含自有图标和 Node 运行时。打包后执行本地 ad hoc 签名及资源完整性验证；这不是 Apple 开发者签名或公证。图标由既有 `web/deepseek.svg` 渲染，沿用原仓库许可与归属说明。

本机安装路径 `/Applications/DeepSeek 主机管理 v0.1 测试版.app`。后台源码、数据、模型配置依然使用 profile 指定的本地目录；此包不能脱离既有目录直接作为异机服务器安装器。密钥、账号密码和记住登录记录不得放入包中。成员继续使用浏览器。
