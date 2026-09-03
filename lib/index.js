import { execFile } from "node:child_process";
import { access, opendir, readFile, stat } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";

/**
 * Workspace files plugin — node (host) half. A single `apply` registers two
 * prefix HTTP routes on the shared webserver:
 *
 *   /api/workspace-files/session-root?sessionId=<id>   → { root }
 *   /api/workspace-files/list?root=<abs>&path=<abs>     → directory listing
 *   /api/workspace-files/read?root=<abs>&path=<abs>     → file content
 *   /api/workspace-git/is-repo?root=<abs>               → repo probe
 *   /api/workspace-git/status?root=<abs>                → working-tree status
 *   /api/workspace-git/diff?root=<abs>&path=<abs>       → structured hunks
 *
 * All filesystem access is confined to a caller-supplied workspace root (path
 * traversal outside it is rejected). Git degrades gracefully: a non-repo, a
 * missing git binary, or an untracked/binary file each yields a well-formed
 * answer the browser branches on. The browser half calls these routes with
 * plain fetch (no Typert RPC), so the whole plugin is self-contained.
 *
 * This module is also the loader row's host body (the dsh.client node half is
 * simultaneously a host plugin); the browser half ships via exports["./client"].
 *
 * @module dsh-plugin-workspace-files
 */

/** Stable Cordis plugin name. */
export const name = "workspace-files";

/** The webserver service must exist before the route seats can be claimed. */
export const inject = ["webServer"];

/** Default route prefixes; a deployment may override them in the patch config. */
const FILES_PREFIX = "/api/workspace-files";
const GIT_PREFIX = "/api/workspace-git";

/** Max bytes a single file read returns; larger files are truncated with a flag. */
const MAX_READ_BYTES = 512 * 1024;

/** Max child entries a single directory listing returns; larger levels are truncated. */
const MAX_ENTRIES = 2000;

/** Max bytes of a single `git diff` we will parse (guards huge diffs). */
const MAX_DIFF_BYTES = 2 * 1024 * 1024;

// ── shared helpers ─────────────────────────────────────────────────────────

/** An error carrying an HTTP status code for the route boundary. */
class HttpError extends Error {
	/** @param {number} status @param {string} message */
	constructor(status, message) {
		super(message);
		this.status = status;
	}
}

/** Message text of an unknown thrown value. */
function messageOf(error) {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Resolve `target` and prove it stays within `root` (root itself is allowed).
 * Returns the normalized absolute path, or null when outside the root.
 * @param {string} root - absolute workspace root.
 * @param {string} target - candidate absolute path.
 * @returns {string | null}
 */
function confine(root, target) {
	const normalizedRoot = resolve(root);
	const normalizedTarget = resolve(target);
	if (normalizedTarget === normalizedRoot) return normalizedTarget;
	if (normalizedTarget.startsWith(normalizedRoot + sep)) return normalizedTarget;
	return null;
}

/** Map a Node fs error code to an HTTP status. */
function errorStatus(error) {
	const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
	if (code === "ENOENT") return 404;
	if (code === "EACCES" || code === "EPERM") return 403;
	return 500;
}

/** Write a JSON response with the given status. */
function sendJson(res, status, body) {
	res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(body));
}

// ── files: session-root / list / read ───────────────────────────────────────

/**
 * Resolve a session's workspace root (its stored header `cwd`) by id. Uses the
 * live session when present, else the persisted header list. Accessed through
 * `ctx.get(...)` so this route plugin never blocks on the session services.
 * @param {any} ctx - plugin context.
 * @param {string} sessionId - the session id.
 * @returns {Promise<string | undefined>} the workspace root, or undefined.
 */
async function resolveSessionRoot(ctx, sessionId) {
	try {
		const live = ctx.get("sessions")?.get?.(sessionId);
		if (live?.header?.cwd) return live.header.cwd;
	} catch {
		/* sessions service shape differs — fall through to persistence */
	}
	try {
		const persistence = ctx.get("sessionPersistence");
		if (persistence?.list) {
			const headers = await persistence.list();
			const header = (headers || []).find((hh) => hh && hh.id === sessionId);
			if (header?.cwd) return header.cwd;
		}
	} catch {
		/* persistence unavailable — undefined workspace root */
	}
	return undefined;
}

