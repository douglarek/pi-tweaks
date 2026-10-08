/**
 * Compact single-line status bar for Pi.
 *
 * Unifies the current directory, git branch, session name, token stats, cost,
 * and context usage with the model and thinking level onto a single line.
 * If the directory path is too long, shortens it with middle ellipsis while keeping
 * the git branch intact. Hovering over the path dynamically reveals the full path.
 */

import { isAbsolute, relative, resolve, sep } from "node:path";
import {
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
	type Component,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

export interface SessionStatsLike {
	usageTotals: UsageTotals;
	latestCacheHitRate?: number;
	contextUsage?: {
		tokens?: number;
		contextWindow?: number;
		percent?: number | null;
	};
}

export interface FooterComponentLike extends Component {
	session?: any;
	footerData?: any;
	autoCompactEnabled?: boolean;
	getSessionStats?: () => SessionStatsLike;
	isHovered?: boolean;
	pathHitWidth?: number;
	__originalRender?: (width: number) => string[];
	__originalHandleMouse?: (event: TuiMouseEvent) => TuiMouseEventResult | undefined;
}

/** Sanitize text for display in status lines (replaces newlines/tabs with space). */
export function sanitizeStatusText(text: string): string {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

/** Format token counts for compact footer display (e.g. 1.2k, 1.0M). */
export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

/** Format cwd with ~ replacement for home directory. */
export function formatCwdForFooter(cwd: string, home?: string): string {
	if (!home) return cwd;
	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const relativeToHome = relative(resolvedHome, resolvedCwd);
	const isInsideHome =
		relativeToHome === "" ||
		(relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));
	if (!isInsideHome) return cwd;
	return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

function truncateMiddle(str: string, maxLen: number): string {
	if (str.length <= maxLen) return str;
	if (maxLen <= 3) return "...".slice(0, maxLen);
	const ellipsis = "...";
	const keep = maxLen - ellipsis.length;
	const head = Math.ceil(keep / 2);
	const tail = Math.floor(keep / 2);
	return str.slice(0, head) + ellipsis + (tail > 0 ? str.slice(-tail) : "");
}

/**
 * Shorten path using smart middle-ellipsis while preserving key path anchors
 * (~ or root, and target directory).
 */
export function shortenPath(path: string, maxLength: number): string {
	if (visibleWidth(path) <= maxLength) return path;
	if (maxLength <= 3) return "...".slice(0, maxLength);

	const isHome = path.startsWith("~");
	const separator = path.includes("\\") ? "\\" : "/";
	const rawParts = path.split(/[\\/]/).filter(Boolean);

	if (rawParts.length <= 1) {
		return truncateMiddle(path, maxLength);
	}

	const prefix = isHome ? `~${separator}` : path.startsWith(separator) ? separator : "";
	const parts = isHome && rawParts[0] === "~" ? rawParts.slice(1) : rawParts;

	if (parts.length === 0) return path;
	if (parts.length === 1) {
		const full = `${prefix}${parts[0]}`;
		return visibleWidth(full) <= maxLength ? full : truncateMiddle(full, maxLength);
	}

	const base = parts[parts.length - 1];

	// Minimal short format: `${prefix}...${separator}${base}`
	const minShort = `${prefix}...${separator}${base}`;
	if (visibleWidth(minShort) > maxLength) {
		const evenShorter = `...${separator}${base}`;
		if (visibleWidth(evenShorter) <= maxLength) {
			return evenShorter;
		}
		const availBase = maxLength - visibleWidth(`...${separator}`);
		if (availBase >= 3) {
			return `...${separator}${truncateMiddle(base, availBase)}`;
		}
		return truncateMiddle(path, maxLength);
	}

	// Try to include as many trailing subdirectories as fit
	let best = minShort;
	for (let i = parts.length - 2; i >= 0; i--) {
		const candidate = `${prefix}...${separator}${parts.slice(i).join(separator)}`;
		if (visibleWidth(candidate) <= maxLength) {
			best = candidate;
		} else {
			break;
		}
	}

	// If at least 3 components, check if showing project root fits: `~/work/.../default`
	if (parts.length >= 3) {
		const leading = parts[0];
		const leadCandidate = `${prefix}${leading}${separator}...${separator}${base}`;
		if (visibleWidth(leadCandidate) <= maxLength) {
			best = leadCandidate;
			for (let i = parts.length - 2; i >= 1; i--) {
				const candidate = `${prefix}${leading}${separator}...${separator}${parts.slice(i).join(separator)}`;
				if (visibleWidth(candidate) <= maxLength) {
					best = candidate;
				} else {
					break;
				}
			}
		}
	}

	return best;
}

export function computeUsageTotals(entries: Iterable<any>): { totals: UsageTotals; latestCacheHitRate?: number } {
	const totals: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	let latestCacheHitRate: number | undefined;

	for (const entry of entries) {
		if (!entry) continue;
		if (entry.type === "usage" && entry.usage) {
			totals.input += entry.usage.input || 0;
			totals.output += entry.usage.output || 0;
			totals.cacheRead += entry.usage.cacheRead || 0;
			totals.cacheWrite += entry.usage.cacheWrite || 0;
			totals.cost += entry.usage.cost?.total || 0;
		} else if (entry.type === "message" && entry.message?.role === "assistant" && entry.message?.usage) {
			const u = entry.message.usage;
			totals.input += u.input || 0;
			totals.output += u.output || 0;
			totals.cacheRead += u.cacheRead || 0;
			totals.cacheWrite += u.cacheWrite || 0;
			totals.cost += u.cost?.total || 0;
			const promptTokens = (u.input || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0);
			if (promptTokens > 0) {
				latestCacheHitRate = ((u.cacheRead || 0) / promptTokens) * 100;
			}
		} else if (entry.type === "message" && entry.message?.role === "toolResult" && entry.message?.usage) {
			const u = entry.message.usage;
			totals.input += u.input || 0;
			totals.output += u.output || 0;
			totals.cacheRead += u.cacheRead || 0;
			totals.cacheWrite += u.cacheWrite || 0;
			totals.cost += u.cost?.total || 0;
		} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
			const u = entry.usage;
			totals.input += u.input || 0;
			totals.output += u.output || 0;
			totals.cacheRead += u.cacheRead || 0;
			totals.cacheWrite += u.cacheWrite || 0;
			totals.cost += u.cost?.total || 0;
		}
	}
	return { totals, latestCacheHitRate };
}

function truncateStatsParts(parts: string[], maxWidth: number): string[] {
	if (maxWidth <= 0) return [];
	const current = [...parts];
	while (current.length > 1 && visibleWidth(current.map(stripTerminalSequences).join(" ")) > maxWidth) {
		// Drop cache hit stats first, then cost, then tokens
		const cacheIndex = current.findIndex((p) => p.startsWith("CH") || p.startsWith("R") || p.startsWith("W"));
		if (cacheIndex !== -1) {
			current.splice(cacheIndex, 1);
			continue;
		}
		const costIndex = current.findIndex((p) => p.startsWith("$"));
		if (costIndex !== -1) {
			current.splice(costIndex, 1);
			continue;
		}
		const tokenIndex = current.findIndex((p) => p.startsWith("↑") || p.startsWith("↓"));
		if (tokenIndex !== -1) {
			current.splice(tokenIndex, 1);
			continue;
		}
		break;
	}
	return current;
}

/** Render a single unified status line for FooterComponent. */
export function renderCompactFooter(
	footer: FooterComponentLike,
	theme: Theme,
	width: number,
): string[] {
	const session = footer.session;
	const stats = typeof footer.getSessionStats === "function" ? footer.getSessionStats() : undefined;
	const state = session?.state ?? {};
	const model = state.model ?? session?.model;
	const autoCompactEnabled = footer.autoCompactEnabled ?? session?.autoCompactionEnabled ?? true;

	const { usageTotals, latestCacheHitRate } =
		stats ?? computeUsageTotals(session?.sessionManager?.getEntries?.() ?? []);
	const contextUsage = stats?.contextUsage ?? session?.getContextUsage?.();

	const contextWindow = contextUsage?.contextWindow ?? model?.contextWindow ?? 0;
	const contextPercentValue = contextUsage?.percent ?? 0;
	const contextPercent =
		contextUsage?.percent !== null && contextUsage?.percent !== undefined
			? contextPercentValue.toFixed(1)
			: "?";

	// CWD and home formatting
	const cwd = session?.sessionManager?.getCwd?.() ?? process.cwd();
	const home = process.env.HOME || process.env.USERPROFILE;
	const fullPath = formatCwdForFooter(cwd, home);

	// Git branch
	const branch = footer.footerData?.getGitBranch?.();
	const branchStr = branch ? ` (${branch})` : "";

	// Session name
	const sessionName = session?.sessionManager?.getSessionName?.();
	const sessionStr = sessionName ? ` • ${sessionName}` : "";

	// Build stats parts
	const statsParts: string[] = [];
	if (usageTotals.input) statsParts.push(`↑${formatTokens(usageTotals.input)}`);
	if (usageTotals.output) statsParts.push(`↓${formatTokens(usageTotals.output)}`);
	if (usageTotals.cacheRead) statsParts.push(`R${formatTokens(usageTotals.cacheRead)}`);
	if (usageTotals.cacheWrite) statsParts.push(`W${formatTokens(usageTotals.cacheWrite)}`);
	if ((usageTotals.cacheRead > 0 || usageTotals.cacheWrite > 0) && latestCacheHitRate !== undefined) {
		statsParts.push(`CH${latestCacheHitRate.toFixed(1)}%`);
	}

	const usingSubscription = model
		? model.provider === "kimi-coding" || (session?.modelRuntime?.isUsingSubscription?.(model.provider) ?? false)
		: false;
	if (usageTotals.cost || usingSubscription) {
		const costStr = `$${usageTotals.cost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`;
		statsParts.push(costStr);
	}

	const autoIndicator = autoCompactEnabled ? " (auto)" : "";
	const contextPercentDisplay =
		contextPercent === "?"
			? `?/${formatTokens(contextWindow)}${autoIndicator}`
			: `${contextPercent}%/${formatTokens(contextWindow)}${autoIndicator}`;

	let contextPercentStr: string;
	if (contextPercentValue > 90) {
		contextPercentStr = theme.fg("error", contextPercentDisplay);
	} else if (contextPercentValue > 70) {
		contextPercentStr = theme.fg("warning", contextPercentDisplay);
	} else {
		contextPercentStr = contextPercentDisplay;
	}
	statsParts.push(contextPercentStr);

	if (process.env.PI_EXPERIMENTAL === "1") {
		statsParts.push(`${theme.fg("dim", "•")} ${theme.bold(theme.fg("warning", "xp"))}`);
	}

	// Model name and thinking level on the right side
	const modelName = model?.id || "no-model";
	let rightSideWithoutProvider = modelName;
	if (model?.reasoning) {
		const thinkingLevel = state.thinkingLevel ?? session?.thinkingLevel ?? "off";
		rightSideWithoutProvider =
			thinkingLevel === "off" ? `${modelName} • thinking off` : `${modelName} • ${thinkingLevel}`;
	}
	const routed = session?.routedModel;
	if (routed) {
		const level = routed.thinkingLevel ? ` • ${routed.thinkingLevel}` : "";
		rightSideWithoutProvider += ` → ${routed.model.id}${level}`;
	}

	let rightSideWithProvider = rightSideWithoutProvider;
	const providerCount = footer.footerData?.getAvailableProviderCount?.() ?? 1;
	if (providerCount > 1 && model?.provider) {
		rightSideWithProvider = `(${model.provider}) ${rightSideWithoutProvider}`;
	}

	// Select best right side representation
	let rightSide = rightSideWithProvider;
	let rWidth = visibleWidth(rightSide);
	const minPadding = 2;

	if (rWidth + minPadding + 35 > width && rightSide !== rightSideWithoutProvider) {
		rightSide = rightSideWithoutProvider;
		rWidth = visibleWidth(rightSide);
	}
	if (rWidth > Math.max(10, width - minPadding)) {
		rightSide = truncateToWidth(rightSide, Math.max(10, width - minPadding), "");
		rWidth = visibleWidth(rightSide);
	}

	const isHovered = !!footer.isHovered;
	const fullPathWidth = visibleWidth(fullPath);
	const branchWidth = visibleWidth(branchStr);
	const sessionWidth = visibleWidth(sessionStr);
	const statsWidth = visibleWidth(statsParts.map(stripTerminalSequences).join(" "));
	const statsSepWidth = statsWidth > 0 ? 2 : 0;

	let displayedPath: string;
	let useSession = sessionStr;
	let useRight = rightSide;
	let useRightWidth = rWidth;
	let useStatsParts = statsParts;

	if (isHovered) {
		// When mouse hovers over path: show full path and keep branch intact
		displayedPath = fullPath;
		const leftHeaderWidth = fullPathWidth + branchWidth + sessionWidth;
		const needed = leftHeaderWidth + statsSepWidth + statsWidth + minPadding + useRightWidth;

		if (needed > width) {
			if (useSession) {
				useSession = "";
				const newHeaderWidth = fullPathWidth + branchWidth;
				const newNeeded = newHeaderWidth + statsSepWidth + statsWidth + minPadding + useRightWidth;
				if (newNeeded > width) {
					const remaining = width - newHeaderWidth - minPadding;
					if (remaining >= useRightWidth + statsSepWidth + 8) {
						const availStats = remaining - useRightWidth - statsSepWidth;
						useStatsParts = truncateStatsParts(statsParts, availStats);
					} else if (remaining >= 10) {
						useStatsParts = [];
						useRight = truncateToWidth(rightSide, remaining, "");
						useRightWidth = visibleWidth(useRight);
					} else {
						useStatsParts = [];
						useRight = "";
						useRightWidth = 0;
					}
				}
			} else {
				const remaining = width - (fullPathWidth + branchWidth) - minPadding;
				if (remaining >= useRightWidth + statsSepWidth + 8) {
					const availStats = remaining - useRightWidth - statsSepWidth;
					useStatsParts = truncateStatsParts(statsParts, availStats);
				} else if (remaining >= 10) {
					useStatsParts = [];
					useRight = truncateToWidth(rightSide, remaining, "");
					useRightWidth = visibleWidth(useRight);
				} else {
					useStatsParts = [];
					useRight = "";
					useRightWidth = 0;
				}
			}
		}
	} else {
		// Normal state: if line exceeds width, shorten the path; branch remains intact
		const idealNeeded = fullPathWidth + branchWidth + sessionWidth + statsSepWidth + statsWidth + minPadding + useRightWidth;

		if (idealNeeded <= width) {
			displayedPath = fullPath;
		} else {
			let availPathWidth = width - useRightWidth - minPadding - (statsWidth > 0 ? statsSepWidth + statsWidth : 0) - branchWidth - sessionWidth;
			if (availPathWidth < 12 && sessionStr) {
				availPathWidth += sessionWidth;
				useSession = "";
			}
			if (availPathWidth < 10 && useRight !== rightSideWithoutProvider) {
				useRight = rightSideWithoutProvider;
				useRightWidth = visibleWidth(useRight);
				availPathWidth = width - useRightWidth - minPadding - (statsWidth > 0 ? statsSepWidth + statsWidth : 0) - branchWidth - (useSession ? sessionWidth : 0);
			}
			displayedPath = shortenPath(fullPath, Math.max(3, availPathWidth));

			const leftNoStats = visibleWidth(displayedPath) + branchWidth + visibleWidth(useSession);
			const availForStats = width - leftNoStats - minPadding - useRightWidth;
			if (statsWidth > 0 && availForStats < statsSepWidth + statsWidth) {
				const availStats = Math.max(0, availForStats - statsSepWidth);
				useStatsParts = availStats >= 8 ? truncateStatsParts(statsParts, availStats) : [];
			}
		}
	}

	// Update hover hit area (covers directory path and git branch)
	footer.pathHitWidth = visibleWidth(displayedPath) + branchWidth;

	// Assemble styled line
	const styledPath = isHovered ? theme.fg("text", displayedPath) : theme.fg("dim", displayedPath);
	const resolvedCwd = resolve(cwd);
	const linkedPath = `\x1b]8;;file://${encodeURI(resolvedCwd)}\x07${styledPath}\x1b]8;;\x07`;
	const styledBranch = branchStr ? theme.fg("dim", branchStr) : "";
	const styledSession = useSession ? theme.fg("dim", useSession) : "";

	let styledStats = "";
	let effectiveStatsWidth = 0;
	if (useStatsParts.length > 0) {
		const styledItems = useStatsParts.map((p) => (p.includes("\x1b") ? p : theme.fg("dim", p)));
		styledStats = styledItems.join(theme.fg("dim", " "));
		effectiveStatsWidth = visibleWidth(useStatsParts.map(stripTerminalSequences).join(" "));
	}

	const leftVisibleWidth =
		visibleWidth(displayedPath) +
		branchWidth +
		visibleWidth(useSession) +
		(effectiveStatsWidth > 0 ? 2 + effectiveStatsWidth : 0);

	const paddingCount = Math.max(1, width - leftVisibleWidth - useRightWidth);
	const pad = " ".repeat(paddingCount);
	const styledRight = useRight ? theme.fg("dim", useRight) : "";
	const styledStatsSep = effectiveStatsWidth > 0 ? theme.fg("dim", "  ") : "";

	const line1 = `${linkedPath}${styledBranch}${styledSession}${styledStatsSep}${styledStats}${pad}${styledRight}`;
	const lines = [truncateToWidth(line1, width)];

	// Extension statuses (if any) placed on an extra line
	const extensionStatuses = footer.footerData?.getExtensionStatuses?.();
	if (extensionStatuses && extensionStatuses.size > 0) {
		const sorted = Array.from(extensionStatuses.entries())
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([, text]) => sanitizeStatusText(text));
		const statusLine = sorted.join(" ");
		lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
	}

	return lines;
}

