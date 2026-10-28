# 开发交接说明（脱敏发布包）

## 当前交付

本包是多人编剧工作台的源码快照，目标是让下一位开发者在自己的本机或受控服务器上继续开发。源码以项目文件夹为边界，支持登录、项目管理、剧本/分镜/资产/视频/剪辑二级导航、中央画廊和右侧智能体聊天。成员聊天按账号隔离；管理员管理项目目录、模型、技能、API 和运行状态。

## 安装与验证

```sh
npm ci --ignore-scripts
cd native-harness && npm ci --ignore-scripts
cd ..
npm run check
npm run build
npm test
```

需要 Node.js 22.13.x、Git、Docker、ffmpeg 和 ffprobe。根目录和 `native-harness/` 都要分别安装锁定依赖。原生适配在 `native-harness/`，Magpie 上游源码在 `vendor/magpie/`。首次运行前由管理员配置数据根、账号、模型和 API；密钥只能留在部署机的受保护配置中。

## 重要边界

- 该发布包不包含业务项目、聊天记录、媒体、数据库、日志、运行时二进制、外接盘数据或桌面签名身份。
- 不要把 `.env`、密钥、Cookie、Bearer token、私有项目文件、导出媒体或本机路径提交到 Git。
- 外部 API 调用、费用、实际模型能力和媒体交付需要在目标环境单独验证；源码测试中的 token 都是合成占位值。
- 旧的本机验收脚本和恢复演练脚本已排除；需要时请在目标环境重新编写或从受保护的内部备份中取回。

## 建议接续顺序

1. 在隔离目录克隆本仓库，核对 `SECURITY_REVIEW.md` 和发布包 SHA-256。
2. 安装依赖，执行 `check`、`build`、`test`。
3. 用合成项目配置一个本地数据根，创建管理员和成员账号。
4. 先做登录、项目展示、三栏交互、附件引用、断线恢复和移动端验收。
5. 再逐个配置并验证聊天/图片/视频模型；保留调用、轮询、下载、哈希和费用记录。
6. 通过人工验收后再接入真实项目和生产 API。

## 代码入口

- 服务启动：`server/main.ts`
- API 与权限：`server/app.ts`、`server/account-access.ts`、`server/host-folders.ts`
- 网页入口：`web/`
- 桌面主机管理：`desktop/main.cjs`、`desktop/host-control.cjs`
- 原生工作台桥接：`native-harness/team-project/`
- 测试：`tests/`、`desktop/tests/`

## 提交前检查

```sh
git diff --check
rg -n --hidden -g '!node_modules/**' -g '!dist/**' -g '!work/**' -g '!runtime/**' -e 'BEGIN .*PRIVATE KEY|Bearer [^r]|sk-[A-Za-z0-9]{10,}|api[_-]?key.{0,20}[:=]' .
```

发现真实凭据时立即停止提交，撤销/轮换凭据并从历史中清除。
