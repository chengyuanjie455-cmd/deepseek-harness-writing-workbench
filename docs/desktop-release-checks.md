# macOS 桌面发布检查

macOS 改名需同时处理主应用 CFBundleName、显示名、可执行文件，以及普通 / Renderer / GPU / Plugin 辅助应用的目录、plist 和可执行文件。保留既有 CFBundleIdentifier 与显式 userData 路径，以保留账号及项目配置。既有加密登录缓存也须检查读取与重新启动后的登录。

Electron 会用应用名称寻找辅助程序。只修改外层 .app、显示名或主 plist 会导致 `Unable to find helper app`，即使 codesign 校验通过，也仍会启动崩溃。

打包脚本已在签名前调用 `mac-bundle.cjs`，检查实际主程序及四类辅助程序的完整路径。`tests/mac-bundle.test.cjs` 覆盖仅改主名称、仅改辅助目录、完整中文名称三种情况。

发布验收需针对最终安装的应用，而不是仅测试源码 UI：

1. 运行桌面测试与 `validateMacBundle`，然后验证 codesign 签名。
2. 关闭待测试桌面窗口（后台服务可继续运行），运行 `TEAM_SMOKE_ORIGIN=http://127.0.0.1:4325 node desktop/smoke-packaged.cjs /Applications/team-harness-platform.app /tmp/team-desktop-smoke.json`。仅对已授权的当前主机执行。该脚本等待渲染器、preload IPC 和主机状态，观察至少 8 秒，并关闭临时调试进程；后台实例编号必须不变。
3. 冷启动再验证一次，最后以正常方式启动；实际检查记住登录、原生项目聊天及连接状态。
4. 校验 DMG，只读挂载，比较安装包和实际安装目录的主程序、plist、app.asar，再验证辅助程序与签名。
5. 启动验证通过后再更新 CURRENT.json 并交付，撤下已知故障安装包。

当前安全与业务行为不因打包修复而放宽。调试端口仅测试期间监听本机，并在测试进程退出后关闭。

参考：[Electron 应用打包与更名文档](https://www.electronjs.org/docs/latest/tutorial/application-distribution)。