/** Traverse component tree to locate the active FooterComponent. */
export function resolveFooter(root: unknown): FooterComponentLike | undefined {
	const visited = new Set<unknown>();
	function scan(node: unknown): FooterComponentLike | undefined {
		if (!node || typeof node !== "object" || visited.has(node)) return undefined;
		visited.add(node);
		const candidate = node as FooterComponentLike;
		if (
			typeof candidate.render === "function" &&
			candidate.session &&
			candidate.footerData &&
			typeof candidate.getSessionStats === "function"
		) {
			return candidate;
		}
		if ((node as { layoutRoot?: unknown }).layoutRoot) {
			const found = scan((node as { layoutRoot?: unknown }).layoutRoot);
			if (found) return found;
		}
		if ((node as { currentLayout?: { root?: { component?: unknown } } }).currentLayout?.root?.component) {
			const found = scan(
				(node as { currentLayout?: { root?: { component?: unknown } } }).currentLayout!.root!.component,
			);
			if (found) return found;
		}
		if (Array.isArray((node as { children?: unknown[] }).children)) {
			for (const child of (node as { children: unknown[] }).children) {
				const found = scan(child);
				if (found) return found;
			}
		}
		if (Array.isArray((node as { entries?: Array<{ component?: unknown }> }).entries)) {
			for (const entry of (node as { entries: Array<{ component?: unknown }> }).entries) {
				const found = scan(entry?.component ?? entry);
				if (found) return found;
			}
		}
		return undefined;
	}
	return scan(root);
}

