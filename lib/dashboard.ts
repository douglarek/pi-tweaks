/**
 * Pi Dashboard & Location Picker Extension for pi-tweaks
 *
 * Modeled after grok-build's Dashboard and Ctrl+L Location Picker:
 * - /dashboard (or /db, Ctrl+\): Interactive dashboard showing historical sessions across projects,
 *   with "+ New Session" and "Switch Working Directory" at the top, live fuzzy filtering,
 *   inline directory path completion, project scope toggling, and instant session attachment.
 * - /cd [path]: Change working directory for Pi. Without arguments, opens the Location Picker modal.
 *   Supports Tab argument completion directly in the main editor.
 * - Ctrl+L: Opens the Location Picker directly from the editor or within the Dashboard.
 *
 * UX enhancements:
 * - Full Kitty keyboard protocol (CSI-u) printable decoding, bracketed paste, and Ctrl+W path segment deletion.
 * - Live filesystem directory completion with Tab in both Location Picker and Dashboard.
 * - Automatically discovers sibling workspace directories in addition to session history.
 * - When switching workspace, shows target directory's sessions with "+ New Session" at the very top.
 * - Instant session and directory switching upon Enter.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionInfo,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { CURRENT_SESSION_VERSION, SessionManager } from "@earendil-works/pi-coding-agent";
import {
	CURSOR_MARKER,
	type Component,
	decodeKittyPrintable,
	type Focusable,
	isKeyRelease,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	type TUI,
} from "@earendil-works/pi-tui";
import { resolveEditor, resolveSession } from "./queue-dispatch.ts";

// Cached references for instant session switching
let lastCommandCtx: ExtensionCommandContext | null = null;
let activeSession: any = null;
let activeTui: TUI | null = null;
let activeEditor: any = null;

export function registerDashboardTui(tui: TUI | null): void {
	activeTui = tui;
}

export function registerDashboardSession(session: any): void {
	activeSession = session;
}

export function registerDashboardEditor(editor: any): void {
	activeEditor = editor;
}

// ============================================================================
// Helper Utilities
// ============================================================================

/** Safe directory existence check (resolves symlinks via statSync) */
export function isDirectorySafe(p: string): boolean {
	try {
		return fs.existsSync(p) && fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

/**
 * Decode printable text input from raw terminal data.
 * Supports Kitty CSI-u sequences (\x1b[97u), bracketed paste (\x1b[200~...\x1b[201~),
 * and standard ASCII / UTF-8 characters while ignoring key-release events.
 */
export function extractPrintableInput(data: string): string | undefined {
	if (!data || isKeyRelease(data)) return undefined;

	// Handle bracketed paste mode
	if (data.includes("\x1b[200~")) {
		const cleaned = data
			.replace(/\x1b\[200~/g, "")
			.replace(/\x1b\[201~/g, "")
			.replace(/[\r\n\t]/g, "");
		return cleaned.length > 0 ? cleaned : undefined;
	}

	// Handle Kitty CSI-u printable key events (e.g. \x1b[97u -> 'a', \x1b[47u -> '/')
	const kitty = decodeKittyPrintable(data);
	if (kitty !== undefined) {
		return kitty;
	}

	// Regular printable characters (ASCII or multi-byte UTF-8 / CJK),
	// rejecting control characters (C0: 0x00-0x1F, DEL: 0x7F, C1: 0x80-0x9F)
	const hasControlChars = [...data].some((ch) => {
		const code = ch.charCodeAt(0);
		return code < 32 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
	});
	if (!hasControlChars && data.length > 0) {
		return data;
	}

	return undefined;
}

/** Delete one path segment or word backward (Ctrl+W / Alt+Backspace behavior) */
export function deletePathSegmentBackward(query: string): string {
	if (!query) return "";
	const trimmed = query.endsWith("/") && query.length > 1 ? query.slice(0, -1) : query;
	const lastSlash = trimmed.lastIndexOf("/");
	const lastSpace = trimmed.lastIndexOf(" ");
	const cutIndex = Math.max(lastSlash, lastSpace);
	if (cutIndex === -1) return "";
	return trimmed.slice(0, cutIndex + 1);
}

/** Clean quotes and whitespace from path arguments */
export function cleanPathArg(raw: string | undefined): string {
	let p = (raw ?? "").trim();
	if ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'"))) {
		p = p.slice(1, -1).trim();
	}
	return p;
}

/** Tilde-collapse absolute paths for compact display (e.g. ~/work/repo) */
export function displayPath(p: string): string {
	const home = os.homedir();
	if (p === home) return "~";
	if (p.startsWith(home + path.sep)) {
		return `~${p.slice(home.length)}`;
	}
	return p;
}

/** Expand leading ~ in user input */
export function expandTilde(p: string): string {
	const cleaned = cleanPathArg(p);
	if (cleaned === "~") return os.homedir();
	if (cleaned.startsWith(`~${path.sep}`) || cleaned.startsWith("~/")) {
		return path.join(os.homedir(), cleaned.slice(2));
	}
	if (cleaned.startsWith("~") && !cleaned.includes("/") && !cleaned.includes("\\")) {
		return path.join(os.homedir(), cleaned.slice(1));
	}
	return cleaned;
}

/** Resolve target directory path reliably against cwd */
export function resolveTargetDir(rawPath: string, baseCwd: string): string {
	const cleaned = cleanPathArg(rawPath);
	if (!cleaned) return "";
	const expanded = expandTilde(cleaned);
	return path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(baseCwd, expanded);
}

/** Whether a query string should trigger filesystem path completion mode */
export function isPathLikeQuery(rawQuery: string): boolean {
	const q = cleanPathArg(rawQuery);
	return (
		q.startsWith("/") ||
		q.startsWith("~") ||
		q.startsWith(".") ||
		q.includes("/") ||
		(process.platform === "win32" && q.includes("\\"))
	);
}

/** Human-friendly relative time (e.g. "5m ago", "2h ago", "3d ago") */
export function formatRelativeTime(date: Date | string | number): string {
	const timestamp = typeof date === "number" ? date : new Date(date).getTime();
	if (!timestamp || Number.isNaN(timestamp)) return "";
	const diffSec = Math.floor((Date.now() - timestamp) / 1000);
	if (diffSec < 60) return "just now";
	const diffMin = Math.floor(diffSec / 60);
	if (diffMin < 60) return `${diffMin}m ago`;
	const diffHour = Math.floor(diffMin / 60);
	if (diffHour < 24) return `${diffHour}h ago`;
	const diffDay = Math.floor(diffHour / 24);
	if (diffDay < 30) return `${diffDay}d ago`;
	const diffMonth = Math.floor(diffDay / 30);
	if (diffMonth < 12) return `${diffMonth}mo ago`;
	return `${Math.floor(diffDay / 365)}y ago`;
}

/** Read current git branch of a directory if inside a git repository */
export function getGitBranch(dir: string): string | null {
	try {
		let curr = path.resolve(dir);
		while (curr && curr !== path.dirname(curr)) {
			const gitPath = path.join(curr, ".git");
			if (fs.existsSync(gitPath)) {
				let headPath = path.join(gitPath, "HEAD");
				if (fs.statSync(gitPath).isFile()) {
					// Git worktree / submodule
					const gitFileContent = fs.readFileSync(gitPath, "utf-8").trim();
					const match = gitFileContent.match(/^gitdir:\s*(.+)$/);
					if (match) {
						headPath = path.resolve(curr, match[1], "HEAD");
					}
				}
				if (fs.existsSync(headPath)) {
					const head = fs.readFileSync(headPath, "utf-8").trim();
					if (head.startsWith("ref: refs/heads/")) {
						return head.replace("ref: refs/heads/", "");
					}
					return head.slice(0, 7); // Detached HEAD
				}
				break;
			}
			curr = path.dirname(curr);
		}
	} catch {
		// Ignore git inspection errors
	}
	return null;
}

/** Harvest unique recent project directories from historical sessions */
export function collectRecentDirs(sessions: SessionInfo[], currentCwd: string): Array<{ path: string; lastActive: number }> {
	const latestByDir = new Map<string, number>();

	for (const s of sessions) {
		if (!s.cwd) continue;
		if (!isDirectorySafe(s.cwd)) continue;
		const resolved = path.resolve(s.cwd);
		const ts = new Date(s.modified).getTime();
		const prev = latestByDir.get(resolved) ?? 0;
		if (ts > prev) {
			latestByDir.set(resolved, ts);
		}
	}

	// Always ensure currentCwd is at the top
	const result: Array<{ path: string; lastActive: number }> = [];
	const resolvedCwd = path.resolve(currentCwd);
	result.push({ path: resolvedCwd, lastActive: Date.now() });

	const others = Array.from(latestByDir.entries())
		.filter(([dir]) => path.resolve(dir) !== resolvedCwd)
		.sort((a, b) => b[1] - a[1])
		.map(([dir, lastActive]) => ({ path: dir, lastActive }));

	return [...result, ...others];
}

/** Read subdirectories inside parentDir matching optional partial name */
function listDirsInParent(parentDir: string, partial: string): Array<{ name: string; fullPath: string }> {
	if (!isDirectorySafe(parentDir)) return [];
	try {
		const wantHidden = partial.startsWith(".");
		const entries = fs.readdirSync(parentDir, { withFileTypes: true });
		return entries
			.filter((e) => {
				if (e.name.startsWith(".") && !wantHidden) return false;
				if (e.isDirectory()) return true;
				if (e.isSymbolicLink()) return isDirectorySafe(path.join(parentDir, e.name));
				return false;
			})
			.filter((e) => !partial || e.name.toLowerCase().includes(partial))
			.sort((a, b) => {
				if (partial) {
					const aStarts = a.name.toLowerCase().startsWith(partial);
					const bStarts = b.name.toLowerCase().startsWith(partial);
					if (aStarts !== bStarts) return aStarts ? -1 : 1;
				}
				return a.name.localeCompare(b.name);
			})
			.map((e) => ({
				name: e.name,
				fullPath: path.join(parentDir, e.name),
			}));
	} catch {
		return [];
	}
}

/** List subdirectories for path completion mode */
export function getSubdirectories(query: string, baseCwd: string): Array<{ name: string; fullPath: string }> {
	const cleaned = cleanPathArg(query);
	const resolvedBase = path.resolve(baseCwd);

	let parentDir: string;
	let partial: string;

	if (!cleaned || cleaned === ".") {
		parentDir = resolvedBase;
		partial = "";
	} else if (cleaned === "..") {
		parentDir = path.dirname(resolvedBase);
		partial = "";
	} else if (cleaned === "~") {
		parentDir = os.homedir();
		partial = "";
	} else if (cleaned.startsWith("~") && !cleaned.includes("/") && !cleaned.includes("\\")) {
		parentDir = os.homedir();
		partial = cleaned.slice(1).toLowerCase();
	} else {
		const expanded = expandTilde(cleaned);
		const endsWithSep = cleaned.endsWith("/") || (process.platform === "win32" && cleaned.endsWith("\\"));
		const target = path.isAbsolute(expanded) ? expanded : path.resolve(resolvedBase, expanded);

		if (endsWithSep) {
			parentDir = target;
			partial = "";
		} else {
			parentDir = path.dirname(target);
			partial = path.basename(target).toLowerCase();
		}
	}

	return listDirsInParent(parentDir, partial);
}

/**
 * Discover nearby directories (sibling projects in parent dir, subdirs of cwd, and home subdirs)
 * so users can find and complete new folders even without typing leading '/' or '~'.
 */
export function discoverNearbyDirectories(
	query: string,
	baseCwd: string,
	excludePaths: Set<string>,
): Array<{ name: string; fullPath: string; source: string }> {
	const resolvedBase = path.resolve(baseCwd);
	const parentWorkspace = path.dirname(resolvedBase);
	const home = os.homedir();
	const partial = cleanPathArg(query).toLowerCase();

	const results: Array<{ name: string; fullPath: string; source: string }> = [];
	const seen = new Set<string>(excludePaths);

	const addFrom = (dir: string, sourceLabel: string, limit: number) => {
		const subdirs = listDirsInParent(dir, partial);
		let count = 0;
		for (const d of subdirs) {
			const norm = path.resolve(d.fullPath);
			if (seen.has(norm)) continue;
			seen.add(norm);
			results.push({ name: d.name, fullPath: norm, source: sourceLabel });
			if (++count >= limit) break;
		}
	};

	// 1. Sibling directories in the parent workspace (e.g. ~/work/ai-works/*)
	if (parentWorkspace && parentWorkspace !== resolvedBase) {
		addFrom(parentWorkspace, "workspace", 30);
	}
	// 2. Immediate subdirectories of current working directory
	addFrom(resolvedBase, "subdir", 20);
	// 3. When user types a query, also search home directory
	if (partial && home !== resolvedBase && home !== parentWorkspace) {
		addFrom(home, "home", 15);
	}

	return results;
}

// ============================================================================
// Direct Session Switching Strategy Engine
// ============================================================================

/** Execute seamless session switch and directory switch without manual prompts */
export async function executeSessionSwitch(
	sessionPath: string,
	targetCwd?: string,
	tui?: TUI,
): Promise<boolean> {
	if (targetCwd) {
		try {
			process.chdir(targetCwd);
		} catch {
			// ignore directory change failure if already deleted
		}
	}

	// Strategy 1: Use lastCommandCtx if available
	if (lastCommandCtx?.switchSession) {
		try {
			const res = await lastCommandCtx.switchSession(sessionPath);
			if (!res?.cancelled) return true;
		} catch (err) {
			console.error("switchSession via lastCommandCtx failed:", err);
		}
	}

	// Strategy 2: Use activeSession if registered
	if (activeSession && typeof activeSession.createReplacedSessionContext === "function") {
		try {
			const repl = activeSession.createReplacedSessionContext();
			if (repl && typeof repl.switchSession === "function") {
				const res = await repl.switchSession(sessionPath);
				if (!res?.cancelled) return true;
			}
		} catch (err) {
			console.error("switchSession via activeSession failed:", err);
		}
	}

	// Strategy 3: Resolve session from TUI if provided or active
	const tuiInstance = tui ?? activeTui;
	if (tuiInstance) {
		const root =
			(tuiInstance as any).layoutRoot ??
			(tuiInstance as any).currentLayout?.root?.component ??
			tuiInstance;
		const found = resolveSession(root);
		if (found && typeof (found as any).createReplacedSessionContext === "function") {
			try {
				const repl = (found as any).createReplacedSessionContext();
				if (repl && typeof repl.switchSession === "function") {
					const res = await repl.switchSession(sessionPath);
					if (!res?.cancelled) return true;
				}
			} catch (err) {
				console.error("switchSession via resolved session failed:", err);
			}
		}

		// Strategy 4: Automatically submit /cd command via editor if editor is resolved
		const editor = resolveEditor(root) ?? activeEditor;
		if (editor && typeof editor.onSubmit === "function") {
			try {
				const target = targetCwd ?? sessionPath;
				await editor.onSubmit(`/cd ${target}`);
				return true;
			} catch (err) {
				console.error("onSubmit via editor failed:", err);
			}
		}
	}

	return false;
}

/** Create a new session in target directory and switch to it */
export async function createAndSwitchNewSession(
	targetDir: string,
	ctx: ExtensionContext,
	tui?: TUI,
): Promise<boolean> {
	const resolvedTarget = path.resolve(targetDir);
	try {
		process.chdir(resolvedTarget);

		const sm = SessionManager.create(resolvedTarget);
		const sessionFile = sm.getSessionFile();
		if (!sessionFile) {
			throw new Error("Failed to generate session file path");
		}

		const header = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: sm.getSessionId(),
			timestamp: new Date().toISOString(),
			cwd: resolvedTarget,
		};

		fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
		fs.writeFileSync(sessionFile, `${JSON.stringify(header)}\n`);

		const switched = await executeSessionSwitch(sessionFile, resolvedTarget, tui);
		if (switched) {
			ctx.ui.notify(`Started new session in ${displayPath(resolvedTarget)}`, "info");
			return true;
		}
	} catch (err) {
		ctx.ui.notify(`Failed to start session in ${displayPath(resolvedTarget)}: ${err instanceof Error ? err.message : String(err)}`, "error");
	}
	return false;
}

// ============================================================================
// Workspace Session Choice Modal Component (New Session on top + Recent Sessions)
// ============================================================================

export interface SessionChoiceResult {
	action: "new" | "attach" | "cancel";
	session?: SessionInfo;
}

export class SessionChoiceComponent implements Component, Focusable {
	focused = true;
	private tui: TUI;
	private targetDir: string;
	private branch: string | null;
	private sessions: SessionInfo[];
	private selectedIndex = 0; // 0 is "+ New Session"
	private scrollOffset = 0;
	private theme: Theme;
	private done: (result: SessionChoiceResult) => void;

	constructor(
		tui: TUI,
		targetDir: string,
		sessions: SessionInfo[],
		theme: Theme,
		done: (result: SessionChoiceResult) => void,
	) {
		this.tui = tui;
		this.targetDir = path.resolve(targetDir);
		this.branch = getGitBranch(this.targetDir);
		this.sessions = sessions;
		this.theme = theme;
		this.done = done;
	}

	handleInput(data: string): void {
		if (isKeyRelease(data)) return;

		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.done({ action: "cancel" });
			return;
		}

		const totalCount = 1 + this.sessions.length;

		if (matchesKey(data, "up") || matchesKey(data, "ctrl+p")) {
			if (this.selectedIndex > 0) {
				this.selectedIndex--;
				this.adjustScroll();
				this.tui.requestRender();
			}
			return;
		}

		if (matchesKey(data, "down") || matchesKey(data, "ctrl+n")) {
			if (this.selectedIndex < totalCount - 1) {
				this.selectedIndex++;
				this.adjustScroll();
				this.tui.requestRender();
			}
			return;
		}

		if (matchesKey(data, "pageup")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 8);
			this.adjustScroll();
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, "pagedown")) {
			this.selectedIndex = Math.min(totalCount - 1, this.selectedIndex + 8);
			this.adjustScroll();
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, "return")) {
			if (this.selectedIndex === 0) {
				this.done({ action: "new" });
			} else {
				const selected = this.sessions[this.selectedIndex - 1];
				this.done({ action: "attach", session: selected });
			}
			return;
		}
	}

	private adjustScroll(): void {
		const visibleRows = 9;
		if (this.selectedIndex < this.scrollOffset) {
			this.scrollOffset = this.selectedIndex;
		} else if (this.selectedIndex >= this.scrollOffset + visibleRows) {
			this.scrollOffset = this.selectedIndex - visibleRows + 1;
		}
	}

	render(width: number): string[] {
		const th = this.theme;
		const lines: string[] = [];
		const modalW = Math.max(48, Math.min(width, 76));

		const pad = (str: string, len: number) => {
			const vw = visibleWidth(str);
			return str + " ".repeat(Math.max(0, len - vw));
		};

		const row = (content: string) => {
			const inner = pad(content, modalW - 4);
			return `  ${th.fg("border", "│")} ${inner} ${th.fg("border", "│")}`;
		};

		const div = (label?: string) => {
			if (!label) {
				return `  ${th.fg("border", `├${"─".repeat(modalW - 2)}┤`)}`;
			}
			const l = ` ${label} `;
			const rem = Math.max(0, modalW - 4 - visibleWidth(l));
			return `  ${th.fg("border", `├─`)}${l}${th.fg("border", `${"─".repeat(rem)}┤`)}`;
		};

		// Top header
		lines.push("");
		const title = ` ${th.bold(th.fg("accent", "Workspace Sessions"))} `;
		const topRem = Math.max(0, modalW - 4 - visibleWidth(title));
		lines.push(`  ${th.fg("border", `╭─`)}${title}${th.fg("border", `${"─".repeat(topRem)}╮`)}`);

		// Workspace location row
		const branchStr = this.branch ? th.fg("muted", ` (${this.branch})`) : "";
		lines.push(row(`${th.fg("dim", "workspace:")} ${th.fg("text", displayPath(this.targetDir))}${branchStr}`));

		lines.push(div(th.fg("dim", "Select session or start new")));

		// Items: item 0 is "+ New Session", items 1..N are sessions
		const totalCount = 1 + this.sessions.length;
		const visibleRows = 9;
		const sliceStart = this.scrollOffset;

		for (let i = 0; i < visibleRows; i++) {
			const itemIdx = sliceStart + i;
			if (itemIdx >= totalCount) {
				lines.push(row(""));
				continue;
			}

			const isSel = itemIdx === this.selectedIndex;
			const pointer = isSel ? th.fg("accent", "❯ ") : "  ";

			if (itemIdx === 0) {
				// New Session option
				const newLabel = isSel ? th.bold(th.fg("accent", "+ New Session")) : th.fg("success", "+ New Session");
				const newDetail = isSel ? th.fg("text", "Start fresh") : th.fg("dim", "Start fresh");
				const leftPart = `${pointer}${newLabel}`;
				const rightPart = newDetail;
				const availMid = modalW - 6 - visibleWidth(leftPart) - visibleWidth(rightPart);
				const rightPad = Math.max(0, availMid);
				lines.push(row(`${leftPart}${" ".repeat(rightPad)}${rightPart}`));
			} else {
				// Existing session
				const s = this.sessions[itemIdx - 1];
				let titleText = s.name || (s.firstMessage ? s.firstMessage.split("\n")[0].trim() : s.id.slice(0, 8));
				titleText = titleText.slice(0, 32);

				const titleFormatted = isSel ? th.bold(th.fg("accent", titleText)) : th.fg("text", titleText);
				const timeFormatted = th.fg("dim", formatRelativeTime(s.modified));
				const msgCount = th.fg("dim", `${s.messageCount} msg${s.messageCount === 1 ? "" : "s"}`);

				const leftPart = `${pointer}${th.fg("dim", "○ ")}${titleFormatted}`;
				const rightPart = `${timeFormatted}  ${msgCount}`;
				const availMid = modalW - 6 - visibleWidth(leftPart) - visibleWidth(rightPart);
				const rightPad = Math.max(0, availMid);
				lines.push(row(`${leftPart}${" ".repeat(rightPad)}${rightPart}`));
			}
		}

		// Footer
		lines.push(div(th.fg("dim", "↑↓ nav  •  Enter select  •  Esc cancel")));
		lines.push(`  ${th.fg("border", `╰${"─".repeat(modalW - 2)}╯`)}`);
		lines.push("");

		return lines.map((l) => truncateToWidth(l, width));
	}

	invalidate(): void {}
}

