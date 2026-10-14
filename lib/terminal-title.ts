/**
 * Dynamic Terminal Title & Desktop Notification Controller.
 *
 * Keeps the terminal/tab title (OSC 0, 1, 2) synchronized with agent execution progress
 * using an animated braille spinner (matching grok-build's perimeter rectangle cycle)
 * and emits informative native desktop notifications (OSC 777 / OSC 9) on task completion:
 * - Idle / Settled: "π - <session/topic> - <cwd>"
 * - Thinking: "⠋ Thinking... · <cwd>" (animated through ⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧)
 * - Tool Execution: "⠋ bash: npm test · <cwd>", "⠋ read: index.ts · <cwd>", "⠋ search: ... · <cwd>", etc.
 * - Responding: "⠋ Responding... · <cwd>"
 * - Task Settled: Emits native desktop notification with session topic, explicit stop reason, and duration
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import path from "node:path";

/**
 * 8-frame Braille spinner tracing the outer perimeter of a 2x3 rectangle clockwise:
 * (1,2,4) -> (1,4,5) -> (1,4,5,6) -> (4,5,6) -> (3,4,5,6) -> (3,5,6) -> (2,3,6) -> (1,2,3,6)
 * Identical to grok-build's TITLE_SPINNER.
 */
export const TITLE_SPINNER_FRAMES = [
	"⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧",
];

export const TITLE_SPINNER_INTERVAL_MS = 250;

export interface TerminalTitleControllerOptions {
	/**
	 * Callback returning whether the terminal currently has focus.
	 * When true, desktop completion notifications are suppressed (matching grok-build's NotificationCondition::Unfocused).
	 */
	isFocused?: () => boolean;
}

export interface TerminalTitleController {
	dispose(): void;
	onSessionStart(ctx: ExtensionContext): void;
	onSessionShutdown(ctx?: ExtensionContext): void;
	onAgentSettled(ctx?: ExtensionContext, aborted?: boolean): void;
	setTerminalWriter(writer: ((seq: string) => void) | null): void;
	setIsFocused(fn: (() => boolean) | null): void;
	formatBaseTitle(cwd: string, sessionTopic?: string): string;
	formatToolTitle(toolName: string, args: Record<string, any> | undefined, cwd: string, spinner?: string): string;
	buildNotification(topic: string | undefined, dirName: string, metrics: TurnMetrics, aborted?: boolean): { title: string; body: string };
}

export interface TurnMetrics {
	startTime: number;
	tools: Array<{ name: string; args?: any }>;
	lastError?: string;
	errorMessage?: string;
	stopReason?: string;
	currentPrompt?: string;
	lastResponseText?: string;
}

export function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Derives a human-meaningful session topic:
 * 1. Explicit session name if set by user or agent
 * 2. The first user prompt in the branch/entries defining this session's goal
 */
export function extractSessionTopic(ctx?: ExtensionContext): string | undefined {
	const sessionName = ctx?.sessionManager?.getSessionName?.();
	if (sessionName && sessionName.trim()) {
		return sessionName.trim();
	}

	const entries = ctx?.sessionManager?.getBranch?.() || ctx?.sessionManager?.getEntries?.() || [];
	for (const entry of entries) {
		const msg = (entry as any)?.message;
		if (entry?.type === "message" && msg?.role === "user") {
			let text = "";
			if (typeof msg.content === "string") {
				text = msg.content;
			} else if (Array.isArray(msg.content)) {
				text = msg.content
					.filter((part: any) => part && part.type === "text" && typeof part.text === "string")
					.map((part: any) => part.text)
					.join(" ");
			}
			const cleaned = text.replace(/[\x00-\x1f\x7f-\x9f]/g, "").trim().replace(/\s+/g, " ");
			if (cleaned) {
				return cleaned.length > 25 ? `${cleaned.slice(0, 22)}...` : cleaned;
			}
		}
	}

	return undefined;
}

export function formatBaseTitle(cwd: string, sessionTopic?: string): string {
	const dirName = path.basename(cwd || process.cwd()) || "workspace";
	return sessionTopic ? `π - ${sessionTopic} - ${dirName}` : `π - ${dirName}`;
}

