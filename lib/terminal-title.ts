/**
 * Dynamic Terminal Title & Desktop Notification Controller.
 *
 * Keeps the terminal/tab title (OSC 0) synchronized with agent execution progress
 * and emits native desktop notifications (OSC 777 / OSC 9) on task completion:
 * - Idle / Settled: "π - <cwd>"
 * - Thinking: "🧠 Thinking... · <cwd>"
 * - Tool Execution: "⚙ bash: npm test · <cwd>", "📖 read: index.ts · <cwd>", etc.
 * - Responding: "✍ Responding... · <cwd>"
 * - Task Settled: Emits native desktop notification in Ghostty, Kitty, WezTerm, iTerm2, etc.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import path from "node:path";

export interface TerminalTitleController {
	dispose(): void;
	onSessionStart(ctx: ExtensionContext): void;
	onSessionShutdown(ctx?: ExtensionContext): void;
	onAgentSettled(ctx?: ExtensionContext, aborted?: boolean): void;
	formatBaseTitle(cwd: string, sessionName?: string): string;
	formatToolTitle(toolName: string, args: Record<string, any> | undefined, cwd: string): string;
}

export function formatBaseTitle(cwd: string, sessionName?: string): string {
	const dirName = path.basename(cwd || process.cwd()) || "workspace";
	return sessionName ? `π - ${sessionName} - ${dirName}` : `π - ${dirName}`;
}

export function formatToolTitle(toolName: string, args: Record<string, any> | undefined, cwd: string): string {
	const dirName = path.basename(cwd || process.cwd()) || "workspace";
	let action = toolName;

	if (toolName === "bash" || toolName === "powershell") {
		const rawCmd = String(args?.command || "").trim().replace(/\s+/g, " ");
		const cmd = rawCmd.length > 30 ? `${rawCmd.slice(0, 27)}...` : rawCmd;
		action = cmd ? `⚙ ${toolName}: ${cmd}` : `⚙ ${toolName}`;
	} else if (toolName === "read") {
		const target = path.basename(String(args?.path || ""));
		action = target ? `📖 read: ${target}` : "📖 read";
	} else if (toolName === "edit") {
		const target = path.basename(String(args?.path || ""));
		action = target ? `✏ edit: ${target}` : "✏ edit";
	} else if (toolName === "write") {
		const target = path.basename(String(args?.path || ""));
		action = target ? `📝 write: ${target}` : "📝 write";
	} else if (toolName === "grep") {
		const pattern = String(args?.pattern || "").trim();
		action = pattern ? `🔎 grep: ${pattern.slice(0, 20)}` : "🔎 grep";
	} else if (toolName === "find") {
		const pattern = String(args?.pattern || "").trim();
		action = pattern ? `📁 find: ${pattern.slice(0, 20)}` : "📁 find";
	} else if (toolName === "web_search" || toolName.includes("search")) {
		const query = String(args?.query || "").trim();
		action = query ? `🔍 search: ${query.slice(0, 25)}` : "🔍 search";
	} else {
		action = `⚡ ${toolName}`;
	}

	return `${action} · ${dirName}`;
}

/**
 * Emits native desktop terminal notification escape sequences (OSC 777 / OSC 9 / OSC 99).
 * Seamlessly supported by modern terminals including Ghostty, Kitty, WezTerm, iTerm2, and Warp.
 */
export function emitTerminalNotification(title: string, body: string): string {
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
		seq = `\x1b]99;i=pi;${cleanBody} · ${cleanTitle}\x1b\\`;
	} else {
		seq = `\x1b]9;${cleanBody} · ${cleanTitle}\x07`;
	}

	if (isTmux) {
		seq = `\x1bPtmux;\x1b${seq.replace(/\x1b/g, "\x1b\x1b")}\x1b\\`;
	}

	try {
		if (process.stdout?.isTTY) {
			process.stdout.write(seq);
		}
	} catch {}

	return seq;
}

export function createTerminalTitleController(pi: ExtensionAPI): TerminalTitleController {
	let isDisposed = false;
	let currentState: "idle" | "thinking" | "responding" | "tool" = "idle";
	let hadWorkInTurn = false;

	function setTitle(ctx: ExtensionContext | undefined, title: string): void {
		if (isDisposed) return;
		try {
			ctx?.ui?.setTitle?.(title);
		} catch {}
		try {
			if (process.stdout?.isTTY) {
				process.stdout.write(`\x1b]0;${title}\x07`);
			}
		} catch {}
	}

	function resetTitle(ctx?: ExtensionContext): void {
		currentState = "idle";
		const cwd = ctx?.cwd || process.cwd();
		const sessionName = pi.getSessionName?.();
		setTitle(ctx, formatBaseTitle(cwd, sessionName));
	}

	pi.on?.("turn_start", (_event, ctx) => {
		hadWorkInTurn = true;
		currentState = "thinking";
		const dirName = path.basename(ctx.cwd || process.cwd()) || "workspace";
		setTitle(ctx, `🧠 Thinking... · ${dirName}`);
	});

	pi.on?.("message_update", (event, ctx) => {
		const eventType = (event as any)?.assistantMessageEvent?.type;
		const dirName = path.basename(ctx.cwd || process.cwd()) || "workspace";

		if (eventType === "thinking_start" && currentState !== "thinking") {
			currentState = "thinking";
			hadWorkInTurn = true;
			setTitle(ctx, `🧠 Thinking... · ${dirName}`);
		} else if (eventType === "text_start" && currentState !== "responding") {
			currentState = "responding";
			hadWorkInTurn = true;
			setTitle(ctx, `✍ Responding... · ${dirName}`);
		}
	});

	pi.on?.("tool_execution_start", (event, ctx) => {
		currentState = "tool";
		hadWorkInTurn = true;
		setTitle(ctx, formatToolTitle(event.toolName, event.args, ctx.cwd));
	});

	pi.on?.("tool_execution_end", (_event, ctx) => {
		currentState = "thinking";
		const dirName = path.basename(ctx.cwd || process.cwd()) || "workspace";
		setTitle(ctx, `🧠 Thinking... · ${dirName}`);
	});

	return {
		dispose() {
			isDisposed = true;
		},
		onSessionStart(ctx: ExtensionContext) {
			hadWorkInTurn = false;
			resetTitle(ctx);
		},
		onSessionShutdown(ctx?: ExtensionContext) {
			hadWorkInTurn = false;
			resetTitle(ctx);
		},
		onAgentSettled(ctx?: ExtensionContext, aborted?: boolean) {
			resetTitle(ctx);
			if (!aborted && hadWorkInTurn) {
				const dirName = path.basename(ctx?.cwd || process.cwd()) || "workspace";
				emitTerminalNotification(`π · ${dirName}`, "Task completed");
			}
			hadWorkInTurn = false;
		},
		formatBaseTitle,
		formatToolTitle,
	};
}