// ============================================================================
// Location Picker Modal Component
// ============================================================================

export interface LocationPickerResult {
	action: "select" | "open_dashboard" | "cancel";
	selectedDir?: string;
}

export interface CandidateItem {
	label: string;
	detail: string;
	fullPath: string;
	isCurrent: boolean;
	isSelfTarget?: boolean;
}

export class LocationPickerComponent implements Component, Focusable {
	focused = true;
	private tui: TUI;
	private query = "";
	private selectedIndex = 0;
	private scrollOffset = 0;
	private error: string | null = null;
	private baseCwd: string;
	private branch: string | null;
	private recentCandidates: CandidateItem[];
	private recentPathSet: Set<string>;
	private cachedCandidates: CandidateItem[];
	private theme: Theme;
	private done: (result: LocationPickerResult) => void;

	constructor(
		tui: TUI,
		baseCwd: string,
		recentDirs: Array<{ path: string; lastActive: number }>,
		theme: Theme,
		done: (result: LocationPickerResult) => void,
	) {
		this.tui = tui;
		this.baseCwd = path.resolve(baseCwd);
		this.branch = getGitBranch(this.baseCwd);
		this.theme = theme;
		this.done = done;

		this.recentPathSet = new Set<string>();
		// Pre-compute recent items once
		this.recentCandidates = recentDirs.map((d) => {
			const norm = path.resolve(d.path);
			this.recentPathSet.add(norm);
			const isCurrent = norm === this.baseCwd;
			const name = path.basename(norm) || norm;
			const timeStr = isCurrent ? "current" : formatRelativeTime(d.lastActive);
			return {
				label: name,
				detail: `${displayPath(norm)}  ${timeStr ? `(${timeStr})` : ""}`,
				fullPath: norm,
				isCurrent,
			};
		});

		this.cachedCandidates = [];
		this.updateCandidates();
	}