/**
 * One directory listing confined to the root. Directories sort before files,
 * then by locale name. Symlinks are reported by their own dirent kind and not
 * followed (kept simple and safe for v1).
 * @param {string} root - absolute workspace root.
 * @param {string} target - absolute directory to list (defaults to root).
 * @returns {Promise<object>}
 */
async function listDir(root, target) {
	const dir = target === undefined || target === "" ? resolve(root) : confine(root, target);
	if (dir === null) throw new HttpError(403, `path escapes workspace root: ${target}`);
	const entries = [];
	let truncated = false;
	let handle;
	try {
		handle = await opendir(dir);
	} catch (error) {
		throw new HttpError(errorStatus(error), `cannot list ${dir}: ${messageOf(error)}`);
	}
	try {
		for await (const dirent of handle) {
			if (entries.length >= MAX_ENTRIES) {
				truncated = true;
				break;
			}
			const isDirectory = dirent.isDirectory();
			entries.push({
				name: dirent.name,
				path: join(dir, dirent.name),
				kind: isDirectory ? "dir" : dirent.isSymbolicLink() ? "symlink" : "file",
				hidden: dirent.name.startsWith("."),
			});
		}
	} finally {
		/* opendir's async iterator closes the handle when fully drained; on an
		   early break we close it explicitly. */
		if (truncated) await handle.close().catch(() => {});
	}
	entries.sort((a, b) => {
		if (a.kind === "dir" && b.kind !== "dir") return -1;
		if (a.kind !== "dir" && b.kind === "dir") return 1;
		return a.name.localeCompare(b.name);
	});
	return { root: resolve(root), path: dir, name: basename(dir) || dir, entries, truncated };
}

/** True when a buffer's leading window looks like binary (has a NUL byte). */
function looksBinary(buffer) {
	const window = buffer.subarray(0, Math.min(buffer.length, 8000));
	return window.includes(0);
}

/**
 * Read one file confined to the root, truncated to MAX_READ_BYTES. Binary
 * files return no content, only a flag.
 * @param {string} root - absolute workspace root.
 * @param {string} target - absolute file path.
 * @returns {Promise<object>}
 */
async function readFileConfined(root, target) {
	const file = confine(root, target);
	if (file === null) throw new HttpError(403, `path escapes workspace root: ${target}`);
	let info;
	try {
		info = await stat(file);
	} catch (error) {
		throw new HttpError(errorStatus(error), `cannot stat ${file}: ${messageOf(error)}`);
	}
	if (info.isDirectory()) throw new HttpError(400, `not a file: ${file}`);
	let buffer;
	try {
		buffer = await readFile(file);
	} catch (error) {
		throw new HttpError(errorStatus(error), `cannot read ${file}: ${messageOf(error)}`);
	}
	const size = buffer.length;
	if (looksBinary(buffer)) {
		return { path: file, name: basename(file), size, binary: true, truncated: false, content: "" };
	}
	const truncated = size > MAX_READ_BYTES;
	const slice = truncated ? buffer.subarray(0, MAX_READ_BYTES) : buffer;
	return { path: file, name: basename(file), size, binary: false, truncated, content: slice.toString("utf8") };
}

