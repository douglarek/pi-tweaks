/**
 * Pi Dashboard & Location Picker Extension for pi-tweaks
 *
 * Modeled after grok-build's Dashboard and Ctrl+L Location Picker:
 * - /dashboard (or /db, Ctrl+\): Interactive dashboard showing historical sessions across projects,
 *   with "+ New Session" at the top, live fuzzy filtering, project scope toggling, and instant session attachment.
 * - /cd [path]: Change working directory for Pi. Without arguments, opens the Location Picker modal.
 * - Ctrl+L: Opens the Location Picker directly from the editor or within the Dashboard.
 *
 * UX enhancements:
 * - When switching workspace, shows target directory's sessions with "+ New Session" at the very top.
 * - Users can hit Enter immediately to start fresh, or press Down to select recent conversations.
 * - Instant session and directory switching upon Enter (no manual /cd typing in the input box).
 * - Multi-strategy switch execution (command context, active session, resolved component tree).
 * - Robust path argument cleaning (handles surrounding quotes cleanly).
 * - Zero synchronous disk I/O in the render/navigation loop.
 * - Instant 60fps keyboard navigation with immediate TUI render scheduling.
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
	type Focusable,
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
	return cleaned;
}

/** Resolve target directory path reliably against cwd */
export function resolveTargetDir(rawPath: string, baseCwd: string): string {
	const cleaned = cleanPathArg(rawPath);
	if (!cleaned) return "";
	const expanded = expandTilde(cleaned);
	return path.isAbsolute(expanded) ? expanded : path.resolve(baseCwd, expanded);
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
		try {
			if (!fs.existsSync(s.cwd)) continue;
		} catch {
			continue;
		}
		const ts = new Date(s.modified).getTime();
		const prev = latestByDir.get(s.cwd) ?? 0;
		if (ts > prev) {
			latestByDir.set(s.cwd, ts);
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

/** List subdirectories for path completion mode */
export function getSubdirectories(query: string, baseCwd: string): Array<{ name: string; fullPath: string }> {
	const cleaned = cleanPathArg(query);
	const expanded = expandTilde(cleaned);
	const endsWithSep = cleaned.endsWith("/") || (process.platform === "win32" && cleaned.endsWith("\\"));

	let parentDir: string;
	let partial: string;

	if (endsWithSep) {
		parentDir = path.isAbsolute(expanded) ? expanded : path.resolve(baseCwd, expanded);
		partial = "";
	} else {
		const target = path.isAbsolute(expanded) ? expanded : path.resolve(baseCwd, expanded);
		parentDir = path.dirname(target);
		partial = path.basename(target).toLowerCase();
	}

	if (!fs.existsSync(parentDir)) return [];
	try {
		const stat = fs.statSync(parentDir);
		if (!stat.isDirectory()) return [];
		const entries = fs.readdirSync(parentDir, { withFileTypes: true });
		return entries
			.filter((e) => e.isDirectory() && (!e.name.startsWith(".") || partial.startsWith(".")))
			.filter((e) => !partial || e.name.toLowerCase().startsWith(partial))
			.sort((a, b) => a.name.localeCompare(b.name))
			.map((e) => ({
				name: e.name,
				fullPath: path.join(parentDir, e.name),
			}));
	} catch {
		return [];
	}
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

		// Pre-compute recent items once
		this.recentCandidates = recentDirs.map((d) => {
			const isCurrent = d.path === this.baseCwd;
			const name = path.basename(d.path) || d.path;
			const timeStr = isCurrent ? "(current)" : formatRelativeTime(d.lastActive);
			return {
				label: name,
				detail: `${displayPath(d.path)}  ${timeStr ? `(${timeStr})` : ""}`,
				fullPath: d.path,
				isCurrent,
			};
		});

		this.cachedCandidates = this.recentCandidates;
	}

	private isPathMode(): boolean {
		const q = cleanPathArg(this.query);
		return q.startsWith("/") || q.startsWith("~") || q.startsWith(".") || q.includes("/");
	}

	private updateCandidates(): void {
		if (this.isPathMode()) {
			const subdirs = getSubdirectories(this.query.trim(), this.baseCwd);
			this.cachedCandidates = subdirs.map((d) => ({
				label: d.name,
				detail: displayPath(d.fullPath),
				fullPath: d.fullPath,
				isCurrent: d.fullPath === this.baseCwd,
			}));
			return;
		}

		const q = cleanPathArg(this.query).toLowerCase();
		if (!q) {
			this.cachedCandidates = this.recentCandidates;
			return;
		}

		this.cachedCandidates = this.recentCandidates.filter((c) => {
			return c.label.toLowerCase().includes(q) || c.detail.toLowerCase().includes(q);
		});
	}

	handleInput(data: string): void {
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

		// Tab completion
		if (matchesKey(data, "tab")) {
			const selected = this.cachedCandidates[this.selectedIndex];
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

			if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
				this.error = `Not a directory: ${cleanPathArg(this.query)}`;
				this.tui.requestRender();
				return;
			}
			this.done({ action: "select", selectedDir: path.resolve(target) });
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

		// Printable character input
		if (data.length === 1 && data.charCodeAt(0) >= 32) {
			this.query += data;
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

		// Path input field
		const inputPrefix = th.fg("accent", "path: ");
		const queryDisplay = this.query + CURSOR_MARKER;
		lines.push(row(`${inputPrefix}${th.fg("text", queryDisplay)}`));

		// Error line or divider
		if (this.error) {
			lines.push(div(th.fg("error", `✗ ${this.error}`)));
		} else {
			const modeLabel = this.isPathMode() ? "Path Completion" : "Recent Projects";
			lines.push(div(th.fg("dim", modeLabel)));
		}

		// Candidate rows
		const visibleRows = 9;
		const candidates = this.cachedCandidates;

		if (candidates.length === 0) {
			lines.push(row(th.fg("dim", "  (no matching directories)")));
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
				const label = isSel ? th.bold(th.fg("accent", c.label)) : th.fg("text", c.label);
				const detail = isSel ? th.fg("text", c.detail) : th.fg("muted", c.detail);

				const content = `${pointer}${label}  ${detail}`;
				lines.push(row(truncateToWidth(content, modalW - 4)));
			}
		}

		// Footer
		lines.push(
			div(
				th.fg("dim", "↑↓ nav  •  Tab complete  •  Enter select  •  Ctrl+\\ dashboard  •  Esc close"),
			),
		);
		lines.push(`  ${th.fg("border", `╰${"─".repeat(modalW - 2)}╯`)}`);
		lines.push("");

		return lines.map((l) => truncateToWidth(l, width));
	}

	invalidate(): void {}
}

// ============================================================================
// Dashboard Modal Component (with "+ New Session" at the top)
// ============================================================================

export interface DashboardResult {
	action: "new" | "attach" | "open_location_picker" | "cancel";
	session?: SessionInfo;
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

export class DashboardComponent implements Component, Focusable {
	focused = true;
	private tui: TUI;
	private indexedSessions: IndexedSession[];
	private filteredSessions: IndexedSession[];
	private currentCwd: string;
	private branch: string | null;
	private allCount: number;
	private cwdCount: number;
	private query = "";
	private scope: "all" | "cwd" = "all";
	private selectedIndex = 0; // 0 is "+ New Session" when query is empty, else session index
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
		this.filteredSessions = this.indexedSessions;
	}

	private hasNewItem(): boolean {
		return cleanPathArg(this.query) === "";
	}

	private getTotalCount(): number {
		return (this.hasNewItem() ? 1 : 0) + this.filteredSessions.length;
	}

	private updateFilteredSessions(): void {
		const q = cleanPathArg(this.query).toLowerCase();
		this.filteredSessions = this.indexedSessions.filter((s) => {
			if (this.scope === "cwd" && !s.isCurrentProject) return false;
			if (!q) return true;
			return s.searchKey.includes(q);
		});
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.done({ action: "cancel" });
			return;
		}

		// Open location picker right from dashboard (Ctrl+L)
		if (matchesKey(data, "ctrl+l")) {
			this.done({ action: "open_location_picker" });
			return;
		}

		// Toggle scope between All Projects and Current Project
		if (matchesKey(data, "tab")) {
			this.scope = this.scope === "all" ? "cwd" : "all";
			this.selectedIndex = 0;
			this.scrollOffset = 0;
			this.updateFilteredSessions();
			this.tui.requestRender();
			return;
		}

		const totalCount = this.getTotalCount();

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
			if (this.hasNewItem() && this.selectedIndex === 0) {
				this.done({ action: "new" });
				return;
			}
			const sessionIdx = this.hasNewItem() ? this.selectedIndex - 1 : this.selectedIndex;
			const selected = this.filteredSessions[sessionIdx];
			if (selected) {
				this.done({ action: "attach", session: selected.info });
			}
			return;
		}

		if (matchesKey(data, "backspace")) {
			if (this.query.length > 0) {
				this.query = this.query.slice(0, -1);
				this.selectedIndex = 0;
				this.scrollOffset = 0;
				this.updateFilteredSessions();
				this.tui.requestRender();
			}
			return;
		}

		if (data.length === 1 && data.charCodeAt(0) >= 32) {
			this.query += data;
			this.selectedIndex = 0;
			this.scrollOffset = 0;
			this.updateFilteredSessions();
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
				? `${th.bold(th.fg("accent", `[All Projects (${this.allCount})]`))}  ${th.fg("dim", `Current (${this.cwdCount})`)}`
				: `${th.fg("dim", `All (${this.allCount})`)}  ${th.bold(th.fg("accent", `[Current Project (${this.cwdCount})]`))}`;

		const searchStr = `${th.fg("accent", "search: ")}${this.query}${CURSOR_MARKER}`;
		lines.push(row(`${searchStr}   ${th.fg("dim", "│")}  ${scopePill}`));

		lines.push(div());

		// Sessions Table (uses cached pre-filtered sessions)
		const visibleRows = 11;
		const totalCount = this.getTotalCount();
		const hasNew = this.hasNewItem();

		if (totalCount === 0) {
			lines.push(row(th.fg("dim", "  (no matching sessions found)")));
			for (let i = 1; i < visibleRows; i++) {
				lines.push(row(""));
			}
		} else {
			const sliceStart = this.scrollOffset;
			for (let i = 0; i < visibleRows; i++) {
				const itemIndex = sliceStart + i;
				if (itemIndex >= totalCount) {
					lines.push(row(""));
					continue;
				}

				const isSel = itemIndex === this.selectedIndex;
				const pointer = isSel ? th.fg("accent", "❯ ") : "  ";

				if (hasNew && itemIndex === 0) {
					// Top "+ New Session" item
					const newLabel = isSel ? th.bold(th.fg("accent", "+ New Session")) : th.fg("success", "+ New Session");
					const newDetail = isSel ? th.fg("text", `Start fresh in ${displayPath(this.currentCwd)}`) : th.fg("dim", `Start fresh in ${displayPath(this.currentCwd)}`);
					const leftPart = `${pointer}${newLabel}`;
					const rightPart = newDetail;
					const availMid = modalW - 6 - visibleWidth(leftPart) - visibleWidth(rightPart);
					const rightPad = Math.max(0, availMid);
					lines.push(row(`${leftPart}${" ".repeat(rightPad)}${rightPart}`));
				} else {
					const sessionIdx = hasNew ? itemIndex - 1 : itemIndex;
					const s = this.filteredSessions[sessionIdx];
					if (!s) {
						lines.push(row(""));
						continue;
					}

					const activeDot = s.isActiveSession ? th.fg("success", "● ") : th.fg("dim", "○ ");
					const titleFormatted = isSel ? th.bold(th.fg("accent", s.displayTitle)) : th.fg("text", s.displayTitle);
					const dirFormatted = isSel ? th.fg("text", s.displayPath) : th.fg("muted", s.displayPath);
					const timeFormatted = th.fg("dim", s.displayTime);
					const msgCount = th.fg("dim", s.msgCountStr);

					const leftPart = `${pointer}${activeDot}${titleFormatted}`;
					const midPart = `  ${dirFormatted}`;
					const rightPart = `  ${timeFormatted}  ${msgCount}`;

					// Compose row with right-aligned metadata
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
				th.fg("dim", "↑↓ nav • Enter select • Tab filter • Ctrl+L location • Esc close"),
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

	if (!resolvedTarget || !fs.existsSync(resolvedTarget) || !fs.statSync(resolvedTarget).isDirectory()) {
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

	// Register /cd slash command
	pi.registerCommand("cd", {
		description: "Change working directory (/cd opens Location Picker, /cd <path> switches directly)",
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