	public getQuery(): string {
		return this.query;
	}

	public getCandidates(): CandidateItem[] {
		return this.cachedCandidates;
	}

	private isPathMode(): boolean {
		return isPathLikeQuery(this.query);
	}

	private updateCandidates(): void {
		const cleaned = cleanPathArg(this.query);

		if (this.isPathMode()) {
			const subdirs = getSubdirectories(cleaned, this.baseCwd);
			const items: CandidateItem[] = [];

			// When query ends with '/' and points to a valid directory, place the directory itself
			// at index 0 so pressing Enter after Tab-completing opens that directory directly.
			const endsWithSep = cleaned.endsWith("/") || (process.platform === "win32" && cleaned.endsWith("\\"));
			const resolvedExact = resolveTargetDir(cleaned, this.baseCwd);
			if ((endsWithSep || cleaned === "~" || cleaned === "." || cleaned === "..") && isDirectorySafe(resolvedExact)) {
				const dirName = path.basename(resolvedExact) || resolvedExact;
				items.push({
					label: `. (${dirName})`,
					detail: `${displayPath(resolvedExact)}  [Enter: open this directory]`,
					fullPath: resolvedExact,
					isCurrent: resolvedExact === this.baseCwd,
					isSelfTarget: true,
				});
			}

			for (const d of subdirs) {
				items.push({
					label: `${d.name}/`,
					detail: displayPath(d.fullPath),
					fullPath: d.fullPath,
					isCurrent: d.fullPath === this.baseCwd,
				});
			}

			this.cachedCandidates = items;
			return;
		}

		const q = cleaned.toLowerCase();
		const matchedRecents = !q
			? this.recentCandidates
			: this.recentCandidates.filter(
					(c) => c.label.toLowerCase().includes(q) || c.detail.toLowerCase().includes(q),
				);

		// Also discover nearby workspace / child / home directories so new folders not in history
		// are immediately visible and completable!
		const nearby = discoverNearbyDirectories(cleaned, this.baseCwd, this.recentPathSet).map((d) => ({
			label: `${d.name}/`,
			detail: `${displayPath(d.fullPath)}  (${d.source})`,
			fullPath: d.fullPath,
			isCurrent: false,
		}));

		this.cachedCandidates = [...matchedRecents, ...nearby];
	}