export function formatToolTitle(
	rawToolName: string,
	args: Record<string, any> | undefined,
	cwd: string,
	spinner: string = TITLE_SPINNER_FRAMES[0],
): string {
	const dirName = path.basename(cwd || process.cwd()) || "workspace";
	const toolName = (rawToolName || "").replace(/^mcp__.*?__/, "");
	let action = toolName;

	if (toolName === "bash" || toolName === "powershell") {
		const rawCmd = String(args?.command || "").trim().replace(/\s+/g, " ");
		const cmd = rawCmd.length > 30 ? `${rawCmd.slice(0, 27)}...` : rawCmd;
		action = cmd ? `${toolName}: ${cmd}` : toolName;
	} else if (toolName === "read") {
		const target = path.basename(String(args?.path || ""));
		action = target ? `read: ${target}` : "read";
	} else if (toolName === "edit") {
		const target = path.basename(String(args?.path || ""));
		action = target ? `edit: ${target}` : "edit";
	} else if (toolName === "write") {
		const target = path.basename(String(args?.path || ""));
		action = target ? `write: ${target}` : "write";
	} else if (toolName === "grep") {
		const pattern = String(args?.pattern || "").trim();
		action = pattern ? `grep: ${pattern.slice(0, 20)}` : "grep";
	} else if (toolName === "find") {
		const pattern = String(args?.pattern || "").trim();
		action = pattern ? `find: ${pattern.slice(0, 20)}` : "find";
	} else if (toolName === "web_search" || toolName.includes("search")) {
		const query = String(args?.query || "").trim();
		action = query ? `search: ${query.slice(0, 25)}` : "search";
	}

	return `${spinner} ${action} · ${dirName}`;
}

/**
 * Builds an informative desktop notification title & body describing:
 * - Session topic / workspace in title
 * - Reason for stopping (Finished, Tool completed, Token limit, or Error) with exact elapsed time
 * - Action or reply summary in body
 */
export function buildNotification(
	topic: string | undefined,
	dirName: string,
	metrics: TurnMetrics,
	aborted?: boolean,
): { title: string; body: string } {
	const notifTitle = topic ? `${topic} · ${dirName}` : `π · ${dirName}`;
	const elapsed = Date.now() - (metrics.startTime || Date.now());
	const duration = formatDuration(elapsed);
	const stopReason = metrics.stopReason || "stop";

	if (aborted) {
		const promptInfo = metrics.currentPrompt ? ` "${metrics.currentPrompt}"` : "";
		return {
			title: notifTitle,
			body: `[已由用户取消 · ${duration}]${promptInfo}`.trim(),
		};
	}

	if (metrics.lastError || metrics.errorMessage || stopReason === "error") {
		const err = metrics.lastError || metrics.errorMessage || "未知异常";
		return {
			title: notifTitle,
			body: `[执行异常中断 · ${duration}] 错误: ${err}`,
		};
	}

	let statusHeader = "";
	let detailText = "";

	if (stopReason === "max_tokens" || stopReason === "length") {
		statusHeader = `[达到 Token 长度限制停止 · ${duration}]`;
	} else if (metrics.tools && metrics.tools.length > 0) {
		const toolCount = metrics.tools.length;
		const toolNames = [...new Set(metrics.tools.map((t) => t.name.replace(/^mcp__.*?__/, "")))];

		if (toolNames.some((t) => t.includes("search"))) {
			statusHeader = `[搜索完成 · ${duration}]`;
			const searchTool = metrics.tools.find((t) => t.name.includes("search"));
			const q = searchTool?.args?.query;
			detailText = q ? `检索 "${q.length > 25 ? `${q.slice(0, 22)}...` : q}"` : "网页检索完成";
		} else if (toolNames.includes("edit") || toolNames.includes("write")) {
			statusHeader = `[文件修改完成 · ${duration}]`;
			const edits = metrics.tools.filter((t) => t.name === "edit" || t.name === "write");
			const files = [...new Set(edits.map((e) => (e.args?.path ? path.basename(e.args.path) : "")))].filter(Boolean);
			detailText = files.length > 0 ? `更新了 ${files.slice(0, 3).join(", ")}` : "代码编辑完成";
		} else if (toolNames.includes("bash") || toolNames.includes("powershell")) {
			statusHeader = `[命令执行完成 · ${duration}]`;
			const bashTool = metrics.tools.find((t) => t.name === "bash" || t.name === "powershell");
			const cmd = String(bashTool?.args?.command || "").trim().replace(/\s+/g, " ");
			detailText = cmd ? `执行 ${cmd.length > 30 ? `${cmd.slice(0, 27)}...` : cmd}` : "终端命令完成";
		} else {
			statusHeader = `[工具执行完成 · ${duration}]`;
			detailText = `调用了 ${toolCount} 项工具 (${toolNames.slice(0, 3).join(", ")})`;
		}
	} else {
		statusHeader = `[回答完毕 · ${duration}]`;
	}

	if (!detailText && metrics.lastResponseText) {
		detailText = metrics.lastResponseText.replace(/[\x00-\x1f\x7f-\x9f]/g, "").trim().replace(/\s+/g, " ");
		if (detailText.length > 60) {
			detailText = `${detailText.slice(0, 57)}...`;
		}
	} else if (!detailText && metrics.currentPrompt) {
		detailText = `关于: "${metrics.currentPrompt}"`;
	}

	const body = detailText ? `${statusHeader} ${detailText}` : statusHeader;
	return { title: notifTitle, body };
}

