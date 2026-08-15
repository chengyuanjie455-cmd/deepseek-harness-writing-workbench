# 安全说明

## 支持范围

本仓库是 <code>dsh-better-sidebar 0.12.2</code>、上游提交 <code>aa0378d29536efe775d0432fd6f52abf69165272</code> 的整理发布版。插件代码安全问题应优先按上游仓库当前政策报告；本仓库负责自身新增文档、视觉素材与发布包的完整性问题。

## 报告方式

- 不要在公开 Issue 中粘贴真实密钥、令牌、Cookie、私有路径或可直接利用的敏感数据；
- 对整理版文档、归档或校验问题，可在本仓库创建最小复现 Issue；
- 对插件运行代码漏洞，请先查看并联系上游：[omdsh-dev/DSH-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar)。

## 使用提醒

- <code>curl | bash</code> 与 <code>irm | iex</code> 会执行远程代码，建议先下载并审阅脚本；
- HTML 预览与内嵌浏览器默认使用沙箱；关闭沙箱只适用于完全可信的内容；
- 终端、文件写入和 Git 操作会访问会话工作目录，使用前确认 DSH 的信任与目录边界配置；
- 不要把包含个人创作素材、账号配置或密钥的整个工作目录直接公开。