	handleInput(data: string): void {
		if (isKeyRelease(data)) return;

		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.done({ action: "cancel" });
			return;
		}

		// Allow opening Dashboard from Location Picker via Ctrl+\
		if (matchesKey(data, "ctrl+\\")) {
			this.done({ action: "open_dashboard" });
			return;
		}

		if (matchesKey(data, "up") || matchesKey(data, "ctrl+p")) {
			if (this.selectedIndex > 0) {
				this.selectedIndex--;
				this.adjustScroll();
				this.tui.requestRender();
			}
			return;
		}

		if (matchesKey(data, "down") || matchesKey(data, "ctrl+n")) {
			if (this.selectedIndex < this.cachedCandidates.length - 1) {
				this.selectedIndex++;
				this.adjustScroll();
				this.tui.requestRender();
			}
			return;
		}

		if (matchesKey(data, "pageup")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 8);
			this.adjustScroll();
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, "pagedown")) {
			this.selectedIndex = Math.min(Math.max(0, this.cachedCandidates.length - 1), this.selectedIndex + 8);
			this.adjustScroll();
			this.tui.requestRender();
			return;
		}

		// Tab completion: complete selected directory path with trailing '/' to browse subdirs
		if (matchesKey(data, "tab")) {
			let selected = this.cachedCandidates[this.selectedIndex];
			// If index 0 is the self-target (`. (dir)`) and there is a child directory, complete the first child
			if (selected?.isSelfTarget && this.cachedCandidates.length > 1) {
				selected = this.cachedCandidates[1];
			}
			if (selected) {
				let completed = displayPath(selected.fullPath);
				if (!completed.endsWith("/")) completed += "/";
				this.query = completed;
				this.selectedIndex = 0;
				this.scrollOffset = 0;
				this.error = null;
				this.updateCandidates();
				this.tui.requestRender();
			}
			return;
		}

		// Enter confirmation
		if (matchesKey(data, "return")) {
			const selected = this.cachedCandidates[this.selectedIndex];
			const target = selected ? selected.fullPath : resolveTargetDir(this.query, this.baseCwd);
			if (!target) return;

			if (!isDirectorySafe(target)) {
				this.error = `Not a directory: ${cleanPathArg(this.query) || target}`;
				this.tui.requestRender();
				return;
			}
			this.done({ action: "select", selectedDir: path.resolve(target) });
			return;
		}

		// Ctrl+U: clear entire query line
		if (matchesKey(data, "ctrl+u")) {
			if (this.query.length > 0) {
				this.query = "";
				this.selectedIndex = 0;
				this.scrollOffset = 0;
				this.error = null;
				this.updateCandidates();
				this.tui.requestRender();
			}
			return;
		}

		// Ctrl+W or Alt+Backspace: delete last path segment backward
		if (matchesKey(data, "ctrl+w") || matchesKey(data, "alt+backspace")) {
			if (this.query.length > 0) {
				this.query = deletePathSegmentBackward(this.query);
				this.selectedIndex = 0;
				this.scrollOffset = 0;
				this.error = null;
				this.updateCandidates();
				this.tui.requestRender();
			}
			return;
		}

		// Backspace
		if (matchesKey(data, "backspace")) {
			if (this.query.length > 0) {
				this.query = this.query.slice(0, -1);
				this.selectedIndex = 0;
				this.scrollOffset = 0;
				this.error = null;
				this.updateCandidates();
				this.tui.requestRender();
			}
			return;
		}

		// Printable character input (supports Kitty CSI-u, paste, and UTF-8)
		const printable = extractPrintableInput(data);
		if (printable !== undefined) {
			this.query += printable;
			this.selectedIndex = 0;
			this.scrollOffset = 0;
			this.error = null;
			this.updateCandidates();
			this.tui.requestRender();
		}
	}

	private adjustScroll(): void {
		const visibleRows = 9;
		if (this.selectedIndex < this.scrollOffset) {
			this.scrollOffset = this.selectedIndex;
		} else if (this.selectedIndex >= this.scrollOffset + visibleRows) {
			this.scrollOffset = this.selectedIndex - visibleRows + 1;
		}
	}

	render(width: number): string[] {
		const th = this.theme;
		const lines: string[] = [];
		const modalW = Math.max(40, Math.min(width, 76));

		const pad = (str: string, len: number) => {
			const vw = visibleWidth(str);
			return str + " ".repeat(Math.max(0, len - vw));
		};

		const row = (content: string) => {
			const inner = pad(content, modalW - 4);
			return `  ${th.fg("border", "│")} ${inner} ${th.fg("border", "│")}`;
		};

		const div = (label?: string) => {
			if (!label) {
				return `  ${th.fg("border", `├${"─".repeat(modalW - 2)}┤`)}`;
			}
			const l = ` ${label} `;
			const rem = Math.max(0, modalW - 4 - visibleWidth(l));
			return `  ${th.fg("border", `├─`)}${l}${th.fg("border", `${"─".repeat(rem)}┤`)}`;
		};

		// Top border
		lines.push("");
		const title = ` ${th.bold(th.fg("accent", "Change Working Directory"))} `;
		const topRem = Math.max(0, modalW - 4 - visibleWidth(title));
		lines.push(`  ${th.fg("border", `╭─`)}${title}${th.fg("border", `${"─".repeat(topRem)}╮`)}`);

		// Current CWD row (uses cached branch)
		const branchStr = this.branch ? th.fg("muted", ` (${this.branch})`) : "";
		lines.push(row(`${th.fg("dim", "current:")} ${th.fg("text", displayPath(this.baseCwd))}${branchStr}`));

		// Path input field with placeholder hint when empty
		const inputPrefix = th.fg("accent", "path: ");
		const placeholder = !this.query ? th.fg("dim", "type path (~/, ../, /) or name, Tab to complete") : "";
		const queryDisplay = `${th.fg("text", this.query)}${CURSOR_MARKER}${placeholder}`;
		lines.push(row(truncateToWidth(`${inputPrefix}${queryDisplay}`, modalW - 4)));

		// Error line or divider
		if (this.error) {
			lines.push(div(th.fg("error", `✗ ${this.error}`)));
		} else {
			const modeLabel = this.isPathMode() ? "Path Completion (Tab: drill down • Ctrl+W: up)" : "Recent & Workspace Directories (Tab: complete)";
			lines.push(div(th.fg("dim", modeLabel)));
		}

		// Candidate rows
		const visibleRows = 9;
		const candidates = this.cachedCandidates;

		if (candidates.length === 0) {
			lines.push(row(th.fg("dim", "  (no matching directories — press Enter to try typed path)")));
			for (let i = 1; i < visibleRows; i++) {
				lines.push(row(""));
			}
		} else {
			const slice = candidates.slice(this.scrollOffset, this.scrollOffset + visibleRows);
			for (let i = 0; i < visibleRows; i++) {
				const itemIndex = this.scrollOffset + i;
				const c = slice[i];
				if (!c) {
					lines.push(row(""));
					continue;
				}
				const isSel = itemIndex === this.selectedIndex;
				const pointer = isSel ? th.fg("accent", "❯ ") : "  ";
				const labelColor = c.isSelfTarget ? "success" : "text";
				const label = isSel ? th.bold(th.fg("accent", c.label)) : th.fg(labelColor, c.label);
				const detail = isSel ? th.fg("text", c.detail) : th.fg("muted", c.detail);

				const content = `${pointer}${label}  ${detail}`;
				lines.push(row(truncateToWidth(content, modalW - 4)));
			}
		}

		// Footer
		lines.push(
			div(
				th.fg("dim", "↑↓ nav • Tab complete • Ctrl+W up • Enter select • Esc close"),
			),
		);
		lines.push(`  ${th.fg("border", `╰${"─".repeat(modalW - 2)}╯`)}`);
		lines.push("");

		return lines.map((l) => truncateToWidth(l, width));
	}

	invalidate(): void {}
}

