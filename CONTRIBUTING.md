# 贡献指南

感谢你关注这个整理发布版。

## 先判断问题属于哪里

- 插件运行代码、功能、缺陷、兼容性与 API 设计：优先提交到上游 [omdsh-dev/DSH-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar)。
- 本仓库新增的 README 排版、海报、来源说明、校验记录与发布包：可在本仓库提交 Issue 或 Pull Request。

## 提交前检查

~~~sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm check:consumer-types
~~~

如果改动涉及真实 DSH 挂载，再运行：

~~~sh
pnpm test:mount
~~~

## 变更约束

- 保留 MIT 许可证与原版权声明；
- 不移除上游来源、锁定提交和发布溯源；
- 不提交 API 密钥、令牌、账号、绝对个人路径或原始创作素材；
- 代码变更使用独立分支和 Pull Request；
- 文档中的命令必须可复制，并注明适用平台与前置条件。