/** Handle one request under the files prefix. */
async function handleFiles(ctx, prefix, req, res) {
	if (req.method !== "GET") throw new HttpError(405, "method not allowed");
	const url = new URL(req.url ?? "/", "http://x");
	const action = url.pathname.slice(prefix.length).replace(/^\//, "");

	if (action === "session-root") {
		const sessionId = url.searchParams.get("sessionId");
		if (sessionId === null || sessionId === "") throw new HttpError(400, "missing sessionId");
		const root = await resolveSessionRoot(ctx, sessionId);
		sendJson(res, 200, { sessionId, root: root ?? null });
		return;
	}

	const root = url.searchParams.get("root");
	if (root === null || root === "") throw new HttpError(400, "missing root");
	const path = url.searchParams.get("path") ?? undefined;
	if (action === "list") {
		sendJson(res, 200, await listDir(root, path));
		return;
	}
	if (action === "read") {
		if (path === undefined) throw new HttpError(400, "missing path");
		sendJson(res, 200, await readFileConfined(root, path));
		return;
	}
	throw new HttpError(404, `unknown action: ${action}`);
}

// ── git: is-repo / status / diff ─────────────────────────────────────────────

/**
 * Run git with args in `cwd`. Resolves { stdout, stderr, code }. A missing git
 * binary rejects with a `gitMissing`-tagged error; git's own non-zero exits
 * resolve normally so callers can branch on the code.
 *
 * The optional `opts` carries write-command safeguards:
 *   - `timeoutMs` (default none): kills the process after this many ms
 *     (network ops like push/pull must not hang the request forever).
 *   - `env`: extra environment merged onto `process.env`. Write commands pass
 *     `GIT_TERMINAL_PROMPT=0` so a credential prompt fails fast instead of
 *     hanging the non-interactive child forever.
 * @param {string} cwd @param {string[]} args @param {{ timeoutMs?: number, env?: Record<string,string> }} [opts]
 * @returns {Promise<{stdout: Buffer, stderr: string, code: number}>}
 */
function runGit(cwd, args, opts = {}) {
	const childEnv = Object.assign({}, process.env, opts.env || {});
	return new Promise((resolvePromise, reject) => {
		const child = execFile(
			"git",
			args,
			{
				cwd,
				encoding: "buffer",
				maxBuffer: MAX_DIFF_BYTES + 65536,
				windowsHide: true,
				env: childEnv,
				timeout: typeof opts.timeoutMs === "number" ? opts.timeoutMs : 0,
			},
			(error, stdout, stderr) => {
				if (error && error.code === "ENOENT") {
					const missing = new Error("git binary not found on PATH");
					missing.gitMissing = true;
					reject(missing);
					return;
				}
				const code = error && typeof error.code === "number" ? error.code : 0;
				const stderrText = (stderr || Buffer.alloc(0)).toString("utf8");
				// Node sets error.killed / error.signal when the timeout fires.
				const timedOut = !!(error && (error.killed || error.signal === "SIGTERM"));
				resolvePromise({
					stdout: stdout || Buffer.alloc(0),
					stderr: stderrText,
					code,
					timedOut,
				});
			},
		);
		// execFile's `timeout` sends SIGTERM; on some platforms a stubborn git
		// (e.g. mid-network) may ignore it. Force-kill after a grace period.
		if (opts.timeoutMs) {
			child.once("close", () => {});
		}
	});
}

/** True when `root/.git` exists (file or dir — worktrees use a file). */
async function hasGitDir(root) {
	try {
		await access(join(resolve(root), ".git"));
		return true;
	} catch {
		return false;
	}
}

/** Whether the root is inside a git work tree (probe .git, then confirm with git). */
async function isRepo(root) {
	if (!(await hasGitDir(root))) {
		try {
			const { stdout, code } = await runGit(root, ["rev-parse", "--is-inside-work-tree"]);
			return { isRepo: code === 0 && stdout.toString("utf8").trim() === "true" };
		} catch (error) {
			if (error.gitMissing) return { isRepo: false, gitMissing: true };
			return { isRepo: false };
		}
	}
	return { isRepo: true };
}

/** Choose the single display code from the two porcelain columns. */
function pickCode(x, y) {
	if (x === "?" || y === "?") return "?";
	const c = x !== " " ? x : y;
	if (c === "M" || c === "A" || c === "D" || c === "R" || c === "C") return c;
	return "M";
}

/**
 * Parse `git status --porcelain=v1 -z` into per-file rows with a single code.
 * @param {string} root @param {Buffer} stdout
 */
function parseStatus(root, stdout) {
	const parts = stdout.toString("utf8").split("\0");
	const files = [];
	for (let i = 0; i < parts.length; i++) {
		const record = parts[i];
		if (!record) continue;
		const x = record[0];
		const y = record[1];
		let relPath = record.slice(3);
		if (x === "R" || y === "R") {
			const dest = parts[i + 1];
			if (dest !== undefined) {
				relPath = dest;
				i++;
			}
		}
		// `x`/`y` are the raw porcelain columns (index / working-tree). Exposing
		// both lets the browser split a file into the Staged and Changes sections
		// independently (a file like "MM" belongs to both, exactly as VS Code
		// shows it). `code`/`staged` stay for the tree badges and back-compat.
		files.push({ path: join(resolve(root), relPath), rel: relPath, x, y, code: pickCode(x, y), staged: x !== " " && x !== "?" });
	}
	return files;
}

/** The platform null device path for --no-index new-file diffs. */
function nulDevice() {
	return process.platform === "win32" ? "NUL" : "/dev/null";
}

/**
 * Parse unified diff text into hunks: { header, lines: [{type,text}] } where
 * type is 'add' | 'del' | 'ctx'. File headers and index lines are skipped.
 * @param {string} text
 */
function parseUnifiedDiff(text) {
	const hunks = [];
	let current = null;
	for (const line of text.split("\n")) {
		if (line.startsWith("@@")) {
			current = { header: line, lines: [] };
			hunks.push(current);
			continue;
		}
		if (current === null) continue;
		if (line.startsWith("+")) current.lines.push({ type: "add", text: line.slice(1) });
		else if (line.startsWith("-")) current.lines.push({ type: "del", text: line.slice(1) });
		else if (line.startsWith(" ")) current.lines.push({ type: "ctx", text: line.slice(1) });
		else if (line.startsWith("\\")) continue;
	}
	return hunks;
}

/**
 * Structured diff for one file (working tree vs index/HEAD; untracked files vs
 * the empty tree via --no-index so a brand-new file still shows added lines).
 * @param {string} root @param {string} absPath
 */
async function diffFile(root, absPath) {
	const rel = relative(resolve(root), absPath);
	let tracked = true;
	try {
		const { code } = await runGit(root, ["ls-files", "--error-unmatch", "--", rel]);
		tracked = code === 0;
	} catch (error) {
		if (error.gitMissing) throw new HttpError(200, "git-missing");
		tracked = false;
	}
	let result;
	if (tracked) {
		result = await runGit(root, ["diff", "--no-color", "--", rel]);
		if (result.stdout.length === 0) result = await runGit(root, ["diff", "--no-color", "--cached", "--", rel]);
	} else {
		result = await runGit(root, ["diff", "--no-color", "--no-index", "--", nulDevice(), rel]);
	}
	return { path: absPath, rel, tracked, hunks: parseUnifiedDiff(result.stdout.toString("utf8")) };
}

// ── git write helpers ──────────────────────────────────────────────────────

/** Default timeout for network git ops (push/pull/fetch). */
const GIT_NET_TIMEOUT_MS = 120_000;

/** Environment for write commands: never prompt for credentials. */
const GIT_NO_PROMPT_ENV = { GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" };

/**
 * Read and parse a JSON request body. Caps size to avoid unbounded reads.
 * @param {import('http').IncomingMessage} req
 * @returns {Promise<any>}
 */
function readJsonBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		const LIMIT = 1024 * 1024; // 1 MB is generous for our payloads
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > LIMIT) {
				reject(new HttpError(413, "request body too large"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			const raw = Buffer.concat(chunks).toString("utf8");
			if (raw === "") {
				resolve({});
				return;
			}
			try {
				resolve(JSON.parse(raw));
			} catch {
				reject(new HttpError(400, "invalid JSON body"));
			}
		});
		req.on("error", reject);
	});
}