// ============================================================================
// Dashboard Modal Component (with "+ New Session", "Switch Directory", & Path Completion)
// ============================================================================

export interface DashboardResult {
	action: "new" | "attach" | "open_location_picker" | "select_dir" | "cancel";
	session?: SessionInfo;
	selectedDir?: string;
}

interface IndexedSession {
	info: SessionInfo;
	isCurrentProject: boolean;
	isActiveSession: boolean;
	displayTitle: string;
	displayPath: string;
	displayTime: string;
	msgCountStr: string;
	searchKey: string;
}

type DashboardRowItem =
	| { kind: "new_session" }
	| { kind: "open_location_picker" }
	| { kind: "directory"; label: string; detail: string; fullPath: string; isSelfTarget?: boolean }
	| { kind: "session"; session: IndexedSession };

export class DashboardComponent implements Component, Focusable {
	focused = true;
	private tui: TUI;
	private indexedSessions: IndexedSession[];
	private rows: DashboardRowItem[] = [];
	private currentCwd: string;
	private branch: string | null;
	private allCount: number;
	private cwdCount: number;
	private query = "";
	private scope: "all" | "cwd" = "all";
	private selectedIndex = 0;
	private scrollOffset = 0;
	private theme: Theme;
	private done: (result: DashboardResult) => void;

