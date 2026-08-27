**简体中文** | [English](./README.en.md)

# workspace-files

> [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) Web GUI 插件 —— 在会话界面里浏览工作区目录、查看文件内容，并结合 Git 显示行级改动（diff）。

![license](https://img.shields.io/badge/license-MIT-blue.svg)
![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-plugin-6c4cf1)
![profile](https://img.shields.io/badge/profile-web-informational)
[![LINUX DO](https://img.shields.io/badge/LINUX%20DO-社区推荐-ffb003?logo=discourse&logoColor=white)](https://linux.do)
[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com/p/sqfcyily/dsh-workspace-files/)

![workspace-files 截图](docs/155158.png)

## 简介

`workspace-files` 给 dsh 的 Web GUI 会话视图（`conversation.view`）加了一个「**文件**」标签页，与「对话」「轨迹」并列。它让你：

- 📂 浏览当前会话工作区（session 的 `cwd`）的目录树；
- 📄 查看文本文件内容；
- 🔀 若工作区是 Git 仓库，在文件上显示状态角标（`M`/`A`/`D`/`R`/`?`），并按行查看 diff。

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

从 GitHub Release 下载对应版本的 tarball，然后安装（web profile）：

```powershell
dsh plugin --profile web add ./workspace-files-0.1.1.tgz
```

也可以直接从 GitHub 安装：

```powershell
dsh plugin --profile web add github:sqfcyily/dsh-workspace-files
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

## 安全性

- 所有文件系统访问都经 `confine(root, target)` 校验，确保目标落在会话工作区根内，否则返回 `403`。
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

- [x] 语法高亮。
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

会生成 `workspace-files-<version>.tgz`，即 `dsh plugin add` 消费的产物。

## 相关链接

- DeepSeek Harness 官方仓库：<https://github.com/deepseek-ai/deepseek-harness>
- 社区插件常用 topic：[`dsh-plugin`](https://github.com/topics/dsh-plugin)

## 许可证

[MIT](./LICENSE) © 2026 sqfcy