/**
 * Require `root` to be a git repo; returns the normalized root. Throws an
 * HttpError(400) when not a repo so write routes fail fast with a clear cause.
 * @param {string} root
 * @returns {Promise<string>}
 */
async function requireRepo(root) {
	const dir = confine(root, root);
	if (dir === null) throw new HttpError(403, `path escapes workspace root: ${root}`);
	const repo = await isRepo(root);
	if (!repo.isRepo) throw new HttpError(400, "not a git repository");
	return resolve(root);
}

/**
 * Normalize a list of caller-supplied paths: each must confine to root, and is
 * returned as a repo-relative path (POSIX separators) for git's -- pathspec.
 * @param {string} root
 * @param {string[]} paths
 * @returns {string[]}
 */
function confinedRelPaths(root, paths) {
	const out = [];
	for (const p of paths || []) {
		const abs = confine(root, p);
		if (abs === null) throw new HttpError(403, `path escapes workspace root: ${p}`);
		out.push(relative(resolve(root), abs).split(sep).join("/"));
	}
	return out;
}

/**
 * List local branches and the current one. Returns { current, branches }.
 * @param {string} root
 */
async function listBranches(root) {
	await requireRepo(root);
	const { stdout, code } = await runGit(root, ["branch", "--list", "--format=%(HEAD)%(refname:short)"]);
	const branches = [];
	let current = null;
	if (code === 0) {
		for (const line of stdout.toString("utf8").split("\n")) {
			if (!line) continue;
			const isCur = line.startsWith("*");
			const name = (isCur ? line.slice(1) : line).trim();
			if (!name) continue;
			if (isCur) current = name;
			branches.push(name);
		}
	}
	return { current, branches };
}