	constructor(
		tui: TUI,
		sessions: SessionInfo[],
		currentSessionFile: string | undefined,
		currentCwd: string,
		theme: Theme,
		done: (result: DashboardResult) => void,
	) {
		this.tui = tui;
		this.currentCwd = path.resolve(currentCwd);
		this.branch = getGitBranch(this.currentCwd);
		this.theme = theme;
		this.done = done;

		// Pre-process and index all sessions once
		this.indexedSessions = sessions.map((s) => {
			const sessionResolvedCwd = path.resolve(s.cwd || "");
			const isCurrentProject = sessionResolvedCwd === this.currentCwd;
			const isActiveSession = s.path === currentSessionFile;

			let titleText = s.name || (s.firstMessage ? s.firstMessage.split("\n")[0].trim() : s.id.slice(0, 8));
			titleText = titleText.slice(0, 32);

			const sPath = displayPath(s.cwd || "");
			const sTime = formatRelativeTime(s.modified);
			const msgStr = `${s.messageCount} msg${s.messageCount === 1 ? "" : "s"}`;

			const searchKey = `${s.name || ""} ${s.firstMessage || ""} ${s.cwd || ""} ${s.id}`.toLowerCase();

			return {
				info: s,
				isCurrentProject,
				isActiveSession,
				displayTitle: titleText,
				displayPath: sPath,
				displayTime: sTime,
				msgCountStr: msgStr,
				searchKey,
			};
		});

		this.allCount = this.indexedSessions.length;
		this.cwdCount = this.indexedSessions.filter((s) => s.isCurrentProject).length;
		this.rebuildRows();
	}

	public getQuery(): string {
		return this.query;
	}

	private rebuildRows(): void {
		const cleaned = cleanPathArg(this.query);
		const q = cleaned.toLowerCase();
		const nextRows: DashboardRowItem[] = [];

		if (!cleaned) {
			nextRows.push({ kind: "new_session" });
			nextRows.push({ kind: "open_location_picker" });
			for (const s of this.indexedSessions) {
				if (this.scope === "cwd" && !s.isCurrentProject) continue;
				nextRows.push({ kind: "session", session: s });
			}
			this.rows = nextRows;
			return;
		}

		// If the user types a path (/, ~, ., or contains /), provide live directory completion right inside Dashboard!
		if (isPathLikeQuery(cleaned)) {
			const endsWithSep = cleaned.endsWith("/") || (process.platform === "win32" && cleaned.endsWith("\\"));
			const resolvedExact = resolveTargetDir(cleaned, this.currentCwd);
			if ((endsWithSep || cleaned === "~" || cleaned === "." || cleaned === "..") && isDirectorySafe(resolvedExact)) {
				const dirName = path.basename(resolvedExact) || resolvedExact;
				nextRows.push({
					kind: "directory",
					label: `. (${dirName})`,
					detail: `${displayPath(resolvedExact)}  [Enter: switch to this directory]`,
					fullPath: resolvedExact,
					isSelfTarget: true,
				});
			}

			const subdirs = getSubdirectories(cleaned, this.currentCwd);
			for (const d of subdirs) {
				nextRows.push({
					kind: "directory",
					label: `${d.name}/`,
					detail: `${displayPath(d.fullPath)}  [Tab: complete • Enter: switch]`,
					fullPath: d.fullPath,
				});
			}
		}

		// Matching sessions
		const matchedSessionDirs = new Set<string>([this.currentCwd]);
		for (const s of this.indexedSessions) {
			if (this.scope === "cwd" && !s.isCurrentProject) continue;
			if (s.searchKey.includes(q)) {
				nextRows.push({ kind: "session", session: s });
				if (s.info.cwd) matchedSessionDirs.add(path.resolve(s.info.cwd));
			}
		}

		// Also discover matching workspace/nearby directories when typing a plain name (e.g. "zcode")
		if (!isPathLikeQuery(cleaned)) {
			const nearby = discoverNearbyDirectories(cleaned, this.currentCwd, matchedSessionDirs);
			for (const d of nearby) {
				nextRows.push({
					kind: "directory",
					label: `${d.name}/`,
					detail: `${displayPath(d.fullPath)}  (${d.source} • Tab: complete • Enter: switch)`,
					fullPath: d.fullPath,
				});
			}
		}

		this.rows = nextRows;
	}

	handleInput(data: string): void {
		if (isKeyRelease(data)) return;

		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.done({ action: "cancel" });
			return;
		}

		// Open location picker right from dashboard (Ctrl+L)
		if (matchesKey(data, "ctrl+l")) {
			this.done({ action: "open_location_picker" });
			return;
		}

		const totalCount = this.rows.length;
		const currentRow = this.rows[this.selectedIndex];

