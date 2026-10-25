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

`actions/setup` 安装仓库声明的 Node/pnpm 和固定版本 actionlint。`node-checks.yml` 与 `go-checks.yml` 执行消费者自身的检查命令，公开工作流不读取私有模块。

各仓库自行声明触发事件与 required check。工作流分别负责自己的职责，源代码候选联调和实际镜像组合验证在各自仓库维护。

## 开发约定

工程脚本采用 Node.js ESM。Shell 仅连接短小命令，已有专业工具继续使用原生实现。直接执行的入口使用 shebang 和 Git 执行位，内部库与解释器调用脚本保持普通文件权限。

工具版本使用不可变的 `vX.Y.Z` tag。工具测试、公共工作流验证和消费者验证通过后发行，不在消费者构建时跟踪工具默认分支。

项目使用 AGPL-3.0-only，检查器起源于 StuHelper Next，保留本仓库的许可证与来源说明。
