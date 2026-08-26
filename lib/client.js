window.__ModuleLoader__.load({
	id: "workspace-files",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		const React = require("react");
		const h = React.createElement;

		// ── HTTP client over the host-registered routes ─────────────────────────

		const FILES_PREFIX = "/api/workspace-files";
		const GIT_PREFIX = "/api/workspace-git";

		/** GET a JSON route; throws Error(message) on a non-ok response. */
		async function getJson(url, signal) {
			const res = await fetch(url, { signal });
			let body;
			try {
				body = await res.json();
			} catch {
				body = undefined;
			}
			if (!res.ok) {
				const message = body && body.error ? body.error : `HTTP ${res.status}`;
				throw new Error(message);
			}
			return body;
		}

		/** Resolve a session's workspace root (cwd) by id, via the host. */
		function sessionRoot(sessionId, signal) {
			const params = new URLSearchParams({ sessionId: String(sessionId) });
			return getJson(`${FILES_PREFIX}/session-root?${params.toString()}`, signal);
		}

		/** List one directory level under a workspace root. */
		function listDir(root, path, signal) {
			const params = new URLSearchParams({ root });
			if (path) params.set("path", path);
			return getJson(`${FILES_PREFIX}/list?${params.toString()}`, signal);
		}

		/** Read one file under a workspace root. */
		function readFile(root, path, signal) {
			const params = new URLSearchParams({ root, path });
			return getJson(`${FILES_PREFIX}/read?${params.toString()}`, signal);
		}

		/** Probe whether the workspace root is a git repository. */
		function gitIsRepo(root, signal) {
			const params = new URLSearchParams({ root });
			return getJson(`${GIT_PREFIX}/is-repo?${params.toString()}`, signal);
		}

		/** Git working-tree status for the workspace root. */
		function gitStatus(root, signal) {
			const params = new URLSearchParams({ root });
			return getJson(`${GIT_PREFIX}/status?${params.toString()}`, signal);
		}

		/** Structured diff hunks for one file. */
		function gitDiff(root, path, signal) {
			const params = new URLSearchParams({ root, path });
			return getJson(`${GIT_PREFIX}/diff?${params.toString()}`, signal);
		}

		// ── small helpers ───────────────────────────────────────────────────────

		/** Basename of an absolute path (both separators accepted). */
		function baseName(p) {
			const parts = p.split(/[\\/]/).filter(Boolean);
			return parts.length ? parts[parts.length - 1] : p;
		}

		/** Human-readable byte size. */
		function humanSize(n) {
			if (n < 1024) return `${n} B`;
			if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
			return `${(n / 1024 / 1024).toFixed(1)} MB`;
		}

		/** Status letter → short color for the git badge. */
		function statusColor(code) {
			switch (code) {
				case "M":
					return "#d29922";
				case "A":
					return "#3fb950";
				case "D":
					return "#f85149";
				case "R":
					return "#a371f7";
				case "?":
					// Untracked (new) files — green, like VS Code, so a brand-new
					// file stands out instead of blending into the default text.
					return "#3fb950";
				default:
					return "#8b949e";
			}
		}

		/**
		 * Whether any changed file lives under `dirPath` (recursively). The
		 * host-built status keys are absolute paths, so a directory is "dirty"
		 * when any changed path starts with `dirPath` + a separator. This lets a
		 * collapsed folder reflect inner changes without being expanded (no extra
		 * request), mirroring VS Code's folder decorations.
		 * @param {Record<string,string>} statusMap - absolute path → status code.
		 * @param {string} dirPath - absolute directory path.
		 * @returns {boolean}
		 */
		function folderHasChanges(statusMap, dirPath) {
			const prefixA = dirPath + "/";
			const prefixB = dirPath + "\\";
			for (const key in statusMap) {
				if (key.length > dirPath.length && (key.startsWith(prefixA) || key.startsWith(prefixB))) {
					return true;
				}
			}
			return false;
		}

		/** The single "has changes" accent color for folder decorations. */
		const FOLDER_DIRTY_COLOR = "var(--dsw-alias-state-warning-primary, #d29922)";

		// ── styles ───────────────────────────────────────────────────────────────
		// Uses DSH theme tokens (no hardcoded borders/colors) so the surface
		// matches the trajectory view. A one-time stylesheet carries the pieces
		// inline style cannot express (:hover, scrollbar theming).

		const STYLE_TAG_ID = "dsh-plugin-workspace-files-style";
		function ensureStyle() {
			if (typeof document === "undefined") return;
			if (document.getElementById(STYLE_TAG_ID)) return;
			const el = document.createElement("style");
			el.id = STYLE_TAG_ID;
			el.textContent = [
				// Independent scroll containers, subtle themed scrollbars.
				".wf-treePane, .wf-contentPane {",
				"  scrollbar-width: thin;",
				"  scrollbar-color: var(--dsw-alias-scrollbar-bg-l2, rgba(140,140,140,.35)) transparent;",
				"}",
				".wf-treePane::-webkit-scrollbar, .wf-contentPane::-webkit-scrollbar { width: 10px; height: 10px; }",
				".wf-treePane::-webkit-scrollbar-thumb, .wf-contentPane::-webkit-scrollbar-thumb {",
				"  background: var(--dsw-alias-scrollbar-bg-l2, rgba(140,140,140,.35));",
				"  border-radius: 6px; border: 2px solid transparent; background-clip: padding-box;",
				"}",
				".wf-treePane::-webkit-scrollbar-thumb:hover, .wf-contentPane::-webkit-scrollbar-thumb:hover {",
				"  background: var(--dsw-alias-scrollbar-hover-l2, rgba(140,140,140,.55)); background-clip: padding-box;",
				"}",
				// Row hover mirrors the trajectory toolbar/rows interaction.
				".wf-row { border-radius: 6px; }",
				".wf-row:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(140,140,140,.12)); }",
				".wf-row.wf-selected { background: var(--dsw-alias-interactive-bg-hover-solid, var(--dsw-alias-interactive-bg-hover, rgba(140,140,140,.18))); }",
				// Ghost buttons (content/diff toggle) — borderless, hover-tinted.
				".wf-btn {",
				"  background: transparent; border: 0; color: var(--dsw-alias-label-tertiary, inherit);",
				"  border-radius: 6px; padding: 3px 9px; cursor: pointer; font: inherit;",
				"}",
				".wf-btn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(140,140,140,.12)); color: var(--dsw-alias-label-primary, inherit); }",
				".wf-btn.wf-btnActive { background: var(--dsw-alias-interactive-bg-hover, rgba(140,140,140,.16)); color: var(--dsw-alias-label-primary, inherit); }",
			].join("\n");
			document.head.appendChild(el);
		}

		const viewStyle = {
			height: "100%",
			display: "flex",
			flexDirection: "column",
			color: "var(--dsw-alias-label-primary, inherit)",
			background: "var(--dsw-alias-bg-layer-1, transparent)",
			fontSize: "13px",
			minHeight: 0,
		};
		const headerStyle = {
			display: "flex",
			alignItems: "center",
			gap: "8px",
			padding: "8px 12px",
			borderBottom: "1px solid var(--dsw-alias-border-l2, rgba(140,140,140,.18))",
			color: "var(--dsw-alias-label-secondary, inherit)",
			flex: "0 0 auto",
		};
		// The body is a bounded (overflow:hidden) flex row so each pane becomes an
		// independent scroll container. `flex:1 1 0` + `min-height:0` is what
		// actually caps the body's height against the view column (a `basis:auto`
		// body would grow with its content and push the scroll to the outer
		// surface, scrolling both columns together). Each pane is `height:100%`
		// so it fills the capped body and scrolls within it.
		const bodyStyle = { display: "flex", flex: "1 1 0", minHeight: 0, overflow: "hidden" };
		const treePaneStyle = {
			width: "300px",
			flex: "0 0 auto",
			height: "100%",
			overflowY: "auto",
			overflowX: "hidden",
			minHeight: 0,
			boxSizing: "border-box",
			borderRight: "1px solid var(--dsw-alias-border-l2, rgba(140,140,140,.18))",
			padding: "6px 4px",
		};
		const contentPaneStyle = {
			flex: "1 1 0",
			height: "100%",
			overflow: "auto",
			minHeight: 0,
			minWidth: 0,
			boxSizing: "border-box",
			padding: "10px 14px",
		};
		const rowBase = {
			display: "flex",
			alignItems: "center",
			gap: "6px",
			padding: "3px 8px",
			cursor: "pointer",
			whiteSpace: "nowrap",
			userSelect: "none",
			color: "var(--dsw-alias-label-secondary, inherit)",
		};

		// ── Tree node ───────────────────────────────────────────────────────────

		/**
		 * One directory/file row with lazy expansion. `statusMap` maps absolute
		 * path → git status code for badges (empty when not a repo).
		 */
		function TreeNode(props) {
			const { entry, root, depth, statusMap, onOpenFile, selectedPath } = props;
			const [expanded, setExpanded] = React.useState(false);
			const [children, setChildren] = React.useState(null);
			const [loading, setLoading] = React.useState(false);
			const [error, setError] = React.useState(null);

			const isDir = entry.kind === "dir";
			const status = statusMap[entry.path];

			const toggle = React.useCallback(() => {
				if (!isDir) {
					onOpenFile(entry);
					return;
				}
				const next = !expanded;
				setExpanded(next);
				if (next && children === null) {
					setLoading(true);
					listDir(root, entry.path)
						.then((res) => {
							setChildren(res.entries || []);
							setError(null);
						})
						.catch((e) => setError(e.message))
						.finally(() => setLoading(false));
				}
			}, [isDir, expanded, children, root, entry, onOpenFile]);

			const selected = selectedPath === entry.path;
			const rowStyle = Object.assign({}, rowBase, { paddingLeft: `${8 + depth * 14}px` });
			const rowClass = "wf-row" + (selected ? " wf-selected" : "");

			const icon = isDir ? (expanded ? "\u25be" : "\u25b8") : "\u00b7";

			// A directory reflects inner changes: dirty when any changed path lives
			// under it (recursive, from the full status map — no expansion needed).
			// The decoration stays visible whether the folder is collapsed or open,
			// like VS Code.
			const dirDirty = isDir && folderHasChanges(statusMap, entry.path);
			// Name color, VS Code-style: a changed file tints its own name by
			// status code; a dirty folder uses the aggregate accent; otherwise
			// inherit. The file keeps its letter badge; the folder keeps its dot.
			const nameColor = status ? statusColor(status) : dirDirty ? FOLDER_DIRTY_COLOR : "inherit";

			return h(
				"div",
				null,
				h(
					"div",
					{ className: rowClass, style: rowStyle, onClick: toggle, title: entry.path },
					h("span", { style: { width: "10px", opacity: 0.7 } }, icon),
					h(
						"span",
						{
							style: {
								overflow: "hidden",
								textOverflow: "ellipsis",
								opacity: entry.hidden ? 0.6 : 1,
								color: nameColor,
							},
						},
						entry.name,
					),
					status
						? h(
								"span",
								{
									style: {
										marginLeft: "auto",
										color: statusColor(status),
										fontWeight: 600,
										fontSize: "11px",
									},
								},
								status,
							)
						: dirDirty
							? h("span", {
									style: {
										marginLeft: "auto",
										width: "7px",
										height: "7px",
										borderRadius: "50%",
										background: FOLDER_DIRTY_COLOR,
										flex: "0 0 auto",
									},
								})
							: null,
				),
				loading ? h("div", { style: { paddingLeft: `${22 + depth * 14}px`, opacity: 0.6 } }, "\u2026") : null,
				error
					? h(
							"div",
							{ style: { paddingLeft: `${22 + depth * 14}px`, color: "var(--dsw-alias-state-error-primary, #f85149)" } },
							error,
						)
					: null,
				expanded && children
					? children.map((c) =>
							h(TreeNode, {
								key: c.path,
								entry: c,
								root,
								depth: depth + 1,
								statusMap,
								onOpenFile,
								selectedPath,
							}),
						)
					: null,
			);
		}

		// ── Content view (file text or diff) ─────────────────────────────────────

		/** Render a unified diff from structured hunks. */
		function DiffView(props) {
			const { diff } = props;
			if (!diff || !diff.hunks || diff.hunks.length === 0) {
				return h("div", { style: { opacity: 0.6 } }, "无差异（工作区与 HEAD 一致）");
			}
			const lines = [];
			diff.hunks.forEach((hunk, hi) => {
				lines.push(
					h(
						"div",
						{
							key: `h${hi}`,
							style: {
								color: "var(--dsw-alias-state-business-primary, #58a6ff)",
								background: "var(--dsw-alias-bg-layer-2, rgba(140,140,140,.08))",
								padding: "2px 8px",
							},
						},
						hunk.header,
					),
				);
				hunk.lines.forEach((ln, li) => {
					let color = "inherit";
					let bg = "transparent";
					if (ln.type === "add") {
						color = "var(--dsw-alias-state-success-primary, #3fb950)";
						bg = "var(--dsw-alias-state-success-bg, rgba(63,185,80,.12))";
					} else if (ln.type === "del") {
						color = "var(--dsw-alias-state-error-primary, #f85149)";
						bg = "var(--dsw-alias-state-error-bg, rgba(248,81,73,.12))";
					}
					const prefix = ln.type === "add" ? "+" : ln.type === "del" ? "-" : " ";
					lines.push(
						h(
							"div",
							{ key: `h${hi}l${li}`, style: { color, background: bg, padding: "0 8px", whiteSpace: "pre" } },
							prefix + ln.text,
						),
					);
				});
			});
			return h(
				"pre",
				{ style: { margin: 0, fontFamily: "var(--dsh-mono, ui-monospace, monospace)", fontSize: "12px" } },
				lines,
			);
		}

		/** File content viewer with a text/diff toggle when a diff is available. */
		function ContentView(props) {
			const { root, entry, hasGit } = props;
			const [mode, setMode] = React.useState("text");
			const [file, setFile] = React.useState(null);
			const [diff, setDiff] = React.useState(null);
			const [loading, setLoading] = React.useState(false);
			const [error, setError] = React.useState(null);

			React.useEffect(() => {
				if (!entry) return;
				const ctrl = new AbortController();
				setLoading(true);
				setError(null);
				setFile(null);
				setDiff(null);
				readFile(root, entry.path, ctrl.signal)
					.then((res) => setFile(res))
					.catch((e) => {
						if (e.name !== "AbortError") setError(e.message);
					})
					.finally(() => setLoading(false));
				return () => ctrl.abort();
			}, [root, entry]);

			React.useEffect(() => {
				if (!entry || !hasGit || mode !== "diff" || diff !== null) return;
				const ctrl = new AbortController();
				gitDiff(root, entry.path, ctrl.signal)
					.then((res) => setDiff(res))
					.catch((e) => {
						if (e.name !== "AbortError") setError(e.message);
					});
				return () => ctrl.abort();
			}, [root, entry, hasGit, mode, diff]);

			if (!entry) return h("div", { style: { opacity: 0.5 } }, "选择左侧文件以查看内容。");
			if (loading) return h("div", { style: { opacity: 0.6 } }, "加载中\u2026");
			if (error) return h("div", { style: { color: "var(--dsw-alias-state-error-primary, #f85149)" } }, error);
			if (!file) return null;

			const header = h(
				"div",
				{
					style: {
						display: "flex",
						alignItems: "center",
						gap: "8px",
						marginBottom: "10px",
						color: "var(--dsw-alias-label-primary, inherit)",
					},
				},
				h("strong", { style: { overflow: "hidden", textOverflow: "ellipsis" } }, file.name),
				h("span", { style: { opacity: 0.5, fontSize: "11px" } }, humanSize(file.size)),
				file.truncated
					? h("span", { style: { color: "var(--dsw-alias-state-warning-primary, #d29922)", fontSize: "11px" } }, "（已截断）")
					: null,
				hasGit
					? h(
							"span",
							{ style: { marginLeft: "auto", display: "flex", gap: "4px" } },
							h(
								"button",
								{ className: "wf-btn" + (mode === "text" ? " wf-btnActive" : ""), onClick: () => setMode("text") },
								"内容",
							),
							h(
								"button",
								{ className: "wf-btn" + (mode === "diff" ? " wf-btnActive" : ""), onClick: () => setMode("diff") },
								"改动",
							),
						)
					: null,
			);

			let bodyNode;
			if (file.binary) {
				bodyNode = h("div", { style: { opacity: 0.6 } }, "二进制文件，不显示内容。");
			} else if (mode === "diff" && hasGit) {
				bodyNode = diff === null ? h("div", { style: { opacity: 0.6 } }, "加载差异\u2026") : h(DiffView, { diff });
			} else {
				bodyNode = h(
					"pre",
					{ style: { margin: 0, fontFamily: "var(--dsh-mono, ui-monospace, monospace)", fontSize: "12px", whiteSpace: "pre-wrap", wordBreak: "break-word" } },
					file.content,
				);
			}
			return h("div", null, header, bodyNode);
		}

		// ── View (a conversation.view tab, beside chat / trajectory) ─────────────

		/**
		 * The file-browser view tab. Session-scoped: the workspace root is the
		 * current session's cwd, read from the sessions standard hook.
		 * @param {any} props - composed slot props (sessionId + useSessions + …).
		 */
		function FilesView(props) {
			const { sessionId } = props;
			ensureStyle();
			// Resolve this session's workspace root (cwd) from the host by id —
			// the stable, authoritative source (independent of client session-list
			// state, which arrives empty for slot-standard hooks in this surface).
			const [root, setRoot] = React.useState(undefined);
			const [rootResolved, setRootResolved] = React.useState(false);
			const [rootError, setRootError] = React.useState(null);

			React.useEffect(() => {
				const ctrl = new AbortController();
				setRoot(undefined);
				setRootResolved(false);
				setRootError(null);
				sessionRoot(sessionId, ctrl.signal)
					.then((res) => {
						setRoot(res && res.root ? res.root : undefined);
						setRootResolved(true);
					})
					.catch((e) => {
						if (e.name !== "AbortError") {
							setRootError(e.message);
							setRootResolved(true);
						}
					});
				return () => ctrl.abort();
			}, [sessionId]);

			const [tree, setTree] = React.useState(null);
			const [treeError, setTreeError] = React.useState(null);
			const [statusMap, setStatusMap] = React.useState({});
			const [hasGit, setHasGit] = React.useState(false);
			const [selected, setSelected] = React.useState(null);

			// Load the root listing + git status whenever the root changes.
			React.useEffect(() => {
				if (!root) return;
				const ctrl = new AbortController();
				setTree(null);
				setTreeError(null);
				setStatusMap({});
				setHasGit(false);
				setSelected(null);
				listDir(root, undefined, ctrl.signal)
					.then((res) => setTree(res.entries || []))
					.catch((e) => {
						if (e.name !== "AbortError") setTreeError(e.message);
					});
				gitIsRepo(root, ctrl.signal)
					.then((res) => {
						if (!res || !res.isRepo) return;
						setHasGit(true);
						return gitStatus(root, ctrl.signal).then((st) => {
							const map = {};
							(st.files || []).forEach((f) => {
								map[f.path] = f.code;
							});
							setStatusMap(map);
						});
					})
					.catch(() => {
						/* not a repo / git missing — degrade silently to plain browsing */
					});
				return () => ctrl.abort();
			}, [root]);

			if (!root) {
				const message = rootError
					? `无法解析工作区目录：${rootError}`
					: rootResolved
						? "当前会话没有关联工作区目录。"
						: "正在解析工作区目录\u2026";
				return h(
					"div",
					{ style: Object.assign({}, viewStyle, { alignItems: "center", justifyContent: "center", opacity: 0.6 }) },
					message,
				);
			}

			return h(
				"div",
				{ style: viewStyle },
				h(
					"div",
					{ style: headerStyle },
					h("span", { style: { fontWeight: 600, color: "var(--dsw-alias-label-primary, inherit)" } }, "工作区文件"),
					h("span", { style: { opacity: 0.6, fontSize: "11px" } }, baseName(root)),
					hasGit
						? h("span", { style: { fontSize: "11px", color: "var(--dsw-alias-state-success-primary, #3fb950)" } }, "git")
						: null,
				),
				h(
					"div",
					{ style: bodyStyle },
					h(
						"div",
						{ className: "wf-treePane", style: treePaneStyle },
						treeError
							? h("div", { style: { color: "var(--dsw-alias-state-error-primary, #f85149)", padding: "8px" } }, treeError)
							: null,
						tree === null && !treeError ? h("div", { style: { opacity: 0.6, padding: "8px" } }, "加载中\u2026") : null,
						tree
							? tree.map((entry) =>
									h(TreeNode, {
										key: entry.path,
										entry,
										root,
										depth: 0,
										statusMap,
										onOpenFile: setSelected,
										selectedPath: selected ? selected.path : null,
									}),
								)
							: null,
					),
					h("div", { className: "wf-contentPane", style: contentPaneStyle }, h(ContentView, { root, entry: selected, hasGit })),
				),
			);
		}

		// ── apply ──────────────────────────────────────────────────────────────

		/** Required client services (only the slot registry). */
		const inject = ["slots"];

		/**
		 * Register the file-browser as a conversation.view tab, beside chat and
		 * trajectory. The view resolves its workspace root from the host by the
		 * framework-supplied sessionId (no client session-list dependency). The
		 * registration rides the slots effect wrapper, so plugin unload removes
		 * the tab.
		 * @param {any} ctx - client root context.
		 */
		function apply(ctx) {
			ctx.slots.inject("conversation.view", () =>
				ctx.slots.register(
					{ name: "conversation.view", id: "files", order: 20, label: "文件" },
					FilesView,
				),
			);
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