/**
 * Emits native desktop terminal notification escape sequences (OSC 777 / OSC 9 / OSC 99).
 * Seamlessly supported by modern terminals including Ghostty, Kitty, WezTerm, iTerm2, and Warp.
 */
export function emitTerminalNotification(title: string, body: string, customWriter?: ((seq: string) => void) | null): string {
	const cleanTitle = title.replace(/[\x00-\x1f\x7f-\x9f]/g, "").trim();
	const cleanBody = body.replace(/[\x00-\x1f\x7f-\x9f]/g, "").trim();
	if (!cleanBody) return "";

	const isTmux = Boolean(process.env.TMUX);
	const termProgram = (process.env.TERM_PROGRAM || "").toLowerCase();
	const isGhostty = termProgram === "ghostty" || Boolean(process.env.GHOSTTY_RESOURCES_DIR);
	const isKitty = termProgram === "kitty" || Boolean(process.env.KITTY_PID);

	let seq = "";
	if (isGhostty) {
		seq = `\x1b]777;notify;${cleanTitle || "Pi"};${cleanBody}\x1b\\`;
	} else if (isKitty) {
		seq = `\x1b]99;i=pi:d=0;${cleanTitle || "π"}\x1b\\\x1b]99;i=pi:d=1:p=body;${cleanBody}\x1b\\`;
	} else {
		seq = `\x1b]9;${cleanBody} · ${cleanTitle}\x07`;
	}

	if (isTmux) {
		seq = `\x1bPtmux;\x1b${seq.replace(/\x1b/g, "\x1b\x1b")}\x1b\\`;
	}

	if (typeof customWriter === "function") {
		try {
			customWriter(seq);
		} catch {}
	} else if (process.stdout?.isTTY) {
		try {
			process.stdout.write(seq);
		} catch {}
	}

	return seq;
}