		// Tab: if a directory row is selected (or in path mode), autocomplete the directory path!
		// Otherwise toggle scope between All Projects and Current Project.
		if (matchesKey(data, "tab")) {
			if (currentRow?.kind === "directory") {
				let targetRow = currentRow;
				if (targetRow.isSelfTarget && this.rows[1]?.kind === "directory") {
					targetRow = this.rows[1];
				}
				let completed = displayPath(targetRow.fullPath);
				if (!completed.endsWith("/")) completed += "/";
				this.query = completed;
				this.selectedIndex = 0;
				this.scrollOffset = 0;
				this.rebuildRows();
				this.tui.requestRender();
				return;
			}
			this.scope = this.scope === "all" ? "cwd" : "all";
			this.selectedIndex = 0;
			this.scrollOffset = 0;
			this.rebuildRows();
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, "up") || matchesKey(data, "ctrl+p")) {
			if (this.selectedIndex > 0) {
				this.selectedIndex--;
				this.adjustScroll();
				this.tui.requestRender();
			}
			return;
		}

		if (matchesKey(data, "down") || matchesKey(data, "ctrl+n")) {
			if (this.selectedIndex < totalCount - 1) {
				this.selectedIndex++;
				this.adjustScroll();
				this.tui.requestRender();
			}
			return;
		}

		if (matchesKey(data, "pageup")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 10);
			this.adjustScroll();
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, "pagedown")) {
			this.selectedIndex = Math.min(Math.max(0, totalCount - 1), this.selectedIndex + 10);
			this.adjustScroll();
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, "return")) {
			if (!currentRow) {
				// If user typed a direct valid directory path with no row match
				const directTarget = resolveTargetDir(this.query, this.currentCwd);
				if (directTarget && isDirectorySafe(directTarget)) {
					this.done({ action: "select_dir", selectedDir: directTarget });
				}
				return;
			}
			if (currentRow.kind === "new_session") {
				this.done({ action: "new" });
				return;
			}
			if (currentRow.kind === "open_location_picker") {
				this.done({ action: "open_location_picker" });
				return;
			}
			if (currentRow.kind === "directory") {
				this.done({ action: "select_dir", selectedDir: currentRow.fullPath });
				return;
			}
			if (currentRow.kind === "session") {
				this.done({ action: "attach", session: currentRow.session.info });
				return;
			}
			return;
		}

		// Ctrl+U: clear query
		if (matchesKey(data, "ctrl+u")) {
			if (this.query.length > 0) {
				this.query = "";
				this.selectedIndex = 0;
				this.scrollOffset = 0;
				this.rebuildRows();
				this.tui.requestRender();
			}
			return;
		}

		// Ctrl+W / Alt+Backspace: delete path segment or word backward
		if (matchesKey(data, "ctrl+w") || matchesKey(data, "alt+backspace")) {
			if (this.query.length > 0) {
				this.query = deletePathSegmentBackward(this.query);
				this.selectedIndex = 0;
				this.scrollOffset = 0;
				this.rebuildRows();
				this.tui.requestRender();
			}
			return;
		}

		if (matchesKey(data, "backspace")) {
			if (this.query.length > 0) {
				this.query = this.query.slice(0, -1);
				this.selectedIndex = 0;
				this.scrollOffset = 0;
				this.rebuildRows();
				this.tui.requestRender();
			}
			return;
		}

		// Printable character input (supports Kitty CSI-u, paste, and UTF-8)
		const printable = extractPrintableInput(data);
		if (printable !== undefined) {
			this.query += printable;
			this.selectedIndex = 0;
			this.scrollOffset = 0;
			this.rebuildRows();
			this.tui.requestRender();
		}
	}

	private adjustScroll(): void {
		const visibleRows = 11;
		if (this.selectedIndex < this.scrollOffset) {
			this.scrollOffset = this.selectedIndex;
		} else if (this.selectedIndex >= this.scrollOffset + visibleRows) {
			this.scrollOffset = this.selectedIndex - visibleRows + 1;
		}
	}

	render(width: number): string[] {
		const th = this.theme;
		const lines: string[] = [];
		const modalW = Math.max(50, Math.min(width, 86));

		const pad = (str: string, len: number) => {
			const vw = visibleWidth(str);
			return str + " ".repeat(Math.max(0, len - vw));
		};

		const row = (content: string) => {
			const inner = pad(content, modalW - 4);
			return `  ${th.fg("border", "│")} ${inner} ${th.fg("border", "│")}`;
		};

		const div = (label?: string) => {
			if (!label) {
				return `  ${th.fg("border", `├${"─".repeat(modalW - 2)}┤`)}`;
			}
			const l = ` ${label} `;
			const rem = Math.max(0, modalW - 4 - visibleWidth(l));
			return `  ${th.fg("border", `├─`)}${l}${th.fg("border", `${"─".repeat(rem)}┤`)}`;
		};

		// Header
		lines.push("");
		const title = ` ${th.bold(th.fg("accent", "Pi Agent Dashboard"))} `;
		const topRem = Math.max(0, modalW - 4 - visibleWidth(title));
		lines.push(`  ${th.fg("border", `╭─`)}${title}${th.fg("border", `${"─".repeat(topRem)}╮`)}`);

		// CWD Info bar (uses cached branch)
		const branchStr = this.branch ? th.fg("muted", ` (${this.branch})`) : "";
		lines.push(row(`${th.fg("dim", "cwd:")} ${th.fg("text", displayPath(this.currentCwd))}${branchStr}`));

		// Scope & Search bar
		const scopePill =
			this.scope === "all"
				? `${th.bold(th.fg("accent", `[All (${this.allCount})]`))} ${th.fg("dim", `Cur (${this.cwdCount})`)}`
				: `${th.fg("dim", `All (${this.allCount})`)} ${th.bold(th.fg("accent", `[Cur (${this.cwdCount})]`))}`;

		const placeholder = !this.query ? th.fg("dim", "filter or type ~/path") : "";
		const searchStr = `${th.fg("accent", "search: ")}${th.fg("text", this.query)}${CURSOR_MARKER}${placeholder}`;
		const leftW = visibleWidth(searchStr);
		const rightW = visibleWidth(scopePill);
		const gap = Math.max(2, modalW - 4 - leftW - rightW);
		lines.push(row(truncateToWidth(`${searchStr}${" ".repeat(gap)}${scopePill}`, modalW - 4)));

		lines.push(div());

		// Rows Table
		const visibleRows = 11;
		const totalCount = this.rows.length;

		if (totalCount === 0) {
			lines.push(row(th.fg("dim", "  (no matching sessions or directories)")));
			for (let i = 1; i < visibleRows; i++) {
				lines.push(row(""));
			}
		} else {
			const sliceStart = this.scrollOffset;
			for (let i = 0; i < visibleRows; i++) {
				const itemIndex = sliceStart + i;
				const item = this.rows[itemIndex];
				if (!item) {
					lines.push(row(""));
					continue;
				}

				const isSel = itemIndex === this.selectedIndex;
				const pointer = isSel ? th.fg("accent", "❯ ") : "  ";

				if (item.kind === "new_session") {
					const newLabel = isSel ? th.bold(th.fg("accent", "+ New Session")) : th.fg("success", "+ New Session");
					const newDetail = isSel
						? th.fg("text", `Start fresh in ${displayPath(this.currentCwd)}`)
						: th.fg("dim", `Start fresh in ${displayPath(this.currentCwd)}`);
					const leftPart = `${pointer}${newLabel}`;
					const availMid = Math.max(1, modalW - 4 - visibleWidth(leftPart) - visibleWidth(newDetail));
					lines.push(row(truncateToWidth(`${leftPart}${" ".repeat(availMid)}${newDetail}`, modalW - 4)));
				} else if (item.kind === "open_location_picker") {
					const locLabel = isSel
						? th.bold(th.fg("accent", "⇄ Switch Working Directory..."))
						: th.fg("accent", "⇄ Switch Working Directory...");
					const locDetail = isSel
						? th.fg("text", "Browse or Tab-complete any folder (Ctrl+L)")
						: th.fg("dim", "Browse or Tab-complete any folder (Ctrl+L)");
					const leftPart = `${pointer}${locLabel}`;
					const availMid = Math.max(1, modalW - 4 - visibleWidth(leftPart) - visibleWidth(locDetail));
					lines.push(row(truncateToWidth(`${leftPart}${" ".repeat(availMid)}${locDetail}`, modalW - 4)));
				} else if (item.kind === "directory") {
					const icon = th.fg("accent", "📁 ");
					const labelFormatted = isSel
						? th.bold(th.fg("accent", item.label))
						: th.fg(item.isSelfTarget ? "success" : "text", item.label);
					const detailFormatted = isSel ? th.fg("text", item.detail) : th.fg("muted", item.detail);
					const content = `${pointer}${icon}${labelFormatted}  ${detailFormatted}`;
					lines.push(row(truncateToWidth(content, modalW - 4)));
				} else {
					const s = item.session;
					const activeDot = s.isActiveSession ? th.fg("success", "● ") : th.fg("dim", "○ ");
					const titleFormatted = isSel ? th.bold(th.fg("accent", s.displayTitle)) : th.fg("text", s.displayTitle);
					const dirFormatted = isSel ? th.fg("text", s.displayPath) : th.fg("muted", s.displayPath);
					const timeFormatted = th.fg("dim", s.displayTime);
					const msgCount = th.fg("dim", s.msgCountStr);

					const leftPart = `${pointer}${activeDot}${titleFormatted}`;
					const midPart = `  ${dirFormatted}`;
					const rightPart = `  ${timeFormatted}  ${msgCount}`;

					const availableMid = modalW - 6 - visibleWidth(leftPart) - visibleWidth(rightPart);
					let lineContent = leftPart;
					if (availableMid > 4) {
						lineContent += truncateToWidth(midPart, availableMid);
					}
					const currentW = visibleWidth(lineContent);
					const rightPad = Math.max(0, modalW - 4 - currentW - visibleWidth(rightPart));
					lineContent += " ".repeat(rightPad) + rightPart;

					lines.push(row(lineContent));
				}
			}
		}

		// Footer
		lines.push(
			div(
				th.fg("dim", "↑↓ nav • Enter select • Tab complete/scope • Ctrl+L location • Esc close"),
			),
		);
		lines.push(`  ${th.fg("border", `╰${"─".repeat(modalW - 2)}╯`)}`);
		lines.push("");

		return lines.map((l) => truncateToWidth(l, width));
	}

	invalidate(): void {}
}

