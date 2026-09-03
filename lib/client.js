window.__ModuleLoader__.load({
	id: "dsh-workspace-files",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		const React = require("react");
		const h = React.createElement;

		// ── syntax highlight (reuse the host's shiki-backed CodeBlock) ───────────
		// The web shell seeds "@deepseek-ai/dsh-client-ui-primitives" into the
		// frozen module table (see dsh-client-web getStaticModules), so any
		// browser bundle — this plugin included — can require it. The bundled
		// namespace exposes COMPONENTS (CodeBlock/ReadBlock/…), not the internal
		// highlightLines function, so we reuse the component: CodeBlock({code,lang})
		// renders shiki-highlighted, css-variables-themed, line-preserving text
		// with its own copy button. Everything is optional and defended: a host
		// without CodeBlock (or an unknown/large file) falls back to plain <pre>.
		let hl = null;
		try {
			hl = require("@deepseek-ai/dsh-client-ui-primitives");
		} catch {
			/* primitives not seeded on this host — plain text only */
		}
		const HostCodeBlock = hl && typeof hl.CodeBlock === "function" ? hl.CodeBlock : null;

		/** Highlight is only attempted up to this many lines; larger files stay plain. */
		const MAX_HIGHLIGHT_LINES = 5000;

		/**
		 * Map a file name to a shiki language id the host highlighter understands.
		 * Extension-driven, mirroring the read tool's `langFromPath` intent. An
		 * unmapped extension returns undefined, so the highlighter falls back to
		 * plain text (never an error).
		 * @param {string} name - file base name.
		 * @returns {string | undefined}
		 */
		function langFromName(name) {
			const lower = String(name || "").toLowerCase();
			const dot = lower.lastIndexOf(".");
			const ext = dot >= 0 ? lower.slice(dot + 1) : "";
			// Only ids the host highlighter's alias table actually resolves are
			// returned; anything else stays undefined → plain-text fallback. The
			// JS family maps to the TypeScript grammar (host approximation).
			switch (ext) {
				case "ts":
				case "mts":
				case "cts":
					return "typescript";
				case "tsx":
					return "tsx";
				case "js":
				case "mjs":
				case "cjs":
					return "javascript";
				case "jsx":
					return "jsx";
				case "json":
				case "jsonc":
					return "json";
				case "py":
				case "pyi":
					return "python";
				case "rs":
					return "rust";
				case "go":
					return "go";
				case "java":
					return "java";
				case "c":
				case "h":
					return "c";
				case "cc":
				case "cpp":
				case "cxx":
				case "hpp":
				case "hh":
					return "cpp";
				case "cs":
					return "csharp";
				case "rb":
					return "ruby";
				case "php":
					return "php";
				case "swift":
					return "swift";
				case "kt":
				case "kts":
					return "kotlin";
				case "sh":
				case "bash":
				case "zsh":
					return "shell";
				case "yml":
				case "yaml":
					return "yaml";
				case "toml":
					return "toml";
				case "ini":
				case "cfg":
				case "conf":
					return "ini";
				case "xml":
					return "xml";
				case "html":
				case "htm":
					return "html";
				case "css":
					return "css";
				case "scss":
					return "scss";
				case "less":
					return "less";
				case "md":
				case "markdown":
					return "markdown";
				case "mdx":
					return "mdx";
				case "sql":
					return "sql";
				case "lua":
					return "lua";
				default:
					return undefined;
			}
		}

		// ── lightweight tokenizer for diff-line syntax coloring ──────────────────
		// The host CodeBlock highlights whole files, but a unified diff renders
		// line-by-line with per-line add/del backgrounds, so we tint each line's
		// text with a small zero-dependency regex tokenizer instead. Colors reuse
		// shiki's own `--shiki-token-*` css variables (theme-aware, consistent
		// with the file view) with hard fallbacks. Coverage is best-effort for
		// the common C-like / script families; anything unmatched stays default.

		/** Token category → themed color (shiki css var with fallback). */
		const TOKEN_COLOR = {
			comment: "var(--shiki-token-comment, #6a737d)",
			string: "var(--shiki-token-string, #032f62)",
			number: "var(--shiki-token-constant, #005cc5)",
			keyword: "var(--shiki-token-keyword, #d73a49)",
			constant: "var(--shiki-token-constant, #005cc5)",
			function: "var(--shiki-token-function, #6f42c1)",
		};

		/** Keywords shared across the C-like / script families (best-effort). */
		const COMMON_KEYWORDS = new Set([
			"const","let","var","function","return","if","else","for","while","do","switch","case","break",
			"continue","new","delete","typeof","instanceof","in","of","class","extends","super","this","import",
			"from","export","default","async","await","yield","try","catch","finally","throw","void","null",
			"undefined","true","false","def","elif","lambda","pass","raise","with","as","not","and","or","is",
			"None","True","False","fn","pub","use","mut","impl","struct","enum","trait","match","where","type",
			"interface","public","private","protected","static","final","abstract","package","func","go","defer",
			"select","map","range","nil","end","then","elseif","local","require","module","namespace","using",
		]);

		/**
		 * Tokenize one line of source into colored runs. Order matters: comments
		 * and strings win first, then numbers, then identifiers (keyword lookup).
		 * Returns an array of { text, color } where color is undefined for plain
		 * runs (so the caller's line color shows through).
		 * @param {string} text - the raw line (no diff prefix).
		 * @param {string | undefined} lang - a shiki-ish language id (see langFromName).
		 * @returns {{text:string,color?:string}[]}
		 */
		function tokenizeLine(text, lang) {
			if (!lang || text === "") return [{ text }];
			const hash = lang === "python" || lang === "shell" || lang === "yaml" || lang === "toml" || lang === "ini" || lang === "ruby";
			const out = [];
			let i = 0;
			const n = text.length;
			const pushPlain = (s) => {
				if (s) out.push({ text: s });
			};
			let plainStart = 0;
			const flush = (end) => pushPlain(text.slice(plainStart, end));
			while (i < n) {
				const c = text[i];
				const two = text.slice(i, i + 2);
				// line comments: // (C-like), # (script), -- (sql/lua)
				if (two === "//" || (hash && c === "#") || (two === "--" && (lang === "sql" || lang === "lua"))) {
					flush(i);
					out.push({ text: text.slice(i), color: TOKEN_COLOR.comment });
					plainStart = n;
					i = n;
					break;
				}
				// strings: ' " `
				if (c === '"' || c === "'" || c === "`") {
					flush(i);
					const quote = c;
					let j = i + 1;
					while (j < n && text[j] !== quote) {
						if (text[j] === "\\") j++;
						j++;
					}
					j = Math.min(j + 1, n);
					out.push({ text: text.slice(i, j), color: TOKEN_COLOR.string });
					i = j;
					plainStart = i;
					continue;
				}
				// numbers
				if (c >= "0" && c <= "9") {
					flush(i);
					let j = i;
					while (j < n && /[0-9a-fA-FxX._]/.test(text[j])) j++;
					out.push({ text: text.slice(i, j), color: TOKEN_COLOR.number });
					i = j;
					plainStart = i;
					continue;
				}
				// identifiers → keyword lookup
				if (/[A-Za-z_$]/.test(c)) {
					flush(i);
					let j = i;
					while (j < n && /[A-Za-z0-9_$]/.test(text[j])) j++;
					const word = text.slice(i, j);
					const color = COMMON_KEYWORDS.has(word) ? TOKEN_COLOR.keyword : undefined;
					out.push(color ? { text: word, color } : { text: word });
					i = j;
					plainStart = i;
					continue;
				}
				i++;
			}
			flush(n);
			return out.length ? out : [{ text }];
		}

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

		/** POST a JSON body to a git write route; throws Error(message) on non-ok. */
		async function postGit(action, root, payload, signal, extraParams) {
			const params = new URLSearchParams({ root });
			if (extraParams) for (const k of extraParams.keys()) params.set(k, extraParams.get(k));
			const res = await fetch(`${GIT_PREFIX}/${action}?${params.toString()}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(payload || {}),
				signal,
			});
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

		/** List local branches and the current one. */
		function gitBranches(root, signal) {
			return getJson(`${GIT_PREFIX}/branches?${new URLSearchParams({ root }).toString()}`, signal);
		}
		/** Checkout a branch. */
		function gitCheckout(root, branch, signal) {
			return postGit("checkout", root, { branch }, signal);
		}
		/** Stage paths (empty = stage all). */
		function gitStage(root, paths, signal) {
			return postGit("stage", root, { paths: paths || [] }, signal);
		}
		/** Unstage paths (empty = unstage all). */
		function gitUnstage(root, paths, signal) {
			return postGit("unstage", root, { paths: paths || [] }, signal);
		}
		/** Discard working-tree changes for paths (empty = discard all). Destructive. */
		function gitDiscard(root, paths, signal) {
			return postGit("discard", root, { paths: paths || [] }, signal);
		}
		/** Commit staged changes with a message. */
		function gitCommit(root, message, signal) {
			return postGit("commit", root, { message }, signal);
		}
		/** Pull from upstream. */
		function gitPull(root, signal) {
			return postGit("pull", root, {}, signal);
		}
		/** Push to upstream. */
		function gitPush(root, signal) {
			return postGit("push", root, {}, signal);
		}
		/** AI-generate a commit message from the current diff (uses the session's model). */
		function gitCommitMessage(root, sessionId, signal) {
			const params = new URLSearchParams({ root, sessionId });
			return postGit("commit-message", root, {}, signal, params);
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
				// Hide the host CodeBlock's top banner (its language/infostring label
				// and the floating copy button) inside our file view. The banner is
				// CodeBlock's first child div; we target it structurally because its
				// CSS-module class names are hashed. Keep only the code body.
				".wf-code > div:first-child { display: none !important; }",
				// ── Source Control (VS Code-style) ──────────────────────────────
				// Per-row hover actions: hidden until the row (or section head) is hovered.
				".wf-actions { display: flex; align-items: center; gap: 1px; opacity: 0; transition: opacity .1s ease; flex: 0 0 auto; }",
				".wf-row:hover .wf-actions, .wf-sectionHead:hover .wf-actions { opacity: 1; }",
				// Small square ghost icon button (stage / unstage / discard / refresh …).
				".wf-iconbtn {",
				"  display: inline-flex; align-items: center; justify-content: center;",
				"  width: 22px; height: 22px; padding: 0; border: 0; border-radius: 5px;",
				"  background: transparent; color: var(--dsw-alias-label-secondary, inherit);",
				"  cursor: pointer; font: inherit; font-size: 13px; line-height: 1; flex: 0 0 auto;",
				"}",
				".wf-iconbtn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(140,140,140,.16)); color: var(--dsw-alias-label-primary, inherit); }",
				".wf-iconbtn:disabled { opacity: .4; cursor: default; background: transparent; }",
				".wf-iconbtn.wf-danger:hover { color: var(--dsw-alias-state-error-primary, #f85149); }",
				// Primary (accent) button — the prominent Commit action.
				".wf-primary {",
				"  display: inline-flex; align-items: center; justify-content: center; gap: 6px;",
				"  width: 100%; border: 0; border-radius: 5px; padding: 6px 10px; cursor: pointer;",
				"  font: inherit; font-size: 12px; font-weight: 600;",
				"  background: var(--dsw-alias-state-business-primary, #3b82f6); color: #fff;",
				"}",
				".wf-primary:hover { filter: brightness(1.08); }",
				".wf-primary:disabled { opacity: .45; cursor: default; filter: none; }",
				// Section header (Staged Changes / Changes).
				".wf-sectionHead {",
				"  display: flex; align-items: center; gap: 4px; padding: 3px 8px; cursor: pointer;",
				"  user-select: none; text-transform: uppercase; letter-spacing: .04em;",
				"  font-size: 11px; font-weight: 700; color: var(--dsw-alias-label-tertiary, inherit);",
				"}",
				".wf-sectionHead:hover { color: var(--dsw-alias-label-secondary, inherit); }",
				".wf-count {",
				"  min-width: 16px; height: 16px; padding: 0 5px; border-radius: 8px;",
				"  display: inline-flex; align-items: center; justify-content: center;",
				"  font-size: 10px; font-weight: 700; box-sizing: border-box;",
				"  background: var(--dsw-alias-interactive-bg-hover, rgba(140,140,140,.2));",
				"  color: var(--dsw-alias-label-secondary, inherit);",
				"}",
				// Git badge on the header toggle (activity-bar style change count).
				".wf-badge {",
				"  min-width: 15px; height: 15px; padding: 0 4px; border-radius: 8px; margin-left: 4px;",
				"  display: inline-flex; align-items: center; justify-content: center; box-sizing: border-box;",
				"  font-size: 10px; font-weight: 700; line-height: 1;",
				"  background: var(--dsw-alias-state-business-primary, #3b82f6); color: #fff;",
				"}",
				// Discard confirmation overlay (rendered inside the Git panel).
				".wf-overlay {",
				"  position: absolute; inset: 0; z-index: 10; display: flex;",
				"  align-items: center; justify-content: center; padding: 16px;",
				"  background: rgba(0,0,0,.35);",
				"}",
				".wf-dialog {",
				"  width: 100%; max-width: 260px; border-radius: 8px; padding: 14px; box-sizing: border-box;",
				"  background: var(--dsw-alias-bg-layer-1, #1e1e1e);",
				"  border: 1px solid var(--dsw-alias-border-l2, rgba(140,140,140,.3));",
				"  box-shadow: 0 8px 30px rgba(0,0,0,.35);",
				"}",
				".wf-dialogBtns { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }",
				".wf-dialogBtn { border: 0; border-radius: 5px; padding: 5px 12px; cursor: pointer; font: inherit; font-size: 12px; }",
				".wf-dialogBtn.cancel { background: var(--dsw-alias-interactive-bg-hover, rgba(140,140,140,.16)); color: var(--dsw-alias-label-primary, inherit); }",
				".wf-dialogBtn.danger { background: var(--dsw-alias-state-error-primary, #f85149); color: #fff; }",
				".wf-dialogBtn:hover { filter: brightness(1.08); }",
				// Diff line-number gutter (sticky-left so numbers stay while scrolling).
				".wf-gutter {",
				"  position: sticky; left: 0; z-index: 1; flex: 0 0 auto; user-select: none;",
				"  display: inline-flex; text-align: right; color: var(--dsw-alias-label-tertiary, #8b949e);",
				"  background: var(--dsw-alias-bg-layer-1, #1e1e1e);",
				"  border-right: 1px solid var(--dsw-alias-border-l2, rgba(140,140,140,.18));",
				"}",
				".wf-gutter > span { display: inline-block; padding: 0 6px; opacity: .8; }",
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

		/**
		 * Parse a unified-diff hunk header for its starting line numbers.
		 * `@@ -oldStart,oldCount +newStart,newCount @@` — the counts are optional
		 * (git omits `,1`). Returns null on a non-standard header so numbering
		 * degrades gracefully to blank gutter cells.
		 * @param {string} header
		 * @returns {{oldNo:number,newNo:number} | null}
		 */
		function parseHunkHeader(header) {
			const m = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(header || "");
			if (!m) return null;
			return { oldNo: parseInt(m[1], 10), newNo: parseInt(m[2], 10) };
		}

		/** Render a unified diff from structured hunks, with a VS Code-style
		 * two-column (old | new) line-number gutter. */
		function DiffView(props) {
			const { diff } = props;
			if (!diff || !diff.hunks || diff.hunks.length === 0) {
				return h("div", { style: { opacity: 0.6 } }, "无差异（工作区与 HEAD 一致）");
			}
			// Language for syntax coloring, derived from the file the diff is for.
			const lang = langFromName(baseName(diff.path || diff.rel || ""));

			// First pass: find the widest line number to size the gutter columns so
			// old and new numbers line up across every hunk.
			let maxNo = 0;
			diff.hunks.forEach((hunk) => {
				const p = parseHunkHeader(hunk.header);
				if (!p) return;
				let o = p.oldNo;
				let n = p.newNo;
				hunk.lines.forEach((ln) => {
					if (ln.type === "add") maxNo = Math.max(maxNo, n++);
					else if (ln.type === "del") maxNo = Math.max(maxNo, o++);
					else {
						maxNo = Math.max(maxNo, o++, n++);
					}
				});
			});
			const numWidth = `${String(maxNo || 1).length + 1}ch`;
			const cell = (value) => h("span", { style: { width: numWidth } }, value == null ? "" : String(value));

			const lines = [];
			diff.hunks.forEach((hunk, hi) => {
				// Hunk header row: blank gutter cells keep the header aligned with the
				// code below; the gutter here inherits the header's layer-2 tint.
				lines.push(
					h(
						"div",
						{ key: `h${hi}`, style: { display: "flex", background: "var(--dsw-alias-bg-layer-2, rgba(140,140,140,.08))", minWidth: "max-content" } },
						h("span", { className: "wf-gutter", style: { background: "var(--dsw-alias-bg-layer-2, rgba(140,140,140,.08))" } }, cell(""), cell("")),
						h("span", { style: { color: "var(--dsw-alias-state-business-primary, #58a6ff)", padding: "2px 8px", whiteSpace: "pre" } }, hunk.header),
					),
				);
				const p = parseHunkHeader(hunk.header);
				let o = p ? p.oldNo : null;
				let n = p ? p.newNo : null;
				hunk.lines.forEach((ln, li) => {
					// Line background + prefix color carry the add/del semantics; the
					// line's own text keeps its natural color so the syntax tokens stand
					// out rather than being flooded green or red. Context is fully default.
					let prefixColor = "inherit";
					let bg = "transparent";
					let oldNo = null;
					let newNo = null;
					if (ln.type === "add") {
						prefixColor = "var(--dsw-alias-state-success-primary, #3fb950)";
						bg = "var(--dsw-alias-state-success-bg, rgba(63,185,80,.12))";
						if (n != null) newNo = n++;
					} else if (ln.type === "del") {
						prefixColor = "var(--dsw-alias-state-error-primary, #f85149)";
						bg = "var(--dsw-alias-state-error-bg, rgba(248,81,73,.12))";
						if (o != null) oldNo = o++;
					} else {
						if (o != null) oldNo = o++;
						if (n != null) newNo = n++;
					}
					const prefix = ln.type === "add" ? "+" : ln.type === "del" ? "-" : " ";
					// Tokenize the text (prefix excluded) into colored runs.
					const runs = tokenizeLine(ln.text, lang).map((tk, ti) =>
						h("span", { key: ti, style: tk.color ? { color: tk.color } : undefined }, tk.text),
					);
					lines.push(
						h(
							"div",
							// min-width:max-content: the row grows to its content so the
							// add/del background paints the full scrolled width.
							{ key: `h${hi}l${li}`, style: { display: "flex", background: bg, minWidth: "max-content" } },
							h("span", { className: "wf-gutter" }, cell(oldNo), cell(newNo)),
							h(
								"span",
								{ style: { padding: "0 8px", whiteSpace: "pre" } },
								h("span", { style: { color: prefixColor } }, prefix),
								runs,
							),
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

		/** Plain monospace body — the fallback when the host CodeBlock is absent. */
		const codeBaseStyle = {
			margin: 0,
			fontFamily: "var(--dsh-mono, ui-monospace, monospace)",
			fontSize: "12px",
			whiteSpace: "pre-wrap",
			wordBreak: "break-word",
		};

		/**
		 * File text body. Renders through the host's shiki-backed `CodeBlock`
		 * (syntax highlight + css-variables theme + copy button) when it is
		 * available, the language is known, and the file is not too large;
		 * otherwise renders the exact same plain <pre> as before. `CodeBlock`
		 * itself falls back to plain monospace for an unknown/not-yet-loaded
		 * language, so an unmapped file still renders — just without color.
		 */
		function CodeView(props) {
			const { name, content } = props;
			const text = content == null ? "" : String(content);

			const lang = HostCodeBlock ? langFromName(name) : undefined;
			const tooBig = text.split("\n").length > MAX_HIGHLIGHT_LINES;

			if (HostCodeBlock && !tooBig) {
				try {
					// className "wf-code" lets our stylesheet hide CodeBlock's top
					// banner (language label + floating copy button); see ensureStyle.
					return h(HostCodeBlock, { code: text, lang, className: "wf-code", copyLabel: "复制", copiedLabel: "已复制" });
				} catch {
					/* component threw — fall through to plain text */
				}
			}
			return h("pre", { style: codeBaseStyle }, text);
		}

		/** File content viewer with a text/diff toggle when a diff is available. */
		function ContentView(props) {
			const { root, entry, hasGit, refreshToken } = props;
			// `entry.mode` lets an opener request a starting view: the Source Control
			// panel opens files straight into "diff"; the tree opens them as "text".
			const [mode, setMode] = React.useState((entry && entry.mode) || "text");
			const [file, setFile] = React.useState(null);
			const [diff, setDiff] = React.useState(null);
			const [loading, setLoading] = React.useState(false);
			const [error, setError] = React.useState(null);

			// Reset the view to the opener's requested mode when a new file is picked
			// (entry identity change) — but not on a mere background refresh, so a
			// manual content/diff toggle survives a status refresh.
			React.useEffect(() => {
				setMode((entry && entry.mode) || "text");
			}, [entry]);

			// Re-read the file whenever the selection changes OR a mutation bumps
			// refreshToken (stage/unstage/discard/commit), so open content stays
			// current. Clearing diff to null makes the diff effect below refetch too.
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
			}, [root, entry, refreshToken]);

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
						// Pin the file name + content/diff toggle to the top of the
						// scrolling content pane like a nav bar; the body scrolls
						// beneath. Negative horizontal margins + matching padding
						// let the bar's background span the pane's full width
						// (the pane has 10px/14px padding), and a bottom border
						// separates it from the scrolling body. A high z-index and
						// opaque background keep code from showing through.
						position: "sticky",
						// The pane has 10px top padding; sticky offsets from the
						// padding box, so -10px pins the bar flush to the pane's
						// visible top edge (its negative top margin already lifts it
						// into that padding band).
						top: "-10px",
						zIndex: 2,
						margin: "-10px -14px 10px",
						padding: "10px 14px",
						background: "var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-layer-2, #1e1e1e))",
						borderBottom: "1px solid var(--dsw-alias-border-l2, rgba(140,140,140,.18))",
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
				bodyNode = h(CodeView, { name: file.name, content: file.content });
			}
			return h("div", null, header, bodyNode);
		}

		// ── View (a conversation.view tab, beside chat / trajectory) ─────────────

		/** Directory portion of a repo-relative path (POSIX-style); "" at repo root. */
		function dirOf(rel) {
			const norm = String(rel || "").replace(/\\/g, "/");
			const i = norm.lastIndexOf("/");
			return i >= 0 ? norm.slice(0, i) : "";
		}

		/**
		 * A collapsible Source Control section header (Staged Changes / Changes)
		 * with a count badge and hover-revealed section actions.
		 * @param {{label:string,count:number,collapsed:boolean,onToggle:Function,actions?:any[]}} props
		 */
		function SectionHeader(props) {
			const { label, count, collapsed, onToggle, actions } = props;
			return h(
				"div",
				{ className: "wf-sectionHead", onClick: onToggle },
				h("span", { style: { width: "10px", opacity: 0.8, fontSize: "10px" } }, collapsed ? "▸" : "▾"),
				h("span", { style: { flex: "1 1 auto", overflow: "hidden", textOverflow: "ellipsis" } }, label),
				actions && actions.length ? h("span", { className: "wf-actions" }, actions) : null,
				h("span", { className: "wf-count" }, String(count)),
			);
		}

		/**
		 * One changed-file row: a file name (bold) with its dimmed directory, the
		 * status letter, and hover-revealed inline actions (stage/unstage, discard),
		 * mirroring VS Code. Clicking the row opens the file's diff.
		 * @param {{file:any,section:'staged'|'changes',letter:string,busy:any,onOpen:Function,onStage?:Function,onUnstage?:Function,onDiscard?:Function}} props
		 */
		function GitFileRow(props) {
			const { file, section, letter, busy, onOpen, onStage, onUnstage, onDiscard } = props;
			const dir = dirOf(file.rel);
			const name = baseName(file.rel);
			const color = statusColor(letter === "U" ? "?" : letter);
			const stop = (fn) => (e) => {
				e.stopPropagation();
				fn();
			};
			const actions =
				section === "staged"
					? [h("button", { key: "u", className: "wf-iconbtn", title: "取消暂存", disabled: !!busy, onClick: stop(onUnstage) }, "−")]
					: [
							h("button", { key: "d", className: "wf-iconbtn wf-danger", title: "放弃更改", disabled: !!busy, onClick: stop(onDiscard) }, "↩"),
							h("button", { key: "s", className: "wf-iconbtn", title: "暂存更改", disabled: !!busy, onClick: stop(onStage) }, "+"),
						];
			return h(
				"div",
				{
					className: "wf-row",
					style: { display: "flex", alignItems: "center", gap: "6px", padding: "3px 8px 3px 20px", cursor: "pointer" },
					title: file.path,
					onClick: onOpen,
				},
				h(
					"span",
					{ style: { flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
					h("span", { style: { color: "var(--dsw-alias-label-primary, inherit)" } }, name),
					dir ? h("span", { style: { color: "var(--dsw-alias-label-tertiary, #8b949e)", fontSize: "11px", marginLeft: "6px" } }, dir) : null,
				),
				h("span", { className: "wf-actions" }, actions),
				h("span", { style: { color, fontWeight: 600, fontSize: "11px", flex: "0 0 auto", width: "14px", textAlign: "center" } }, letter),
			);
		}

		/**
		 * The VS Code-style Source Control panel. A toolbar (branch selector +
		 * refresh / pull / push), a commit-message box with an AI-generate button and
		 * a prominent Commit action, then the changed files split into "Staged
		 * Changes" and "Changes" sections with per-file and per-section actions
		 * (stage / unstage / discard). Operations fire-and-refresh: each action
		 * re-fetches status (and branches after a checkout) so the panel stays in
		 * sync. Failures surface inline under the commit box.
		 */
		function GitPanel(props) {
			const { root, sessionId, status, onRefreshStatus, onOpenFile } = props;
			const [branches, setBranches] = React.useState({ current: null, branches: [] });
			const [message, setMessage] = React.useState("");
			const [busy, setBusy] = React.useState(null); // 'commit'|'pull'|'push'|'checkout'|'stage'|'discard'|'ai'|'refresh'
			const [err, setErr] = React.useState(null);
			const [confirm, setConfirm] = React.useState(null); // { kind:'file'|'all', file? }
			const [collapsed, setCollapsed] = React.useState({ staged: false, changes: false });

			// Load branches once and after a checkout/refresh.
			const refreshBranches = React.useCallback((signal) => {
				gitBranches(root, signal)
					.then((res) => setBranches(res || { current: null, branches: [] }))
					.catch(() => {});
			}, [root]);
			React.useEffect(() => {
				const ctrl = new AbortController();
				refreshBranches(ctrl.signal);
				return () => ctrl.abort();
			}, [refreshBranches]);

			// Split the status into Staged / Changes using the raw porcelain columns
			// (f.x = index, f.y = working tree) so a file can appear in both, exactly
			// like VS Code. Older host responses without x/y fall back to f.staged.
			const rawFiles = (status.files || []).slice().sort((a, b) => a.rel.localeCompare(b.rel));
			const hasXY = rawFiles.some((f) => typeof f.x === "string");
			const isStagedFile = (f) => (hasXY ? f.x != null && f.x !== " " && f.x !== "?" : !!f.staged);
			const inChangesFile = (f) => (hasXY ? (f.y != null && f.y !== " ") || (f.x === "?" && f.y === "?") : !f.staged);
			const stagedFiles = rawFiles.filter(isStagedFile);
			const changesFiles = rawFiles.filter(inChangesFile);
			const stagedLetter = (f) => (hasXY ? (f.x === "?" ? "A" : f.x) : f.code);
			const changesLetter = (f) => (hasXY ? (f.y === "?" ? "U" : f.y) : f.code === "?" ? "U" : f.code);

			const run = async (kind, fn) => {
				setBusy(kind);
				setErr(null);
				try {
					const res = await fn();
					if (kind === "checkout" || kind === "refresh") refreshBranches(new AbortController().signal);
					await onRefreshStatus();
					// Git non-zero exits come back as { ok:false, stderr } (HTTP 200),
					// so surface those too, not just thrown transport errors.
					if (res && res.ok === false) setErr(res.stderr || kind + " 失败");
					return res;
				} catch (e) {
					setErr((e && e.message) || String(e));
					console.error("[workspace-files] " + kind + " failed:", e && e.message);
				} finally {
					setBusy(null);
				}
			};

			const openFile = (f) => onOpenFile && onOpenFile({ path: f.path, name: baseName(f.rel), mode: "diff" });

			const onCommit = () => {
				if (!message.trim() || rawFiles.length === 0) return;
				run("commit", async () => {
					// Smart commit: with nothing staged, stage everything first (VS Code default).
					if (stagedFiles.length === 0) await gitStage(root, []);
					return gitCommit(root, message);
				}).then((res) => {
					if (res && res.ok) setMessage("");
				});
			};
			const onPull = () => run("pull", () => gitPull(root));
			const onPush = () => run("push", () => gitPush(root));
			const onRefresh = () =>
				run("refresh", async () => {
					refreshBranches(new AbortController().signal);
					return {};
				});
			const onGenerateMessage = () => {
				run("ai", () => gitCommitMessage(root, sessionId)).then((res) => {
					if (res && res.message) setMessage(res.message);
				});
			};
			const onCheckout = (e) => {
				const branch = e.target.value;
				if (branch && branch !== branches.current) run("checkout", () => gitCheckout(root, branch));
			};

			// Discard is destructive → route through a confirmation dialog first.
			const askDiscard = (target) => setConfirm(target);
			const doDiscard = () => {
				const target = confirm;
				setConfirm(null);
				if (!target) return;
				const paths = target.kind === "file" ? [target.file.path] : changesFiles.map((f) => f.path);
				run("discard", () => gitDiscard(root, paths));
			};

			const iconBtn = (kind, glyph, label, onClick) =>
				h(
					"button",
					{ className: "wf-iconbtn", title: label, disabled: !!busy, onClick },
					busy === kind ? "…" : glyph,
				);

			// Toolbar: branch selector + refresh / pull / push.
			const toolbar = h(
				"div",
				{ style: { display: "flex", alignItems: "center", gap: "4px", padding: "6px 8px", borderBottom: "1px solid var(--dsw-alias-border-l2, rgba(140,140,140,.18))", flex: "0 0 auto" } },
				h("span", { style: { flex: "0 0 auto", opacity: 0.7 } }, "⎇"),
				h(
					"select",
					{
						value: branches.current || "",
						onChange: onCheckout,
						disabled: !!busy,
						title: "切换分支",
						style: {
							flex: "1 1 auto",
							minWidth: 0,
							font: "inherit",
							fontSize: "12px",
							background: "var(--dsw-alias-bg-layer-2, transparent)",
							color: "var(--dsw-alias-label-primary, inherit)",
							border: "1px solid var(--dsw-alias-border-l2, rgba(140,140,140,.18))",
							borderRadius: 4,
							padding: "2px 4px",
						},
					},
					(branches.branches || []).map((b) => h("option", { key: b, value: b }, b + (b === branches.current ? "  ✓" : ""))),
				),
				iconBtn("refresh", "↻", "刷新", onRefresh),
				iconBtn("pull", "↓", "拉取 (pull)", onPull),
				iconBtn("push", "↑", "推送 (push)", onPush),
			);

			// Commit message box + prominent Commit button + inline error.
			const smart = stagedFiles.length === 0 && rawFiles.length > 0;
			const commitBox = h(
				"div",
				{ style: { padding: "8px", borderBottom: "1px solid var(--dsw-alias-border-l2, rgba(140,140,140,.18))", flex: "0 0 auto", display: "flex", flexDirection: "column", gap: "6px" } },
				h(
					"div",
					{ style: { position: "relative" } },
					h("textarea", {
						placeholder: "提交信息（Ctrl+Enter 提交）",
						value: message,
						onChange: (e) => setMessage(e.target.value),
						onKeyDown: (e) => {
							if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
								e.preventDefault();
								onCommit();
							}
						},
						rows: 2,
						style: {
							width: "100%",
							boxSizing: "border-box",
							resize: "vertical",
							font: "inherit",
							fontSize: "12px",
							background: "var(--dsw-alias-bg-layer-2, transparent)",
							color: "var(--dsw-alias-label-primary, inherit)",
							border: "1px solid var(--dsw-alias-border-l2, rgba(140,140,140,.18))",
							borderRadius: 4,
							padding: "4px 6px",
							paddingRight: "30px",
						},
					}),
					h(
						"button",
						{
							className: "wf-iconbtn",
							style: { position: "absolute", right: "4px", bottom: "4px" },
							onClick: onGenerateMessage,
							disabled: !!busy,
							title: "用当前会话模型根据 diff 生成提交信息",
						},
						busy === "ai" ? "…" : "✨",
					),
				),
				h(
					"button",
					{
						className: "wf-primary",
						onClick: onCommit,
						disabled: !!busy || rawFiles.length === 0 || !message.trim(),
						title: smart ? "没有已暂存更改，将提交全部更改" : "提交已暂存的更改",
					},
					busy === "commit" ? "提交中…" : smart ? "✓ 提交全部" : "✓ 提交",
				),
				err ? h("div", { style: { color: "var(--dsw-alias-state-error-primary, #f85149)", fontSize: "11px", whiteSpace: "pre-wrap", wordBreak: "break-word" } }, err) : null,
			);

			// Sections: Staged Changes / Changes.
			const listChildren = [];
			if (stagedFiles.length) {
				listChildren.push(
					h(SectionHeader, {
						key: "sh-staged",
						label: "暂存的更改",
						count: stagedFiles.length,
						collapsed: collapsed.staged,
						onToggle: () => setCollapsed((c) => ({ ...c, staged: !c.staged })),
						actions: [h("button", { key: "ua", className: "wf-iconbtn", title: "取消暂存全部", disabled: !!busy, onClick: (e) => { e.stopPropagation(); run("stage", () => gitUnstage(root, [])); } }, "−")],
					}),
				);
				if (!collapsed.staged)
					stagedFiles.forEach((f) =>
						listChildren.push(
							h(GitFileRow, {
								key: "st-" + f.path,
								file: f,
								section: "staged",
								letter: stagedLetter(f),
								busy,
								onOpen: () => openFile(f),
								onUnstage: () => run("stage", () => gitUnstage(root, [f.path])),
							}),
						),
					);
			}
			if (changesFiles.length) {
				listChildren.push(
					h(SectionHeader, {
						key: "sh-changes",
						label: "更改",
						count: changesFiles.length,
						collapsed: collapsed.changes,
						onToggle: () => setCollapsed((c) => ({ ...c, changes: !c.changes })),
						actions: [
							h("button", { key: "da", className: "wf-iconbtn wf-danger", title: "放弃全部更改", disabled: !!busy, onClick: (e) => { e.stopPropagation(); askDiscard({ kind: "all" }); } }, "↩"),
							h("button", { key: "sa", className: "wf-iconbtn", title: "暂存全部更改", disabled: !!busy, onClick: (e) => { e.stopPropagation(); run("stage", () => gitStage(root, [])); } }, "+"),
						],
					}),
				);
				if (!collapsed.changes)
					changesFiles.forEach((f) =>
						listChildren.push(
							h(GitFileRow, {
								key: "ch-" + f.path,
								file: f,
								section: "changes",
								letter: changesLetter(f),
								busy,
								onOpen: () => openFile(f),
								onStage: () => run("stage", () => gitStage(root, [f.path])),
								onDiscard: () => askDiscard({ kind: "file", file: f }),
							}),
						),
					);
			}

			const list = h(
				"div",
				{ style: { flex: "1 1 0", minHeight: 0, overflowY: "auto", padding: "4px 0" } },
				rawFiles.length === 0 ? h("div", { style: { opacity: 0.5, padding: "12px 8px", fontSize: "12px" } }, "无改动（工作区干净）") : listChildren,
			);

			// Discard confirmation overlay (inside the panel, not window.confirm).
			const overlay = confirm
				? h(
						"div",
						{ className: "wf-overlay", onClick: () => setConfirm(null) },
						h(
							"div",
							{ className: "wf-dialog", onClick: (e) => e.stopPropagation() },
							h(
								"div",
								{ style: { fontSize: "13px", lineHeight: 1.5, color: "var(--dsw-alias-label-primary, inherit)" } },
								confirm.kind === "file" ? `放弃 “${baseName(confirm.file.rel)}” 的更改？` : `放弃全部 ${changesFiles.length} 项更改？`,
							),
							h("div", { style: { fontSize: "12px", opacity: 0.7, marginTop: "6px" } }, "此操作不可撤销，未跟踪文件将被删除。"),
							h(
								"div",
								{ className: "wf-dialogBtns" },
								h("button", { className: "wf-dialogBtn cancel", onClick: () => setConfirm(null) }, "取消"),
								h("button", { className: "wf-dialogBtn danger", onClick: doDiscard }, "放弃更改"),
							),
						),
					)
				: null;

			return h(
				"div",
				{ style: { position: "relative", display: "flex", flexDirection: "column", height: "100%", minHeight: 0, fontSize: "13px" } },
				toolbar,
				commitBox,
				list,
				overlay,
			);
		}

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
			const [gitStatusData, setGitStatusData] = React.useState({ isRepo: false, files: [] });
			const [hasGit, setHasGit] = React.useState(false);
			const [selected, setSelected] = React.useState(null);
			const [gitMode, setGitMode] = React.useState(false);
			// Bumped on every successful status refresh so the open file re-reads its
			// content/diff after a stage/unstage/discard/commit mutation.
			const [diffToken, setDiffToken] = React.useState(0);

			// (Re)fetch git status and update both the badge map and the full
			// payload the Git panel renders from. Abortable so rapid toggles
			// don't race.
			const refreshStatus = React.useCallback((signal) => {
				return gitStatus(root, signal)
					.then((st) => {
						const map = {};
						(st.files || []).forEach((f) => {
							map[f.path] = f.code;
						});
						setStatusMap(map);
						setGitStatusData(st);
						setDiffToken((n) => n + 1);
					})
					.catch(() => {});
			}, [root]);

			// Load the root listing + git status whenever the root changes.
			React.useEffect(() => {
				if (!root) return;
				const ctrl = new AbortController();
				setTree(null);
				setTreeError(null);
				setStatusMap({});
				setGitStatusData({ isRepo: false, files: [] });
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
						return refreshStatus(ctrl.signal);
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
					// Branch icon: toggles the left pane between file tree and the
					// VS Code-style Git panel. Only shown when the workspace is a repo.
					// A change-count badge (VS Code activity-bar style) hints at how
					// many files have pending changes.
					hasGit
						? h(
								"button",
								{
									className: "wf-btn" + (gitMode ? " wf-btnActive" : ""),
									style: { marginLeft: "auto", padding: "2px 8px", fontSize: "12px", display: "inline-flex", alignItems: "center", gap: "4px" },
									onClick: () => setGitMode((v) => !v),
									title: gitMode ? "切换到文件树" : "切换到 Git 视图",
								},
								gitMode ? "📁 文件" : "⎇ Git",
								Object.keys(statusMap).length ? h("span", { className: "wf-badge" }, String(Object.keys(statusMap).length)) : null,
							)
						: null,
				),
				h(
					"div",
					{ style: bodyStyle },
					h(
						"div",
						{ className: "wf-treePane", style: treePaneStyle },
						gitMode
							? h(GitPanel, {
									root,
									sessionId,
									status: gitStatusData,
									onRefreshStatus: () => refreshStatus(new AbortController().signal),
									onOpenFile: setSelected,
								})
							: [
									treeError
										? h("div", { key: "err", style: { color: "var(--dsw-alias-state-error-primary, #f85149)", padding: "8px" } }, treeError)
										: null,
									tree === null && !treeError ? h("div", { key: "load", style: { opacity: 0.6, padding: "8px" } }, "加载中\u2026") : null,
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
								],
					),
					h("div", { className: "wf-contentPane", style: contentPaneStyle }, h(ContentView, { root, entry: selected, hasGit, refreshToken: diffToken })),
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