/**
 * Checkout a branch by name. Refuses path-like names (must match a branch).
 * @param {string} root @param {string} branch
 */
async function checkoutBranch(root, branch) {
	await requireRepo(root);
	if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.includes("..") || branch.startsWith("-")) {
		throw new HttpError(400, "invalid branch name");
	}
	const result = await runGit(root, ["checkout", branch], { env: GIT_NO_PROMPT_ENV });
	return { ok: result.code === 0, stderr: result.stderr.trim(), code: result.code };
}

/**
 * Stage paths (`git add`). An empty list stages all changes (`git add -A`).
 * @param {string} root @param {string[]} paths
 */
async function stagePaths(root, paths) {
	await requireRepo(root);
	const rels = confinedRelPaths(root, paths);
	const args = rels.length ? ["add", "--", ...rels] : ["add", "-A"];
	const result = await runGit(root, args);
	return { ok: result.code === 0, stderr: result.stderr.trim(), code: result.code };
}

/**
 * Unstage paths (`git reset` — mixed reset to index only). Empty = reset all.
 * @param {string} root @param {string[]} paths
 */
async function unstagePaths(root, paths) {
	await requireRepo(root);
	const rels = confinedRelPaths(root, paths);
	const args = rels.length ? ["reset", "--", ...rels] : ["reset"];
	const result = await runGit(root, args);
	return { ok: result.code === 0, stderr: result.stderr.trim(), code: result.code };
}

/**
 * Discard working-tree changes for paths (destructive). Tracked paths are
 * restored to the index/HEAD via `git checkout -- <paths>`; untracked paths are
 * removed via `git clean -fd -- <paths>`. An empty list discards ALL working-
 * tree changes (`git checkout -- .` then `git clean -fd`). `checkout`/`clean`
 * are used over `restore` for broad git-version compatibility.
 *
 * This is irreversible for uncommitted work, so the browser gates it behind a
 * confirmation dialog; the route itself only enforces the workspace-root
 * boundary (via confinedRelPaths) and that the target is a repo.
 * @param {string} root @param {string[]} paths
 */