// ============================================================================
// Core Execution Logic
// ============================================================================

/** Handle switching to a target directory with "+ New Session" or recent session choices */
export async function handleTargetDirectorySelection(
	targetDir: string,
	ctx: ExtensionContext,
	tui?: TUI,
): Promise<void> {
	const resolvedTarget = resolveTargetDir(targetDir, ctx.cwd);

	if (!resolvedTarget || !isDirectorySafe(resolvedTarget)) {
		ctx.ui.notify(`Not a directory: ${resolvedTarget || targetDir}`, "error");
		return;
	}

	// Read existing sessions in the target directory
	const existing = await SessionManager.list(resolvedTarget).catch(() => []);

	// If directory has no previous sessions, directly start a new session
	if (existing.length === 0) {
		await createAndSwitchNewSession(resolvedTarget, ctx, tui);
		return;
	}

	// If directory has existing sessions, present choice modal with "+ New Session" at the top
	let activeTuiRef: TUI | undefined;
	const choice = await ctx.ui.custom<SessionChoiceResult>((customTui, theme, _kb, done) => {
		activeTuiRef = customTui;
		registerDashboardTui(customTui);
		return new SessionChoiceComponent(customTui, resolvedTarget, existing, theme, done);
	});

	if (choice.action === "new") {
		await createAndSwitchNewSession(resolvedTarget, ctx, activeTuiRef ?? tui);
	} else if (choice.action === "attach" && choice.session) {
		const switched = await executeSessionSwitch(choice.session.path, resolvedTarget, activeTuiRef ?? tui);
		if (switched) {
			ctx.ui.notify(`Switched to session in ${displayPath(resolvedTarget)}`, "info");
		} else {
			ctx.ui.notify(`Failed to switch session in ${displayPath(resolvedTarget)}`, "error");
		}
	}
}

/** Open the interactive Location Picker modal and handle directory change */
export async function openLocationPicker(ctx: ExtensionContext): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("Location picker requires interactive TUI mode", "error");
		return;
	}

	const allSessions = await SessionManager.listAll().catch(() => []);
	const recentDirs = collectRecentDirs(allSessions, ctx.cwd);

	let activeTuiRef: TUI | undefined;
	const result = await ctx.ui.custom<LocationPickerResult>((tui, theme, _kb, done) => {
		activeTuiRef = tui;
		registerDashboardTui(tui);
		return new LocationPickerComponent(tui, ctx.cwd, recentDirs, theme, done);
	});

	if (result.action === "open_dashboard") {
		await openDashboard(ctx);
		return;
	}

	if (result.action === "select" && result.selectedDir) {
		await handleTargetDirectorySelection(result.selectedDir, ctx, activeTuiRef);
	}
}

/** Open the interactive Dashboard modal and handle session attach, new, or location pick */
export async function openDashboard(ctx: ExtensionContext): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("Dashboard requires interactive TUI mode", "error");
		return;
	}

	const allSessions = await SessionManager.listAll().catch(() => []);
	const currentSessionFile = ctx.sessionManager.getSessionFile();

	let activeTuiRef: TUI | undefined;
	const result = await ctx.ui.custom<DashboardResult>((tui, theme, _kb, done) => {
		activeTuiRef = tui;
		registerDashboardTui(tui);
		return new DashboardComponent(tui, allSessions, currentSessionFile, ctx.cwd, theme, done);
	});

	if (result.action === "open_location_picker") {
		await openLocationPicker(ctx);
		return;
	}

	if (result.action === "select_dir" && result.selectedDir) {
		await handleTargetDirectorySelection(result.selectedDir, ctx, activeTuiRef);
		return;
	}

	if (result.action === "new") {
		await createAndSwitchNewSession(ctx.cwd, ctx, activeTuiRef);
		return;
	}

	if (result.action === "attach" && result.session) {
		const targetSession = result.session;
		if (targetSession.path === currentSessionFile) {
			ctx.ui.notify("Already in this session", "info");
			return;
		}

		const switched = await executeSessionSwitch(targetSession.path, targetSession.cwd, activeTuiRef);
		if (switched) {
			ctx.ui.notify(`Switched to session in ${displayPath(targetSession.cwd)}`, "info");
		} else {
			ctx.ui.notify(`Failed to switch to session: ${displayPath(targetSession.path)}`, "error");
		}
	}
}

// ============================================================================
// Extension Registration
// ============================================================================

export function installDashboardCommands(pi: ExtensionAPI): void {
	// Register /dashboard slash command
	pi.registerCommand("dashboard", {
		description: "Open the interactive Agent Dashboard (session selector & switcher)",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			lastCommandCtx = ctx;
			await openDashboard(ctx);
		},
	});

	// Alias /db for convenience
	pi.registerCommand("db", {
		description: "Alias for /dashboard",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			lastCommandCtx = ctx;
			await openDashboard(ctx);
		},
	});

	// Register /cd slash command with live directory argument completions
	pi.registerCommand("cd", {
		description: "Change working directory (/cd opens Location Picker, /cd <path> switches directly)",
		getArgumentCompletions: (argumentPrefix: string) => {
			const cwd = process.cwd();
			const subdirs = getSubdirectories(argumentPrefix, cwd);
			if (subdirs.length === 0) return null;
			return subdirs.slice(0, 50).map((d) => {
				const disp = `${displayPath(d.fullPath)}/`;
				return {
					value: disp,
					label: `${d.name}/`,
					description: disp,
				};
			});
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			lastCommandCtx = ctx;
			const cleaned = cleanPathArg(args);
			if (!cleaned) {
				await openLocationPicker(ctx);
			} else {
				const resolved = resolveTargetDir(cleaned, ctx.cwd);
				await handleTargetDirectorySelection(resolved, ctx);
			}
		},
	});

	// Register shortcuts if supported by host
	if (typeof pi.registerShortcut === "function") {
		// Register Ctrl+L shortcut for Location Picker
		pi.registerShortcut("ctrl+l", {
			description: "Location Picker: change working directory (recent projects / path completion)",
			handler: async (ctx: ExtensionContext) => {
				await openLocationPicker(ctx);
			},
		});

		// Register Ctrl+\ shortcut for Dashboard (mirroring grok-build)
		pi.registerShortcut("ctrl+\\", {
			description: "Open Pi Agent Dashboard",
			handler: async (ctx: ExtensionContext) => {
				await openDashboard(ctx);
			},
		});
	}
}
