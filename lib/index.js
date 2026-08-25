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
 * @param {string} cwd @param {string[]} args
 * @returns {Promise<{stdout: Buffer, stderr: string, code: number}>}
 */
function runGit(cwd, args) {
	return new Promise((resolvePromise, reject) => {
		execFile(
			"git",
			args,
			{ cwd, encoding: "buffer", maxBuffer: MAX_DIFF_BYTES + 65536, windowsHide: true },
			(error, stdout, stderr) => {
				if (error && error.code === "ENOENT") {
					const missing = new Error("git binary not found on PATH");
					missing.gitMissing = true;
					reject(missing);
					return;
				}
				const code = error && typeof error.code === "number" ? error.code : 0;
				resolvePromise({ stdout: stdout || Buffer.alloc(0), stderr: (stderr || Buffer.alloc(0)).toString("utf8"), code });
			},
		);
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
		files.push({ path: join(resolve(root), relPath), rel: relPath, code: pickCode(x, y), staged: x !== " " && x !== "?" });
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

/** Handle one request under the git prefix. */
async function handleGit(prefix, req, res) {
	if (req.method !== "GET") throw new HttpError(405, "method not allowed");
	const url = new URL(req.url ?? "/", "http://x");
	const action = url.pathname.slice(prefix.length).replace(/^\//, "");
	const root = url.searchParams.get("root");
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
	throw new HttpError(404, `unknown action: ${action}`);
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
						await handleGit(gitPrefix, req, res);
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