async function discardPaths(root, paths) {
	await requireRepo(root);
	const rels = confinedRelPaths(root, paths);
	// Empty list → discard everything: restore tracked, then remove untracked.
	if (rels.length === 0) {
		const restore = await runGit(root, ["checkout", "--", "."]);
		const clean = await runGit(root, ["clean", "-fd"]);
		const stderr = [restore.stderr.trim(), clean.stderr.trim()].filter(Boolean).join("\n");
		const code = restore.code || clean.code;
		return { ok: code === 0, stderr, code };
	}
	// Partition the requested paths into tracked / untracked (they take different
	// git commands: checkout restores a tracked file, clean removes an untracked one).
	const tracked = [];
	const untracked = [];
	for (const rel of rels) {
		const probe = await runGit(root, ["ls-files", "--error-unmatch", "--", rel]);
		if (probe.code === 0) tracked.push(rel);
		else untracked.push(rel);
	}
	let code = 0;
	const stderrs = [];
	if (tracked.length) {
		const r = await runGit(root, ["checkout", "--", ...tracked]);
		if (r.code !== 0) code = r.code;
		if (r.stderr.trim()) stderrs.push(r.stderr.trim());
	}
	if (untracked.length) {
		const r = await runGit(root, ["clean", "-fd", "--", ...untracked]);
		if (r.code !== 0) code = code || r.code;
		if (r.stderr.trim()) stderrs.push(r.stderr.trim());
	}
	return { ok: code === 0, stderr: stderrs.join("\n"), code };
}

/**
 * Commit staged changes with a message. Refuses empty messages.
 * @param {string} root @param {string} message
 */
async function commitChanges(root, message) {
	await requireRepo(root);
	const msg = String(message || "").trim();
	if (!msg) throw new HttpError(400, "commit message is empty");
	// -m with a single string; git rejects multi-line control chars here anyway.
	const result = await runGit(root, ["commit", "-m", msg], { env: GIT_NO_PROMPT_ENV });
	return { ok: result.code === 0, stderr: result.stderr.trim(), code: result.code };
}

/**
 * Pull from the upstream tracking branch.
 * @param {string} root
 */
async function pullRemote(root) {
	await requireRepo(root);
	const result = await runGit(root, ["pull"], {
		env: GIT_NO_PROMPT_ENV,
		timeoutMs: GIT_NET_TIMEOUT_MS,
	});
	return { ok: result.code === 0, stderr: result.stderr.trim(), stdout: result.stdout.toString("utf8").trim(), code: result.code, timedOut: result.timedOut };
}

/**
 * Push to the upstream tracking branch.
 * @param {string} root
 */
async function pushRemote(root) {
	await requireRepo(root);
	const result = await runGit(root, ["push"], {
		env: GIT_NO_PROMPT_ENV,
		timeoutMs: GIT_NET_TIMEOUT_MS,
	});
	return { ok: result.code === 0, stderr: result.stderr.trim(), stdout: result.stdout.toString("utf8").trim(), code: result.code, timedOut: result.timedOut };
}

// ── AI commit message generation ───────────────────────────────────────────

/**
 * Resolve the current session's model route — the provider+model the user
 * selected for this conversation (e.g. GLM 5.2). Reads `requestContext()`
 * from the live Session, which folds the latest `request/context` event.
 * Returns undefined before the session has sent its first model request.
 * @param {any} ctx @param {string} sessionId
 * @returns {{provider:string, model:string} | undefined}
 */
function resolveSessionModel(ctx, sessionId) {
	try {
		const session = ctx.get("sessions")?.get?.(sessionId);
		const route = session?.requestContext?.();
		if (route && typeof route.provider === "string" && typeof route.model === "string") {
			return { provider: route.provider, model: route.model };
		}
	} catch {
		/* session shape differs or unavailable — caller falls back */
	}
	return undefined;
}

/**
 * Collect visible text from an llm.stream() chunk iterator. The stream emits
 * token-level deltas; we accumulate `text-delta` chunks into a string and stop
 * at the terminal `finish` chunk. Tool-call chunks are ignored (a commit
 * message must be plain text).
 * @param {AsyncIterable<any>} stream
 * @param {AbortSignal} [signal]
 * @returns {Promise<string>}
 */