/** Find terminal row of a component within layout frame. */
export function findComponentRow(layout: unknown, component: unknown): number | undefined {
	if (!layout || typeof layout !== "object") return undefined;
	const root = (layout as { root?: { component: Component; rect?: { y: number }; children?: any[] } }).root;
	if (!root) return undefined;
	const visited = new Set<unknown>();
	function scan(box: any): number | undefined {
		if (!box || visited.has(box)) return undefined;
		visited.add(box);
		if (box.component === component) return box.rect?.y;
		for (const child of box.children ?? []) {
			const found = scan(child);
			if (found !== undefined) return found;
		}
		return undefined;
	}
	return scan(root);
}

export interface CompactFooterController {
	checkFooter(root?: unknown): void;
	checkPointer(point?: { x: number; y: number }, rows?: number, layout?: unknown): boolean;
	setHovered(hovered: boolean): boolean;
	isHovered(): boolean;
	getHookedFooter(): FooterComponentLike | undefined;
	dispose(): void;
}

export interface CompactFooterOptions {
	enabled?: () => boolean;
}

export function installCompactFooter(
	tui: unknown,
	getTheme: () => Theme,
	options: CompactFooterOptions = {},
): CompactFooterController {
	let hookedFooter: FooterComponentLike | undefined;
	let originalRender: ((width: number) => string[]) | undefined;
	let originalHandleMouse: ((event: TuiMouseEvent) => TuiMouseEventResult | undefined) | undefined;
	const enabled = () => options.enabled?.() ?? true;

	function hook(footer: FooterComponentLike) {
		if (hookedFooter === footer) return;
		unhook();
		hookedFooter = footer;
		originalRender = footer.render;
		originalHandleMouse = footer.handleMouse;
		footer.__originalRender = originalRender;
		footer.__originalHandleMouse = originalHandleMouse;
		footer.isHovered = false;
		footer.pathHitWidth = 0;

		footer.render = function (width: number): string[] {
			if (!enabled()) {
				return originalRender ? originalRender.call(this, width) : [];
			}
			return renderCompactFooter(this, getTheme(), width);
		};

		footer.handleMouse = function (event: TuiMouseEvent): TuiMouseEventResult | undefined {
			if (!enabled()) return originalHandleMouse?.call(this, event);
			if (event.y === 0 && event.x >= 0 && event.x < (this.pathHitWidth ?? 0)) {
				if (!this.isHovered) {
					this.isHovered = true;
					return { handled: true, render: true };
				}
			}
			return originalHandleMouse?.call(this, event);
		};
	}

	function unhook() {
		if (hookedFooter) {
			if (originalRender) hookedFooter.render = originalRender;
			if (originalHandleMouse) hookedFooter.handleMouse = originalHandleMouse;
			else delete hookedFooter.handleMouse;
			delete hookedFooter.__originalRender;
			delete hookedFooter.__originalHandleMouse;
			delete hookedFooter.isHovered;
			delete hookedFooter.pathHitWidth;
		}
		hookedFooter = undefined;
		originalRender = undefined;
		originalHandleMouse = undefined;
	}

	const initial = resolveFooter(tui);
	if (initial) hook(initial);

	return {
		checkFooter(root?: unknown) {
			const footer = resolveFooter(root ?? tui);
			if (footer && footer !== hookedFooter) hook(footer);
		},
		checkPointer(point, rows, layout) {
			if (!hookedFooter || !enabled()) return false;
			if (!point) {
				if (hookedFooter.isHovered) {
					hookedFooter.isHovered = false;
					return true;
				}
				return false;
			}
			const footerRow = findComponentRow(layout, hookedFooter) ?? (rows ? rows - 1 : undefined);
			if (footerRow === undefined) return false;
			const hit = point.y === footerRow && point.x >= 0 && point.x < (hookedFooter.pathHitWidth ?? 0);
			if (hit !== hookedFooter.isHovered) {
				hookedFooter.isHovered = hit;
				return true;
			}
			return false;
		},
		setHovered(hovered: boolean) {
			if (!hookedFooter || hookedFooter.isHovered === hovered) return false;
			hookedFooter.isHovered = hovered;
			return true;
		},
		isHovered() {
			return hookedFooter?.isHovered ?? false;
		},
		getHookedFooter() {
			return hookedFooter;
		},
		dispose: unhook,
	};
}
