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

检查默认只读。非零退出码表示失败，GitHub 环境增加文件注解和结果摘要。暂存区按索引中的权限检查脚本，并在隔离的 Git 环境中检查文档日期、删除与重命名产生的断链。敏感文件名规则也检查符号链接。暂存区检查只使用已安装依赖，不执行安装、构建或网络请求。

```bash
pnpm install --frozen-lockfile
pnpm run check
pnpm exec lefthook install
```

## CI 复用

`actions/setup` 使用仓库声明的 Node、pnpm 和 Go 版本。可信 develop/main 的成功运行通过 setup-node 和 setup-go 保存 pnpm store、Go 模块与编译结果。其他运行使用相同键只读恢复。私有仓依赖缓存要求站点已启用自建服务。

公开 Linux 检查使用 `node-checks.yml` 或 `go-checks.yml`，私有仓使用同名的 `-private.yml`。检查名称由调用方指定。发行工作流也按此约定选择。公开应用镜像由托管 runner 推送 GHCR，私有应用使用站点提供的 BuildKit。

前端通过 `actions/frontend-cache` 复用 Vite 与 TypeScript 的中间文件。安装锁定依赖后调用 `actions/chromium`，按锁文件复用 Chromium，并在每台托管 runner 上准备系统库。Go 正式检查使用 `GOWORK=off`。

启用 PostgreSQL 的检查会分别核验服务端、客户端元包以及 psql。缺少完整安装时，以非交互模式从签名软件源补装。

### 发行文件检查

调用方通过可复用工作流的版本选择发行实现。工作流按自身源码提交检出同版本的构建 action。打包前校验 backend 的可执行入口、Web 与 Admin 的非空页面入口，以及校园同步工具输出的唯一版本记录。

对应版本的发行草稿按附件逐件上传并重新下载核对，全部通过后公开。重试复用内容相同的附件，已公开版本仅做核验。同名附件内容不一致时停止发行。

packageManager 声明 pnpm 归档摘要时，setup 同时核验该摘要与 npm 发布的 SHA-512，然后使用已核验文件安装。未声明摘要时仍可复用匹配版本的预装 pnpm。

镜像构建只使用应用源码目录。主步骤清除本作业的 Registry 认证文件，保留 Buildx 实例记录供 Post 步骤注销。无法确认镜像不存在时，记录 Registry 错误并停止构建。

文档检查会解析嵌套导航、核验显式指定的术语表，并沿正文相同的父提交追溯更新时间。浅克隆在历史不足时提示补取。

国际化检查合并应用与共享包的消息，验证消息键、参数、各语言复数分支、RTL 方向和默认时区。

检查器按独立问题输出 GitHub 注解。文档与工作流检查提供文件和行号，多行错误保留在同一条诊断中。

仓库检查按文件类型读取内容。脚本检查只读取入口标记，Git 历史和暂存区清单使用 32 MiB 的输出上限。

CLI 拒绝不适用的参数。仓库与暂存检查识别受限文件名、敏感目录及私钥头。发现私钥时只报告路径。