async function collectStreamText(stream, signal) {
	let text = "";
	for await (const chunk of stream) {
		if (signal?.aborted) break;
		if (chunk.type === "text-delta" && typeof chunk.text === "string") {
			text += chunk.text;
		} else if (chunk.type === "finish") {
			break;
		}
	}
	return text.trim();
}

/**
 * Generate a commit message from staged changes using the session's current
 * model. Gathers the staged diff, asks the model for a concise conventional
 * commit message, and returns it. Requires both the llm service and a resolved
 * session model route; throws an HttpError with a clear cause otherwise.
 * @param {any} ctx
 * @param {string} root
 * @param {string} sessionId
 * @returns {Promise<{message: string}>}
 */
async function generateCommitMessage(ctx, root, sessionId) {
	await requireRepo(root);
	const llm = ctx.get("llm");
	if (!llm || typeof llm.stream !== "function") {
		throw new HttpError(503, "AI 生成不可用：llm 服务未就绪");
	}
	const route = resolveSessionModel(ctx, sessionId);
	if (!route) {
		throw new HttpError(503, "AI 生成不可用：请先在对话中发送一条消息以确定当前模型");
	}
	// Gather the staged diff (cached + working tree staged changes). If nothing
	// is staged, fall back to the full working-tree diff so the user still gets
	// a message for what they see changed.
	let diffResult = await runGit(root, ["diff", "--no-color", "--cached"]);
	if (diffResult.stdout.length === 0) {
		diffResult = await runGit(root, ["diff", "--no-color"]);
	}
	const diff = diffResult.stdout.toString("utf8").trim();
	if (!diff) {
		throw new HttpError(400, "没有可生成信息的改动（暂存区和工作区均为空）");
	}
	// Cap the diff sent to the model to avoid blowing the context window.
	const MAX_DIFF_FOR_LLM = 16 * 1024;
	const trimmedDiff = diff.length > MAX_DIFF_FOR_LLM ? diff.slice(0, MAX_DIFF_FOR_LLM) + "\n... (diff truncated)" : diff;

	const system =
		"你是一个专业的 Git 提交信息生成助手。根据给定的 git diff，生成一条简洁的 conventional commit 提交信息。" +
		"格式：第一行是 type: 简短描述（不超过 72 字符），type 从 feat/fix/docs/style/refactor/test/chore/perf 中选择。" +
		"可选地跟一个空行和正文说明。只输出提交信息本身，不要解释、不要 markdown 代码块。";
	const messages = [
		{
			role: "user",
			content: [{ type: "text", text: "请为以下 git diff 生成提交信息：\n\n```diff\n" + trimmedDiff + "\n```" }],
		},
	];

	const ctrl = new AbortController();
	const timeout = setTimeout(() => ctrl.abort(), 60_000);
	let message;
	try {
		const stream = llm.stream({
			provider: route.provider,
			model: route.model,
			system,
			messages,
			maxTokens: 300,
			sessionId,
			purpose: "git-commit-message",
			signal: ctrl.signal,
		});
		message = await collectStreamText(stream, ctrl.signal);
	} catch (e) {
		const msg = e && typeof e.message === "string" ? e.message : String(e);
		throw new HttpError(502, `AI 生成失败：${msg}`);
	} finally {
		clearTimeout(timeout);
	}
	if (!message) {
		throw new HttpError(502, "AI 生成失败：模型未返回文本");
	}
	return { message };
}

