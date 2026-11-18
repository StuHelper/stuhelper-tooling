# StuHelper 工程工具

供 StuHelper 各仓库使用的公共检查器、GitHub Actions 和 Lefthook 预设。工具独立发行，项目的模块清单、业务术语和部署配置由所属仓库维护。

## 本地使用

消费者通过固定版本安装 `@stuhelper/engineering-tools`，使用 `pnpm exec stuhelper-check`。Node.js 与 pnpm 版本由仓库自身声明；工作流检查另外需要 actionlint 1.7.12。

| 命令 | 检查范围 |
| --- | --- |
| `repository` | 跟踪文件、JSON/YAML 语法、私有材料文件名和脚本执行权限 |
| `docs` | Markdown、元信息、日期、索引、链接和可选项目术语 |
| `i18n` | 仓库内 locale-policy.yaml 声明的语言、消息与格式 |
| `locale-policy --write` | 从 YAML 生成前端运行时需要的 JSON 快照；省略 --write 时只核对 |
| `staged` | 暂存区快照的快速检查，保留未暂存内容 |
| `staged --eslint` | 另对暂存的前端文件运行仓库自己的 ESLint |
| `workflows` | actionlint 验证 GitHub 工作流 |

检查默认只读。非零退出码表示失败，GitHub 环境增加文件注解和结果摘要。暂存区检查只使用已安装依赖，不执行安装、构建或网络请求。

```bash
pnpm install --frozen-lockfile
pnpm run check
pnpm exec lefthook install
```

## CI 复用

`actions/setup` 使用仓库声明的 Node、pnpm 和 Go 版本。可信 develop/main 的成功运行通过 setup-node 和 setup-go 保存 pnpm store、Go 模块与编译结果。其他运行使用相同键只读恢复。私有仓依赖缓存要求站点已启用自建服务。

公开 Linux 检查使用 `node-checks.yml` 或 `go-checks.yml`，私有仓使用同名的 `-private.yml`。检查名称由调用方指定。发行工作流也按此约定选择。公开应用镜像由托管 runner 推送 GHCR，私有应用使用站点提供的 BuildKit。

前端通过 `actions/frontend-cache` 复用 Vite 与 TypeScript 的中间文件。安装锁定依赖后调用 `actions/chromium`，按锁文件复用 Chromium，并在每台托管 runner 上准备系统库。Go 正式检查使用 `GOWORK=off`。
