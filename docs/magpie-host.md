# 主机内置 Magpie

本地候选集成 Magpie 官方源码，固定提交 `ba319a7587923fc7a4ea3859658244d591261a59`。上游来源为 https://github.com/yetone/magpie，完整源码及 MIT 许可在 `vendor/magpie`，原始文件哈希在 `vendor/magpie.UPSTREAM.json`。

## 使用

在工作台「设置 → 模型 → 模型引擎与自动备用」选择「Magpie · 主机内置」并保存。仍在原生聊天模型菜单里选择已有模型或自动模式，不增加独立聊天入口，也不要求打开或安装 Magpie 桌面应用。未选择时保留原生引擎。设置按项目保存。

复用工作台已保存的 API 模型连接。模型目录发现、能力和上下文验证、首个有效输出前的备用切换、尝试次数、真实型号回执仍由工作台管理；Magpie 执行所选线路的真实协议调用与转换。内置入口每次只允许一次上游发送，避免叠加 Magpie 默认重试。出现有效文本、思考或工具输出后不再切换。图片与视频任务继续走原有执行器、轮询、下载与画廊，未切换到另一套媒体队列。

## 源码与生命周期

- `vendor/magpie/cmd/wawu-host`：新增的最小主机入口；调用上游 `gateway`、`provider` 实现，不启动独立 CLI/GUI、插件市场、账号扫描、自动更新或后台配置迁移。
- `vendor/magpie/internal/gateway/wawu_host.go` 及 `gateway.go` 的小范围补丁：单次上游发送、禁止隐式付费 POST 重播、禁止重定向；原版入口默认行为不变。
- `server/magpie-host.ts`：主机拥有的子进程、私有配置管道、随机回环端口、随机鉴权、协议转换与退出清理。
- `server/model-routing.ts`：原有上下文及切换逻辑增加调用引擎选项；没有叠加隐藏备用组。

子进程只监听 `127.0.0.1` 随机端口，所有请求需主机随机密钥，只开放聊天推理路径。内部配置通过继承管道传入，不传入命令行或客户端。临时运行目录为工作台数据目录下的 `magpie-private/run-*`，父目录权限 0700、上游密钥文件 0600；正常关闭后移除本实例的临时目录。主机异常退出时管道关闭，子进程随之停止；异常退出留下的目录须按主机敏感数据管理。已有 Magpie 应用和其他 Agent 的配置保持原样。

## 构建与验证

需要 Go 1.26.8（以固定源码 `go.mod` 为准），执行 `npm run magpie:build`。产物为 `runtime/magpie-host-<平台>-<架构>`，附带 SHA-256 回执与实际链接模块的许可证。允许用本任务专属 `GOPATH`、`GOCACHE`、`GOMODCACHE`，不改 HOME 或已有 Magpie 配置。

工作台测试：`node --import tsx --test tests/magpie-host.test.ts tests/model-routing.test.ts`。主机入口并发检查：在 `vendor/magpie` 执行 `go test -race -tags nogui ./cmd/wawu-host`。使用本机合成服务，不调用真实付费供应商。上游全部测试、跨系统签名、社区订阅插件和真实供应商的型号兼容性不由这些测试替代。
