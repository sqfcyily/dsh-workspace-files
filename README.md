**简体中文** | [English](./README.en.md)

# dsh-workspace-files

> [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) Web GUI 插件 —— 在会话界面里浏览工作区目录、查看文件内容，并提供类 VS Code 的 Git 源代码管理（暂存 / 提交 / 拉取 / 推送 / 分支切换 / 放弃更改 / 行级 diff）。

![license](https://img.shields.io/badge/license-MIT-blue.svg)
![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-plugin-6c4cf1)
![profile](https://img.shields.io/badge/profile-web-informational)
[![LINUX DO](https://img.shields.io/badge/LINUX%20DO-社区推荐-ffb003?logo=discourse&logoColor=white)](https://linux.do)
[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com/p/sqfcyily/dsh-workspace-files/)

![dsh-workspace-files 截图](docs/155556.gif)

## 简介

`dsh-workspace-files` 给 dsh 的 Web GUI 会话视图（`conversation.view`）加了一个「**文件**」标签页，与「对话」「轨迹」并列。它让你：

- 📂 浏览当前会话工作区（session 的 `cwd`）的目录树；
- 📄 查看文本文件内容；
- 🔀 若工作区是 Git 仓库，在文件上显示状态角标（`M`/`A`/`D`/`R`/`?`），并按行查看 diff；
- 🧰 通过内置的「源代码管理」面板完成 Git 操作：暂存 / 取消暂存 / 放弃更改、提交、拉取、推送、分支切换，以及 AI 生成提交信息。

## 功能特性

- **目录树浏览** —— 懒加载展开，目录优先排序，隐藏文件（`.` 开头）弱化显示。
- **文件查看** —— UTF-8 文本内容；二进制文件自动识别并跳过；超大文件截断并提示。
- **Git 集成** —— working tree 状态角标；tracked / untracked 文件的行级统一 diff（新文件通过 `git diff --no-index` 对比空设备，也能显示新增行），diff 带**行号 gutter**（横向滚动时固定）。
- **Git 源代码管理（类 VS Code）** —— 头部「📁 文件 / ⎇ Git」分段切换，Git 面板提供完整操作：
  - 变更按 **暂存的更改 / 更改** 两个可折叠分区展示（同一文件可同时出现在两区，如 `MM`），带变更数角标；
  - 单文件或整区的 **暂存（+）/ 取消暂存（−）/ 放弃更改（↩）**，行悬停显示行内操作，点击行直接打开 diff；
  - **提交** —— 支持**智能提交**（无已暂存内容时自动暂存全部再提交）、`Ctrl/⌘+Enter` 快捷提交；
  - **拉取（pull）/ 推送（push）/ 分支切换（checkout）**；
  - **✨ AI 生成提交信息** —— 使用当前会话所选模型，根据 diff 自动生成；
  - **放弃更改带确认弹层**（破坏性操作，二次确认后执行）；操作失败时红字内联提示。
- **主题自适应** —— 全程使用 DSH 主题 token（无硬编码颜色/边框），与轨迹视图观感一致，明暗主题都协调。
- **安全隔离** —— 所有文件系统与 Git 操作都限制在会话工作区根目录内，路径穿越返回 `403`。
- **优雅降级** —— 非 Git 目录、缺少 `git` 可执行文件、二进制/未跟踪文件，都会返回结构良好的响应；前端自动隐藏 Git 入口，退化为纯浏览。

## 环境要求

- 已安装并可运行 **DeepSeek Harness**（`dsh` CLI），且启用了 **web** profile。
- **Node.js** —— 具体版本要求以 dsh 为准。
- **Git**（可选）—— 在 `PATH` 上时启用 diff 功能；缺失时插件自动降级，仅浏览文件。

## 安装

从 GitHub Release 下载对应版本的 tarball，然后安装（web profile）：

```powershell
dsh plugin --profile web add ./dsh-workspace-files-0.1.2.tgz
```

也可以直接从 GitHub 安装：

```powershell
dsh plugin --profile web add github:sqfcyily/dsh-workspace-files
```

安装后重新打开 dsh Web GUI，会话视图顶部会出现「文件」标签页。

## 卸载

```powershell
dsh plugin --profile web remove dsh-workspace-files
```

## 使用

1. 打开 dsh Web GUI（默认 `http://127.0.0.1:3080`）。
2. 进入任意会话，在会话视图顶部选择「**文件**」标签。
3. 左侧目录树：点击目录展开，点击文件查看内容。
4. 若工作区是 Git 仓库：文件名右侧显示状态角标；打开文件后，右上角可在「**内容 / 改动**」间切换查看 diff。
5. 用左上角的「📁 文件 / ⎇ Git」分段切换进入 **源代码管理** 面板：
   - 在「更改」区把文件 **暂存（+）** 到「暂存的更改」区，或对整区一次性操作；
   - 在提交框输入信息（或点 **✨** 让 AI 根据 diff 生成），点 **✓ 提交**（无已暂存内容时会自动暂存全部；也可按 `Ctrl/⌘+Enter`）；
   - 用工具栏的 **↓ 拉取 / ↑ 推送** 与顶部的 **分支下拉** 完成 pull / push / 切换分支；
   - 需要丢弃改动时点文件或整区的 **↩ 放弃更改**，在弹出的确认框中确认（此操作不可撤销）。

工作区根目录取自当前会话的 `cwd`（dsh 记录的 session header），插件通过 `sessionId` 向宿主解析，无需手动指定路径。

## 安全性

- 所有文件系统访问都经 `confine(root, target)` 校验，确保目标落在会话工作区根内，否则返回 `403`；Git 操作中所有涉及路径的参数同样经 `confinedRelPaths` 边界化处理。
- 符号链接按自身类型上报，但**不跟随**（v1 保持简单、安全）。
- 二进制文件（前 8000 字节含 NUL）不返回内容，仅返回 `binary: true` 标记。
- **路由分工**：只读浏览（列目录 / 读文件 / diff / is-repo / status / branches）走 `GET`；Git **写操作**（stage / unstage / discard / commit / pull / push / checkout / commit-message）走 `POST`。文件系统一侧不提供写入 / 删除接口，写操作仅限 Git。
- Git 一律通过 `execFile` 直接调用 `git`（**不经 shell、无字符串拼接**），工作目录固定为会话工作区根，规避命令注入。
- **放弃更改（discard）为破坏性操作**：以 `git checkout --` 还原已跟踪文件、`git clean -fd` 删除未跟踪文件；前端**必定弹出确认对话框**后才执行。请知悉其不可撤销。

## 已验证行为

- host `/api/workspace-files/session-root`：按 `sessionId` 解析会话工作区根（读 `sessionPersistence` 的 header `cwd`）。
- host `/api/workspace-files/list|read`：目录列举、文件读取、路径穿越返回 `403`。
- host `/api/workspace-git/is-repo|status|diff`：仓库探测、status 解析（含索引/工作区两列 `x`/`y`）、tracked/untracked 文件的行级 diff。
- host `/api/workspace-git/branches|checkout|stage|unstage|discard|commit|pull|push|commit-message`：分支列举/切换、暂存/取消暂存/放弃更改、提交、拉取、推送、AI 提交信息生成。
- 非 git 目录 / git 缺失：`is-repo` 返回 `false`，前端自动隐藏 Git 入口。
- 客户端 bundle 经 `/plugins/workspace-files/client.js` 正确下发，并出现在启动清单中。

## 路线图

- [x] 语法高亮。
- [x] Git 源代码管理（暂存 / 提交 / 拉取 / 推送 / 分支切换 / 放弃更改）。
- [x] diff 行号 gutter。
- [ ] diff 并排（split）视图。
- [ ] 超大目录的分页 / 增量懒加载。

## 本地开发

`lib/` 即源码：

```
lib/index.js                  宿主（Node）半 —— HTTP 路由
lib/client.js                 浏览器（React）半 —— 文件浏览器 UI
cordis.patch.yml              web profile 补丁（插入 dual-face 行）
package.json                  包清单 + dsh.bundle / dsh.client 声明
```

打包成可安装的 tarball：

```powershell
npm pack
```

会生成 `dsh-workspace-files-<version>.tgz`，即 `dsh plugin add` 消费的产物。

## 相关链接

- DeepSeek Harness 官方仓库：<https://github.com/deepseek-ai/deepseek-harness>
- 社区插件常用 topic：[`dsh-plugin`](https://github.com/topics/dsh-plugin)

## 许可证

[MIT](./LICENSE) © 2026 sqfcy