export function createTerminalTitleController(
	pi: ExtensionAPI,
	options?: TerminalTitleControllerOptions,
): TerminalTitleController {
	let isDisposed = false;
	let currentState: "idle" | "thinking" | "responding" | "tool" = "idle";
	let currentTool: { toolName: string; args?: Record<string, any> } | null = null;
	let turnMetrics: TurnMetrics = { startTime: Date.now(), tools: [] };
	let hadWorkInTurn = false;
	let terminalWriter: ((seq: string) => void) | null = null;
	let notifTimer: ReturnType<typeof setTimeout> | null = null;
	let spinnerTimer: ReturnType<typeof setInterval> | null = null;
	let spinnerFrameIndex = 0;
	let activeContext: ExtensionContext | undefined;
	let lastWrittenTitle = "";
	let isFocusedFn = options?.isFocused ?? null;

	function writeTitleEscape(title: string): void {
		if (isDisposed) return;
		const clean = title.replace(/[\x00-\x1f\x7f-\x9f]/g, "").trim();
		if (!clean || clean === lastWrittenTitle) return;
		lastWrittenTitle = clean;

		const isTmux = Boolean(process.env.TMUX);
		// Emit OSC 0 (window+icon), OSC 1 (icon/tab), and OSC 2 (window) for universal terminal compatibility
		let seq = `\x1b]0;${clean}\x07\x1b]1;${clean}\x07\x1b]2;${clean}\x07`;
		if (isTmux) {
			seq = `\x1bPtmux;\x1b${seq.replace(/\x1b/g, "\x1b\x1b")}\x1b\\`;
		}

		if (typeof terminalWriter === "function") {
			try {
				terminalWriter(seq);
			} catch {}
		} else if (process.stdout?.isTTY) {
			try {
				process.stdout.write(seq);
			} catch {}
		}
	}

	function setTitle(ctx: ExtensionContext | undefined, title: string): void {
		if (isDisposed) return;
		try {
			ctx?.ui?.setTitle?.(title);
		} catch {}
		writeTitleEscape(title);
	}

	function renderActiveTitle(): void {
		if (isDisposed || currentState === "idle") return;
		const frame = TITLE_SPINNER_FRAMES[spinnerFrameIndex % TITLE_SPINNER_FRAMES.length];
		const dirName = path.basename(activeContext?.cwd || process.cwd()) || "workspace";

		let title = "";
		if (currentState === "thinking") {
			title = `${frame} Thinking... · ${dirName}`;
		} else if (currentState === "responding") {
			title = `${frame} Responding... · ${dirName}`;
		} else if (currentState === "tool" && currentTool) {
			title = formatToolTitle(currentTool.toolName, currentTool.args, activeContext?.cwd || process.cwd(), frame);
		} else {
			title = `${frame} Thinking... · ${dirName}`;
		}

		setTitle(activeContext, title);
	}

	function startSpinner(ctx?: ExtensionContext): void {
		if (ctx) activeContext = ctx;
		if (isDisposed) return;
		renderActiveTitle();
		if (!spinnerTimer) {
			spinnerTimer = setInterval(() => {
				if (isDisposed || currentState === "idle") {
					stopSpinner();
					return;
				}
				spinnerFrameIndex = (spinnerFrameIndex + 1) % TITLE_SPINNER_FRAMES.length;
				renderActiveTitle();
			}, TITLE_SPINNER_INTERVAL_MS);
			if (typeof (spinnerTimer as any)?.unref === "function") {
				(spinnerTimer as any).unref();
			}
		}
	}

	function stopSpinner(): void {
		if (spinnerTimer) {
			clearInterval(spinnerTimer);
			spinnerTimer = null;
		}
		spinnerFrameIndex = 0;
	}

	function resetTitle(ctx?: ExtensionContext): void {
		stopSpinner();
		currentState = "idle";
		currentTool = null;
		if (ctx) activeContext = ctx;
		const cwd = ctx?.cwd || process.cwd();
		const topic = extractSessionTopic(ctx);
		setTitle(ctx, formatBaseTitle(cwd, topic));
	}

	pi.on?.("turn_start", (_event, ctx) => {
		isDisposed = false;
		hadWorkInTurn = true;
		currentState = "thinking";
		currentTool = null;
		turnMetrics = { startTime: Date.now(), tools: [] };
		spinnerFrameIndex = 0;
		startSpinner(ctx);
	});

	pi.on?.("before_agent_start", (event, _ctx) => {
		if ((event as any)?.prompt) {
			const raw = String((event as any).prompt).trim().replace(/\s+/g, " ");
			if (raw) {
				turnMetrics.currentPrompt = raw.length > 30 ? `${raw.slice(0, 27)}...` : raw;
			}
		}
	});

	pi.on?.("message_update", (event, ctx) => {
		const eventType = (event as any)?.assistantMessageEvent?.type;
		if (ctx) activeContext = ctx;

		if (eventType === "thinking_start" && currentState !== "thinking") {
			currentState = "thinking";
			hadWorkInTurn = true;
			currentTool = null;
			startSpinner(ctx);
		} else if (eventType === "text_start" && currentState !== "responding") {
			currentState = "responding";
			hadWorkInTurn = true;
			currentTool = null;
			startSpinner(ctx);
		}
	});

	pi.on?.("tool_execution_start", (event, ctx) => {
		isDisposed = false;
		currentState = "tool";
		hadWorkInTurn = true;
		currentTool = { toolName: event.toolName, args: event.args };
		turnMetrics.tools.push({ name: event.toolName, args: event.args });
		startSpinner(ctx);
	});

	pi.on?.("tool_execution_end", (event, ctx) => {
		currentState = "thinking";
		currentTool = null;
		if (event.isError) {
			turnMetrics.lastError = typeof event.result === "string" ? event.result : `${event.toolName} failed`;
		}
		startSpinner(ctx);
	});

	pi.on?.("turn_end", (event, _ctx) => {
		if (event.message) {
			turnMetrics.stopReason = event.message.stopReason;
			turnMetrics.errorMessage = event.message.errorMessage;
			const textParts = (event.message.content || [])
				.filter((c: any) => c && c.type === "text" && typeof c.text === "string")
				.map((c: any) => c.text)
				.join(" ");
			if (textParts) {
				turnMetrics.lastResponseText = textParts;
			}
		}
	});

	return {
		dispose() {
			stopSpinner();
			if (notifTimer) {
				clearTimeout(notifTimer);
				notifTimer = null;
			}
			terminalWriter = null;
			isDisposed = true;
			currentState = "idle";
			currentTool = null;
		},
		setTerminalWriter(writer) {
			terminalWriter = writer;
			isDisposed = false;
		},
		onSessionStart(ctx: ExtensionContext) {
			stopSpinner();
			isDisposed = false;
			hadWorkInTurn = false;
			currentState = "idle";
			currentTool = null;
			turnMetrics = { startTime: Date.now(), tools: [] };
			resetTitle(ctx);
		},
		onSessionShutdown(ctx?: ExtensionContext) {
			stopSpinner();
			if (notifTimer) {
				clearTimeout(notifTimer);
				notifTimer = null;
			}
			hadWorkInTurn = false;
			currentState = "idle";
			currentTool = null;
			resetTitle(ctx);
		},
		onAgentSettled(ctx?: ExtensionContext, aborted?: boolean) {
			stopSpinner();
			currentState = "idle";
			currentTool = null;
			const cwd = ctx?.cwd || process.cwd();
			const dirName = path.basename(cwd) || "workspace";
			const topic = extractSessionTopic(ctx);
			const metricsSnapshot = { ...turnMetrics, tools: [...turnMetrics.tools] };
			const isFocused = typeof isFocusedFn === "function" ? isFocusedFn() : false;
			const shouldNotify = !aborted && hadWorkInTurn && !isFocused;

			resetTitle(ctx);

			if (shouldNotify) {
				if (notifTimer) clearTimeout(notifTimer);
				notifTimer = setTimeout(() => {
					notifTimer = null;
					const currentlyFocused = typeof isFocusedFn === "function" ? isFocusedFn() : false;
					if (currentlyFocused) return;
					const notif = buildNotification(topic, dirName, metricsSnapshot, Boolean(aborted));
					emitTerminalNotification(notif.title, notif.body, terminalWriter);
				}, 100);
				if (typeof (notifTimer as any)?.unref === "function") {
					(notifTimer as any).unref();
				}
			}

			hadWorkInTurn = false;
			turnMetrics = { startTime: Date.now(), tools: [] };
		},
		setIsFocused(fn: (() => boolean) | null) {
			isFocusedFn = fn;
		},
		formatBaseTitle,
		formatToolTitle,
		buildNotification,
	};
}
