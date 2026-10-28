# 发布前安全审查记录

审查对象：当前源码树的脱敏发布副本。

## 已排除

- `work/`、`data/`、`dist/`、`runtime/`、`node_modules/`、`.playwright-cli/` 和其他运行/构建产物
- `desktop/signing-identity.json` 及桌面运行目录
- 生成的原生 `studio.cjs/studio.css`
- 旧的本机验收、恢复演练、外接盘校验和事件现场脚本
- `docs/history/`、旧交接记录、业务项目和外部输出目录
- `.env*`、证书、私钥、日志和压缩包

## 脱敏处理

发布副本中的本机用户名、主机名、外接盘路径和精确 LAN 地址已替换为占位符；测试中保留的 key/token 形状均为合成值并统一重命名为 `fixture-token-*`、`*-redacted` 或 `synthetic-*`。没有从本机运行配置读取任何密钥。

## 验证

发布前应在干净克隆中重新运行：

```sh
npm ci --ignore-scripts
npm run check
npm run build
npm test
git diff --check
```

本文件不证明任何真实供应商调用、费用、模型容量或生产部署已经通过。
