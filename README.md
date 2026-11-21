# StuHelper 工程工具

<!-- updated: 2026-11-21 -->

供 StuHelper 各仓库使用的公共检查器、GitHub Actions 和 Lefthook 预设。模块清单、业务术语和部署配置由所属仓库维护。

## 版本与引用

最新正式发行是 [v0.1.12](https://github.com/StuHelper/stuhelper-tooling/releases/tag/v0.1.12)。StuHelper v0.1.31 的根仓固定使用工具包 v0.1.11，各业务仓库的实际引用见各自的锁文件和工作流。[发行组合的工具链清单](https://github.com/StuHelper/stuhelper/blob/v0.1.31/architecture/toolchains.yaml)

消费者通过明确的 Git tag 安装 `@stuhelper/engineering-tools`，并为复用的 Actions 与工作流固定版本 tag。升级时核对仓库的依赖声明、锁文件与工作流引用。

## 本地检查

消费者运行 `pnpm exec stuhelper-check <命令>`。Node.js 和 pnpm 版本由消费者仓库声明，`workflows` 另外需要 PATH 中的 actionlint 1.7.12。

| 命令 | 检查范围 |
| --- | --- |
| `repository` | 跟踪文件和未被忽略的新文件的 JSON/YAML 语法、受限路径、私钥头与脚本执行权限 |
| `contracts` | 生成文件标记、`contracts/*.source.json` 的来源提交、版本与摘要，以及生成文件变更是否涉及契约或生成器 |
| `docs [--glossary FILE]` | Markdown、元信息、日期、场景与 ADR 编号、导航、链接和项目术语 |
| `i18n` | 按 `locale-policy.yaml` 核对语言、文字方向和默认时区，合并检查应用与共享组件的消息键、插值和复数分支 |
| `locale-policy [--write]` | 比对 YAML 和运行时 JSON 快照。加 `--write` 从 YAML 生成 JSON |
| `staged [--eslint] [--glossary FILE]` | 检查暂存快照的文件安全、语法和 Git 权限，按变更联动文档、国际化与契约检查。加 `--eslint` 检查暂存的前端文件 |
| `workflows` | 用 actionlint 验证 GitHub 工作流 |

检查默认只读，失败返回非零退出码。GitHub Actions 为各项问题显示注解和摘要，文档与工作流诊断包含文件和行号。文件安全检查报告命中的路径，受限路径规则也检查符号链接。

暂存区检查通过隔离的 Git 环境读取索引快照，文档删除及重命名同样触发断链检查。检查保留未暂存的改动，复用已安装依赖。文档日期检查通过 Git 历史追溯正文的最近改动，历史不足的浅克隆需要补取提交。

前端仓库可用 `presets/lefthook-frontend.yml` 启用 `staged --eslint`，并通过 `@stuhelper/engineering-tools/presets/frontend-eslint` 检查 Vue 控件可访问名称、键盘交互、界面文案翻译及 JSON 重复键。

本仓使用 Node.js 24.22.1 和 pnpm 10.33.4。安装 actionlint 后，在本仓运行以下命令。

```bash
make setup
make check
```

`make check` 执行仓库检查、测试、文档和工作流检查。`make build` 检查脚本语法和工具包文件清单。`make hooks` 启用本仓的 Lefthook 暂存区检查。

## CI 复用

公开 Linux 仓库使用 `node-checks.yml` 或 `go-checks.yml`，在 GitHub 托管的 `ubuntu-26.04` 上运行。私有仓库使用对应的 `-private.yml`，由 `stuhelper-arc` 组接单。调用方通过 `name` 指定检查名称。Go 检查使用 `GOWORK=off`。

`actions/setup` 按调用仓库声明准备 Node.js、pnpm 和可选的 Go，下载 actionlint 时校验归档摘要。作业摘要记录工具版本与准备耗时。有 pnpm 归档摘要时，核对声明摘要和 npm 发布的 SHA-512 后安装。仅声明版本时可复用匹配的预装 pnpm。

公开托管作业支持恢复 pnpm store、Go 模块和编译缓存。私有自建作业在站点设置 `STUHELPER_CACHE_READY=true` 后启用缓存。可信 develop/main 的 push 或手动运行成功后可保存，其他符合条件的作业只恢复。

托管前端作业可用 `actions/frontend-cache` 复用 Vite 和 TypeScript 中间文件。安装锁定依赖后调用 `actions/chromium`，按锁文件恢复 Chromium 并在当前 runner 上安装系统库。

### PostgreSQL 与私有模块

本仓 develop 的 `actions/setup` 在启用 `postgres: 'true'` 后，复用或从签名软件源安装 `postgresql-18` 与 `postgresql-client-18`。脚本报告二进制版本，并设置 `STUHELPER_TEST_PG_BIN` 供测试使用。补丁版本由软件源提供。

develop 的 Go 检查工作流接受 `postgres` 参数，并由 `actions/repository-check` 调用 `actions/setup@v0.1.12`。该标签使用 PostgreSQL 元包准备工具，从服务端元包解析主版本。复用工作流须更新 setup 引用后才会采用固定主版本的实现。

私有 Go 工作流可接收 `modules-read-token`，用临时 Git 配置下载当前 `go.mod` 的依赖。作业收尾时删除临时配置。

## 应用发行

### GitHub 发行附件

调用方按仓库可见性选择 `release.yml` 或 `release-private.yml`。工作流按自身源码提交检出构建 action。打包前核验 backend 可执行文件、Web 与 Admin 的非空页面入口和校园同步工具的唯一版本记录。

构建作业以只读权限生成发行文件，上传保留 1 天的 Actions artifact。发布作业按 artifact ID 下载，核对清单与校验和，使用 release 环境的写权限上传草稿。附件重新下载并核验通过后公开。

重试复用内容相同的附件，遇到内容不同的同名附件时停止发行。已公开版本只执行附件核验。

### OCI 镜像

`image.yml` 在托管 runner 上使用 Buildx 的容器驱动。`image-private.yml` 由 `stuhelper-arc` 组接单，使用站点通过 `BUILDKIT_HOST` 提供的远程 BuildKit。两者均以版本 tag 推送 GHCR。

镜像作业核对应用的注释 tag 及 main 祖先关系，使用应用源码目录构建 linux/amd64 镜像并附带来源证明与 SBOM。已有同名 tag 或无法确认 tag 不存在时停止构建。发行摘要记录镜像 digest 和源码提交。

作业使用独立的 Registry 认证目录，收尾时清除认证文件。Buildx 实例由 setup action 的 Post 步骤注销。
