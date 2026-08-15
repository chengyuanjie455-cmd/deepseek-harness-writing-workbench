# 发布溯源与完整性

## 发布身份

- 项目包名：<code>dsh-better-sidebar</code>
- 软件版本：<code>0.12.2</code>
- 上游仓库：<https://github.com/omdsh-dev/DSH-better-sidebar>
- 锁定提交：<code>aa0378d29536efe775d0432fd6f52abf69165272</code>
- 整理仓库：<https://github.com/chengyuanjie455-cmd/deepseek-harness-writing-workbench>
- 整理日期：<code>2026-08-15</code>

## 输入归档

| 文件 | SHA256 | 结果 |
|---|---|---|
| <code>DSH-better-sidebar-源码-aa0378d.tar.gz</code> | <code>2f80f06224660f402dee0924a530ebebbc91e0e5b409bbf69941cf27376a2737</code> | 与用户提供清单一致 |
| <code>DSH-better-sidebar-源码-aa0378d.zip</code> | <code>b6c251db5e7266a5a7060602502a996ef715fdfffc3a64d803229210dd72f3fb</code> | 与用户提供清单一致 |

两份归档各含 171 个条目。使用 macOS 兼容 ZIP 解码后，二者解出的 157 个文件逐文件一致；未发现绝对路径或 <code>../</code> 路径穿越条目。系统自带 <code>unzip</code> 对中文文件名「使用说明.md」存在显示编码问题，但 <code>unzip -t</code> 完整性测试通过。

## 整理版改动

整理版不修改插件运行代码、依赖、包名、版本、上游地址、许可证或原版权声明，只新增或调整：

- 中英文 README 的首屏排版、来源声明与导航；
- 原创 README 主视觉与竖版开源海报；
- 本发布溯源文档；
- <code>CONTRIBUTING.md</code> 与 <code>SECURITY.md</code>；
- 中文使用说明中的整理仓库克隆地址；
- <code>.gitignore</code> 与消费者类型检查脚本末尾的多余空行清理，不改变运行语义；
- Git 日志分页测试改为按仓库实际可用历史切片验证，以兼容新仓库和浅克隆；插件运行代码不变；
- 挂载冒烟脚本中紧邻中文标点的 Bash 变量改用花括号展开，修复 <code>set -u</code> 下的变量名误判；不改变挂载流程。

## 开源与敏感信息预检

- 许可证：MIT，原版权声明保留；
- 未发现 <code>.env</code>、私钥、凭据文件或常见 API 密钥 / 令牌标识；
- 源码中的 <code>/Users/me</code>、<code>C:\Users\me</code> 等路径均为跨平台测试样例；
- <code>node_modules/</code>、<code>lib/</code>、测试报告、缓存和 npm 打包产物均由 <code>.gitignore</code> 排除。

## 视觉资产

| 资产 | 尺寸 | SHA256 |
|---|---:|---|
| <code>docs/assets/workbench-hero.png</code> | 1672 × 941 | <code>e5e4c88c23f30678c737abd90d8ef6d3ee4319ec4fcc8771b048401517a571e1</code> |
| <code>docs/assets/open-source-poster.png</code> | 1003 × 1568 | <code>1f3009179ae74fca1da719f0ee98da1113b5f9a9c992e13eb5ef3c4387aad388</code> |

两项视觉资产均为本次整理流程生成的原创项目配图，不使用第三方商标、人物肖像或水印。

## 本次技术验证

| 检查项 | 结果 | 说明 |
|---|---|---|
| 输入归档哈希与解包对比 | 通过 | TAR.GZ 与 ZIP 均匹配用户提供的 SHA256 清单，解出文件一致 |
| 敏感信息预检 | 通过 | 未发现常见密钥、令牌、私钥或凭据文件 |
| README 本地链接与图片路径 | 通过 | 中英文 README 所引用的本地文件均可解析 |
| <code>pnpm install --frozen-lockfile</code> | 通过 | 锁文件安装成功 |
| <code>pnpm typecheck</code> | 通过 | TypeScript 类型检查通过 |
| <code>pnpm test</code> | 通过 | 39 个测试文件、502 项测试全部通过 |
| <code>pnpm build</code> | 通过 | 生产构建完成；构建器仅输出非阻断弃用与依赖提示 |
| <code>pnpm check:consumer-types</code> | 通过 | 插件声明面检查通过；上游依赖的严格声明噪声按脚本设计隔离 |
| <code>pnpm pack</code> | 通过 | 生成 164 项文件的 npm 包，SHA256：<code>a78bc2f611a5e7b1b8de3fee349c7a80aed0321f1bbefe8c20df9e3f25b3345f</code> |
| 真实 DSH profile 安装、bundle 注册与服务启动 | 通过 | 在临时 <code>DSH_HOME</code> 中完成，未触碰用户现有 profile；<code>dsh web</code> 成功监听随机本地端口 |
| Playwright 无头渲染 | GitHub CI 通过 | 本机缺少对应 Chromium 运行件，下载长时间无输出后主动停止；GitHub Actions 的 <code>plugin-mount</code> 已完成真实 DSH 挂载与无头渲染 |

GitHub Actions 首轮发布验证：<https://github.com/chengyuanjie455-cmd/deepseek-harness-writing-workbench/actions/runs/31875558028>。其中 <code>ci</code> 与 <code>plugin-mount</code> 两个作业均为 <code>success</code>。

## 验证边界

归档一致、敏感信息扫描、静态文件清单和本地构建 / 测试分别记录。任一技术检查通过，都不自动代表上游功能、平台兼容性或安全审计的永久结论；真实使用仍应参考当前上游版本与 CI 结果。