/** Handle one request under the git prefix. */
async function handleGit(ctx, prefix, req, res) {
	const url = new URL(req.url ?? "/", "http://x");
	const action = url.pathname.slice(prefix.length).replace(/^\//, "");
	const root = url.searchParams.get("root");

	// ── GET: read-only routes (is-repo / status / diff) ─────────────────────
	if (req.method === "GET") {
		if (root === null || root === "") throw new HttpError(400, "missing root");

		if (action === "is-repo") {
			sendJson(res, 200, await isRepo(root));
			return;
		}
		if (action === "status") {
			const repo = await isRepo(root);
			if (!repo.isRepo) {
				sendJson(res, 200, { isRepo: false, files: [] });
				return;
			}
			const { stdout } = await runGit(root, ["status", "--porcelain=v1", "-z"]);
			sendJson(res, 200, { isRepo: true, files: parseStatus(root, stdout) });
			return;
		}
		if (action === "diff") {
			const path = url.searchParams.get("path");
			if (path === null || path === "") throw new HttpError(400, "missing path");
			const abs = confine(root, path);
			if (abs === null) throw new HttpError(403, `path escapes workspace root: ${path}`);
			const repo = await isRepo(root);
			if (!repo.isRepo) {
				sendJson(res, 200, { path: abs, tracked: false, hunks: [] });
				return;
			}
			sendJson(res, 200, await diffFile(root, abs));
			return;
		}
		// branches is read-only but reused by the Git panel; allow GET too.
		if (action === "branches") {
			sendJson(res, 200, await listBranches(root));
			return;
		}
		throw new HttpError(404, `unknown action: ${action}`);
	}

	// ── POST: write routes (branches is also reachable via POST below) ───────
	if (req.method === "POST") {
		const body = await readJsonBody(req);
		const postRoot = root || body.root;
		if (!postRoot) throw new HttpError(400, "missing root");

		switch (action) {
			case "branches":
				sendJson(res, 200, await listBranches(postRoot));
				return;
			case "checkout": {
				if (!body.branch) throw new HttpError(400, "missing branch");
				sendJson(res, 200, await checkoutBranch(postRoot, body.branch));
				return;
			}
			case "stage":
				sendJson(res, 200, await stagePaths(postRoot, body.paths));
				return;
			case "unstage":
				sendJson(res, 200, await unstagePaths(postRoot, body.paths));
				return;
			case "discard":
				sendJson(res, 200, await discardPaths(postRoot, body.paths));
				return;
			case "commit": {
				sendJson(res, 200, await commitChanges(postRoot, body.message));
				return;
			}
			case "pull":
				sendJson(res, 200, await pullRemote(postRoot));
				return;
			case "push":
				sendJson(res, 200, await pushRemote(postRoot));
				return;
			case "commit-message": {
				// AI-generate a commit message from the current diff, using the
				// session's currently-selected model. Requires sessionId.
				const sessionId = url.searchParams.get("sessionId") || body.sessionId;
				if (!sessionId) throw new HttpError(400, "missing sessionId");
				sendJson(res, 200, await generateCommitMessage(ctx, postRoot, sessionId));
				return;
			}
			default:
				throw new HttpError(404, `unknown action: ${action}`);
		}
	}

	throw new HttpError(405, "method not allowed");
}

// ── apply ────────────────────────────────────────────────────────────────────

/**
 * Register both route seats (files + git) on the shared webserver.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context with webServer.
 * @param {{ filesPrefix?: string, gitPrefix?: string }} [config]
 */
export function apply(ctx, config = {}) {
	const filesPrefix = config.filesPrefix ?? FILES_PREFIX;
	const gitPrefix = config.gitPrefix ?? GIT_PREFIX;

	ctx.effect(
		() =>
			ctx.webServer.register({
				kind: "prefix",
				path: filesPrefix,
				name: "workspace-files",
				handler: async (req, res) => {
					try {
						await handleFiles(ctx, filesPrefix, req, res);
					} catch (error) {
						sendJson(res, error instanceof HttpError ? error.status : 500, { error: messageOf(error) });
					}
				},
			}),
		"workspace-files: files route seat",
	);

	ctx.effect(
		() =>
			ctx.webServer.register({
				kind: "prefix",
				path: gitPrefix,
				name: "workspace-git",
				handler: async (req, res) => {
					try {
						await handleGit(ctx, gitPrefix, req, res);
					} catch (error) {
						if (error && error.gitMissing) {
							sendJson(res, 200, { isRepo: false, gitMissing: true, files: [], hunks: [] });
							return;
						}
						sendJson(res, error instanceof HttpError ? error.status : 500, { error: messageOf(error) });
					}
				},
			}),
		"workspace-files: git route seat",
	);
}
