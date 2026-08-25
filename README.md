# workspace-files

> [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) Web GUI 插件 —— 在会话界面里浏览工作区目录、查看文件内容，并结合 Git 显示行级改动（diff）。

![license](https://img.shields.io/badge/license-MIT-blue.svg)
![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-plugin-6c4cf1)
![profile](https://img.shields.io/badge/profile-web-informational)

<!-- 建议在此处放一张「文件」标签页的截图，例如 docs/screenshot.png：
![workspace-files 截图](docs/screenshot.png) -->

## 简介

`workspace-files` 给 dsh 的 Web GUI 会话视图（`conversation.view`）加了一个「**文件**」标签页，与「对话」「轨迹」并列。它让你：

- 📂 浏览当前会话工作区（session 的 `cwd`）的目录树；
- 📄 查看文本文件内容；
- 🔀 若工作区是 Git 仓库，在文件上显示状态角标（`M`/`A`/`D`/`R`/`?`），并按行查看 diff。

插件是**单一 npm 包**，同时包含「宿主（Node）」和「浏览器（React）」两半：宿主半在 dsh 的共享 web 服务器上注册若干只读 HTTP 路由；浏览器半用普通 `fetch` 调用这些路由并渲染 UI。无需额外服务、无需数据库、零运行时依赖。

## 功能特性

- **目录树浏览** —— 懒加载展开，目录优先排序，隐藏文件（`.` 开头）弱化显示。
- **文件查看** —— UTF-8 文本内容；二进制文件自动识别并跳过；超大文件截断并提示。
- **Git 集成** —— working tree 状态角标；tracked / untracked 文件的行级统一 diff（新文件通过 `git diff --no-index` 对比空设备，也能显示新增行）。
- **主题自适应** —— 全程使用 DSH 主题 token（无硬编码颜色/边框），与轨迹视图观感一致，明暗主题都协调。
- **安全隔离** —— 所有文件系统访问限制在会话工作区根目录内，路径穿越返回 `403`。
- **优雅降级** —— 非 Git 目录、缺少 `git` 可执行文件、二进制/未跟踪文件，都会返回结构良好的响应；前端自动隐藏 diff 入口，退化为纯浏览。

## 环境要求

- 已安装并可运行 **DeepSeek Harness**（`dsh` CLI），且启用了 **web** profile。
- **Node.js** —— 具体版本要求以 dsh 为准。
- **Git**（可选）—— 在 `PATH` 上时启用 diff 功能；缺失时插件自动降级，仅浏览文件。

## 安装

从打包好的 tarball 安装（web profile）：

```powershell
dsh plugin --profile web add ./workspace-files-0.1.0.tgz
```

> `dsh` 不在 `PATH` 时，可用：`npx -y @deepseek-ai/dsh plugin --profile web add ./workspace-files-0.1.0.tgz`

也可以直接从 GitHub 安装（把 `<owner>/<repo>` 换成你的仓库）：

```powershell
dsh plugin --profile web add github:<owner>/<repo>
```

安装后重新打开 dsh Web GUI，会话视图顶部会出现「文件」标签页。

## 卸载

```powershell
dsh plugin --profile web remove workspace-files
```

## 使用

1. 打开 dsh Web GUI（默认 `http://127.0.0.1:3080`）。
2. 进入任意会话，在会话视图顶部选择「**文件**」标签。
3. 左侧目录树：点击目录展开，点击文件查看内容。
4. 若工作区是 Git 仓库：文件名右侧显示状态角标；打开文件后，右上角可在「**内容 / 改动**」间切换查看 diff。

工作区根目录取自当前会话的 `cwd`（dsh 记录的 session header），插件通过 `sessionId` 向宿主解析，无需手动指定路径。

## 架构 / 工作原理

单包双面（dual-face）：`cordis.patch.yml` 向 web profile 插入**一行**，让 loader 同时装载两半。

```
workspace-files（单包）
├── 宿主半  lib/index.js  (exports ".")       → 作为 host 插件运行，注册 HTTP 路由（inject: webServer）
└── 浏览器半 lib/client.js (exports "./client") → 作为 conversation.view 标签下发到浏览器
```

- **宿主半**：一个 Cordis `apply` 在共享 web 服务器上注册两个前缀路由座（files + git）。逻辑全部基于 Node 内置模块（`fs` / `child_process` / `path`）。
- **浏览器半**：一个注册到 `conversation.view` 插槽的 React 组件（经 `__ModuleLoader__.load`），用普通 `fetch` 调用宿主路由（不走 Typert RPC），自包含。
- **Patch**：`cordis.patch.yml` 在 `@deepseek-ai/dsh-web-app` 之后插入 `workspace-files` 行，此时 `ctx.webServer` 与客户端模块清单均已就绪。

## HTTP API

宿主半注册的只读路由（前缀可配置）。均为 `GET`，返回 JSON。

### 文件 `/api/workspace-files`

| 路由 | 参数 | 返回 |
|---|---|---|
| `/session-root` | `sessionId` | `{ sessionId, root \| null }` —— 按 id 解析会话工作区根 |
| `/list` | `root`, `path?` | `{ root, path, name, entries[], truncated }` |
| `/read` | `root`, `path` | `{ path, name, size, binary, truncated, content }` |

`entries[]` 每项：`{ name, path, kind: "dir" | "file" | "symlink", hidden }`（目录优先、按名排序）。

### Git `/api/workspace-git`

| 路由 | 参数 | 返回 |
|---|---|---|
| `/is-repo` | `root` | `{ isRepo, gitMissing? }` |
| `/status` | `root` | `{ isRepo, files[] }` |
| `/diff` | `root`, `path` | `{ path, rel, tracked, hunks[] }` |

- `files[]` 每项：`{ path, rel, code, staged }`，`code` 为单字母状态（`M`/`A`/`D`/`R`/`C`/`?`）。
- `hunks[]` 每项：`{ header, lines: [{ type: "add" | "del" | "ctx", text }] }`。

> 路径穿越（`path` 超出 `root`）一律返回 `403`。

## 配置

`apply(ctx, config)` 支持覆盖路由前缀（在 patch 配置中传入）：

| 选项 | 默认值 | 说明 |
|---|---|---|
| `filesPrefix` | `/api/workspace-files` | 文件路由前缀 |
| `gitPrefix` | `/api/workspace-git` | Git 路由前缀 |

内置上限（源码常量，见 `lib/index.js`）：

| 常量 | 值 | 含义 |
|---|---|---|
| `MAX_READ_BYTES` | 512 KB | 单文件读取上限，超出截断并标记 `truncated` |
| `MAX_ENTRIES` | 2000 | 单层目录列举上限，超出标记 `truncated` |
| `MAX_DIFF_BYTES` | 2 MB | 单次 `git diff` 解析上限 |

## 安全性

- 所有文件系统访问都经 `confine(root, target)` 校验，确保目标落在会话工作区根内（含根本身），否则返回 `403`。
- 符号链接按自身类型上报，但**不跟随**（v1 保持简单、安全）。
- 二进制文件（前 8000 字节含 NUL）不返回内容，仅返回 `binary: true` 标记。
- 仅暴露 `GET` 只读路由；不提供写入 / 删除 / 执行接口。

## 已验证行为

- host `/api/workspace-files/session-root`：按 `sessionId` 解析会话工作区根（读 `sessionPersistence` 的 header `cwd`）。
- host `/api/workspace-files/list|read`：目录列举、文件读取、路径穿越返回 `403`。
- host `/api/workspace-git/is-repo|status|diff`：仓库探测、status 解析、tracked/untracked 文件的行级 diff。
- 非 git 目录 / git 缺失：`is-repo` 返回 `false`，前端自动隐藏 diff 入口。
- 客户端 bundle 经 `/plugins/workspace-files/client.js` 正确下发，并出现在启动清单中。

## 限制与已知约束

- 尚未接入语法高亮（当前为纯文本 `<pre>`）。
- diff 仅统一（inline）视图，暂无并排（split）视图。
- 单层目录最多 2000 条，超大目录会截断（无分页 / 增量懒加载）。
- 符号链接不跟随。

## 路线图

- [ ] 语法高亮（引入 shiki）。
- [ ] diff 并排（split）视图。
- [ ] 超大目录的分页 / 增量懒加载。

## 本地开发

`lib/` 即源码（纯 ESM JavaScript，无编译步骤）：

```
lib/index.js       宿主（Node）半 —— HTTP 路由
lib/client.js      浏览器（React）半 —— 文件浏览器 UI
cordis.patch.yml   web profile 补丁（插入 dual-face 行）
package.json       包清单 + dsh.bundle / dsh.client 声明
```

打包成可安装的 tarball：

```powershell
npm pack
```

会生成 `workspace-files-<version>.tgz`，即 `dsh plugin add` 消费的产物。

## 兼容性说明

DeepSeek Harness 目前处于 developer preview，迭代较快，可能有破坏性变更。本插件依赖 dsh 的 `webServer` 服务与 `conversation.view` 插槽约定，上游接口调整时可能需要同步更新。

## 相关链接

- DeepSeek Harness 官方仓库：<https://github.com/deepseek-ai/deepseek-harness>
- 社区插件常用 topic：[`dsh-plugin`](https://github.com/topics/dsh-plugin)

## 许可证

[MIT](./LICENSE) © 2026 sqfcy
