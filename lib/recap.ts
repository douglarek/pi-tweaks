/**
 * Session recap ("where was I") for Pi, ported from grok-build:
 * - `crates/codegen/xai-grok-shell/src/session/helpers/session_recap.rs`
 * - `crates/codegen/xai-grok-shell/src/session/acp_session_impl/recap.rs`
 * - `crates/codegen/xai-grok-pager/src/notifications/focus.rs`
 * - `crates/codegen/xai-grok-pager/src/scrollback/blocks/session_event.rs`
 *
 * Generates a read-only 1-sentence recap when returning from idle (or while unfocused past the threshold)
 * without mutating or polluting the LLM conversation context.
 */
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Container, MouseRegion, Spacer, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";

export const RECAP_ENTRY_TYPE = "recap";

/** Generous headroom: the recap instruction targets ~25–40 words (~240 chars). */
export const RECAP_MAX_CHARS = 1200;

/** Auto recaps longer than this (raw UTF-8 byte length) are suppressed from display. */
export const RECAP_AUTO_RAW_DISPLAY_MAX = 500;

/** Max characters of a recap persisted as a short preview. */
export const RECAP_PERSIST_MAX_CHARS = 240;

/** Minimum main user turns before an automatic return-from-away recap. */
export const MIN_TURNS_FOR_AUTO_RECAP = 3;

/** Minimum idle time (3 minutes) before an automatic recap. */
export const RECAP_MIN_IDLE_MS = 3 * 60 * 1000;

/** Background poll interval (20 seconds) to pre-generate away recap while unfocused. */
export const RECAP_POLL_INTERVAL_MS = 20 * 1000;

/** Minimum gap (90 seconds) between automatic recap attempts while away. */
export const AUTO_RECAP_RETRY_INTERVAL_MS = 90 * 1000;

/** Default transcript budget limits from grok-build `SessionRecapSettings`. */
export const SESSION_RECAP_USER_MESSAGE_MAX_CHARS_DEFAULT = 2_000;
export const SESSION_RECAP_AGENT_REPLY_MAX_CHARS_DEFAULT = 4_000;
export const SESSION_RECAP_TRANSCRIPT_MAX_CHARS_DEFAULT = 48_000;

/** System prompt from `session_recap.rs` (`RECAP_SYSTEM`). */
export const RECAP_SYSTEM =
	'Write ONE sentence recap body for a user returning from idle, ' +
	'based on the session transcript the user sends. ' +
	'Output ONLY the body (the UI adds the "Recap —" label).\n\n' +
	"LANGUAGE: write the body in the language of the user's messages in the transcript. " +
	'Keep code identifiers verbatim.\n\n' +
	'Lead with agency:\n' +
	'- "You asked …" if the session was mainly questions, walkthroughs, or review with no landed change.\n' +
	'- "We <past-tense verb> …" if the agent implemented, fixed, merged, or changed code/config/docs ' +
	'(e.g. "We fixed …", "We merged …", "We wired …" — not "We did fix" / "We did merge").\n' +
	'- If almost nothing happened: "You had just begun this session."\n\n' +
	'Shape: <lead>: <concrete specifics — crate/file/flag/behavior/endpoint>. ~25–40 words.\n\n' +
	'Synthetic examples (style only — adapt to THIS session, do not copy):\n\n' +
	'You asked how retries work in the payment client: exponential backoff in `billing/retry.rs`, max 5 attempts, 429s only.\n\n' +
	'You asked for a walkthrough of the auth middleware change: warn-only mode in the API layer, no hard fail on missing claims.\n\n' +
	'We fixed the flaky integration test: race in `queue_worker` shutdown by awaiting the drain channel before exit.\n\n' +
	'We merged the feature branch: kept the new telemetry hooks, dropped the obsolete feature flag in `config/flags.toml`.\n\n' +
	'Bad (never):\n' +
	'- Start with Recap / Session recap / extra labels\n' +
	'- English recap for a non-English session\n' +
	'- Quote or restate these instructions\n' +
	'- Bullets, markdown, code fences, extra sentences\n' +
	'- Invent work not reflected in the transcript';

export interface RecapEntryData {
	summary: string;
	preview: string;
	auto: boolean;
	mainTurns: number;
	timestamp: number;
}

function extractMessageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content) {
		if (part && typeof part === "object" && (part as { type?: unknown }).type === "text") {
			const text = (part as { text?: unknown }).text;
			if (typeof text === "string") parts.push(text);
		}
	}
	return parts.join("");
}

function unwrapEntryMessage(entry: unknown): { role?: string; content?: unknown } | undefined {
	if (!entry || typeof entry !== "object") return undefined;
	const rec = entry as { type?: string; role?: string; content?: unknown; message?: { role?: string; content?: unknown } };
	if (rec.type === "message" && rec.message && typeof rec.message === "object") {
		return rec.message;
	}
	if (typeof rec.role === "string") {
		return rec;
	}
	return undefined;
}

export function extractLastEntryTimestamp(entries: unknown[]): number {
	if (!Array.isArray(entries) || entries.length === 0) return 0;
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (!entry || typeof entry !== "object") continue;
		const rec = entry as {
			timestamp?: unknown;
			message?: { timestamp?: unknown };
			data?: { timestamp?: unknown };
		};
		if (typeof rec.message?.timestamp === "number" && Number.isFinite(rec.message.timestamp)) {
			return rec.message.timestamp;
		}
		if (typeof rec.data?.timestamp === "number" && Number.isFinite(rec.data.timestamp)) {
			return rec.data.timestamp;
		}
		if (typeof rec.timestamp === "number" && Number.isFinite(rec.timestamp)) {
			return rec.timestamp;
		}
		if (typeof rec.timestamp === "string") {
			const parsed = Date.parse(rec.timestamp);
			if (!Number.isNaN(parsed)) return parsed;
		}
	}
	return 0;
}
export function keepHead(text: string, maxChars: number): string {
	const chars = Array.from(text);
	if (chars.length <= maxChars) return text;
	return `${chars.slice(0, maxChars).join("")}\u2026`;
}

export function keepTail(text: string, maxChars: number): string {
	const chars = Array.from(text);
	if (chars.length <= maxChars) return text;
	return `\u2026${chars.slice(chars.length - maxChars).join("")}`;
}

/**
 * Counts real user prompts in the conversation.
 */
export function mainTurnCount(entries: unknown[]): number {
	if (!Array.isArray(entries)) return 0;
	let count = 0;
	for (const entry of entries) {
		const msg = unwrapEntryMessage(entry);
		if (msg?.role === "user") {
			const text = extractMessageText(msg.content).trim();
			if (text.length > 0) count++;
		}
	}
	return count;
}

/**
 * Recover the last committed recap main-turn watermark from session entries.
 */
export function lastRecapWatermark(entries: unknown[]): number {
	if (!Array.isArray(entries)) return 0;
	let watermark = 0;
	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue;
		const rec = entry as { type?: string; customType?: string; data?: Partial<RecapEntryData> };
		if (rec.type === "custom" && rec.customType === RECAP_ENTRY_TYPE) {
			const turns = rec.data?.mainTurns;
			if (typeof turns === "number" && Number.isFinite(turns) && turns > watermark) {
				watermark = turns;
			}
		}
	}
	return watermark;
}

/**
 * Recent real user messages and the agent's visible replies, oldest first, as `User:` / `Agent:` blocks.
 * Reasoning, tool calls, tool results, and custom entries are dropped.
 */
export function buildRecapTranscript(
	entries: unknown[],
	userMaxChars = SESSION_RECAP_USER_MESSAGE_MAX_CHARS_DEFAULT,
	replyMaxChars = SESSION_RECAP_AGENT_REPLY_MAX_CHARS_DEFAULT,
	transcriptMaxChars = SESSION_RECAP_TRANSCRIPT_MAX_CHARS_DEFAULT,
): string | null {
	if (!Array.isArray(entries) || entries.length === 0) return null;
	const blocks: string[] = [];
	let used = 0;

	for (let i = entries.length - 1; i >= 0; i--) {
		const msg = unwrapEntryMessage(entries[i]);
		if (!msg) continue;

		let block: string | undefined;
		if (msg.role === "user") {
			const text = extractMessageText(msg.content).trim();
			if (!text) continue;
			block = `User: ${keepHead(text, userMaxChars)}`;
		} else if (msg.role === "assistant") {
			const text = extractMessageText(msg.content).trim();
			if (!text) continue;
			block = `Agent: ${keepTail(text, replyMaxChars)}`;
		} else {
			continue;
		}

		if (used + block.length > transcriptMaxChars && blocks.length > 0) {
			break;
		}
		used += block.length;
		blocks.push(block);
	}

	if (blocks.length === 0) return null;
	blocks.reverse();
	return blocks.join("\n\n");
}

const LEADING_RECAP_LABELS = [
	"Recap —",
	"Recap—",
	"Recap -",
	"Recap:",
	"recap:",
	"Session recap:",
	"Summary:",
];

/**
 * Clean the model's raw recap output into a readable one-liner body (`clean_recap_text` in `session_recap.rs`).
 */
export function cleanRecapText(raw: string): string {
	// Strip <think>...</think> blocks if emitted by a reasoning model
	const withoutThink = raw.replace(/<think>[\s\S]*?<\/think>/gi, "");

	// Collapse runs of whitespace/newlines into single spaces
	let out = withoutThink.trim().split(/\s+/).filter(Boolean).join(" ");
	if (!out) return "";

	// Strip a stray leading label if the model added one anyway
	for (const label of LEADING_RECAP_LABELS) {
		if (out.startsWith(label)) {
			out = out.slice(label.length).trimStart();
			break;
		}
	}

	// Strip symmetric wrapping quotes around the whole string
	if (out.length >= 2) {
		const first = out[0];
		const last = out[out.length - 1];
		if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
			out = out.slice(1, -1).trim();
		}
	}

	const chars = Array.from(out);
	if (chars.length > RECAP_MAX_CHARS) {
		out = `${chars.slice(0, RECAP_MAX_CHARS).join("").trimEnd()}\u2026`;
	}

	return out;
}

/**
 * Auto only: over-long output is suppressed from display (`should_suppress_auto_recap_display` in `session_recap.rs`).
 */
export function shouldSuppressAutoRecapDisplay(raw: string, summary: string): boolean {
	if (Buffer.byteLength(raw, "utf8") > RECAP_AUTO_RAW_DISPLAY_MAX) {
		return true;
	}
	return summary.endsWith("\u2026") && Array.from(summary).length >= RECAP_MAX_CHARS;
}

/**
 * Gate check for manual and automatic recaps (`recap_gate` in `session_recap.rs`).
 */
export function recapGate(
	mainTurns: number,
	last: number,
	auto: boolean,
	idleOk: boolean,
): { ok: true } | { ok: false; reason: string } {
	if (mainTurns === 0) {
		return { ok: false, reason: "no main turns yet" };
	}
	if (auto) {
		if (mainTurns <= last) {
			return { ok: false, reason: "no new main turn since last recap" };
		}
		if (mainTurns < MIN_TURNS_FOR_AUTO_RECAP) {
			return { ok: false, reason: "fewer than min turns for auto recap" };
		}
		if (!idleOk) {
			return { ok: false, reason: "idle threshold not met" };
		}
	}
	return { ok: true };
}

/**
 * Focus and away-duration tracker ported from `crates/codegen/xai-grok-pager/src/notifications/focus.rs`.
 */
export class FocusTracker {
	private focused = true;
	private lostAt: number | null = null;
	private readonly recapThresholdMs: number;
	private readonly retryIntervalMs: number;
	private recapShownThisAway = false;
	private lastAutoRecapAttemptAt: number | null = null;

	constructor(
		recapThresholdMs = RECAP_MIN_IDLE_MS,
		retryIntervalMs = AUTO_RECAP_RETRY_INTERVAL_MS,
	) {
		this.recapThresholdMs = recapThresholdMs;
		this.retryIntervalMs = retryIntervalMs;
	}

	onFocusLost(now = Date.now()): void {
		this.focused = false;
		this.lostAt = now;
		this.recapShownThisAway = false;
		this.lastAutoRecapAttemptAt = null;
	}

	onFocusGained(): void {
		this.focused = true;
		this.lostAt = null;
	}

	isFocused(): boolean {
		return this.focused;
	}

	recapDue(now = Date.now()): boolean {
		if (this.focused || this.recapShownThisAway) {
			return false;
		}
		if (
			this.lastAutoRecapAttemptAt !== null &&
			now - this.lastAutoRecapAttemptAt < this.retryIntervalMs
		) {
			return false;
		}
		if (this.lostAt === null) {
			return false;
		}
		return now - this.lostAt >= this.recapThresholdMs;
	}

	noteAutoRecapAttempt(now = Date.now()): void {
		this.lastAutoRecapAttemptAt = now;
	}

	markRecapShown(): void {
		this.recapShownThisAway = true;
	}
}

/**
 * Render component for a `Recap` entry, matching `grok-build` screenshot:
 * - Collapsed by default (single line): ` ◆ Recap  <first-line preview>...` in dim style.
 * - Clickable to toggle into Expanded multi-line view.
 */
export class RecapEntryView implements Component {
	private summary: string;
	private readonly getTheme: () => Theme;
	private readonly outputPad: number;
	private readonly onRequestRender?: () => void;
	private collapsedOverride: boolean | undefined;
	private region: MouseRegion;

	constructor(
		summary: string,
		getTheme: () => Theme,
		hostExpanded: boolean,
		outputPad = 1,
		onRequestRender?: () => void,
	) {
		this.summary = summary;
		this.getTheme = getTheme;
		this.outputPad = outputPad;
		this.onRequestRender = onRequestRender;
		const inner: Component = {
			render: (width: number) => this.renderInner(width, hostExpanded),
			invalidate: () => {},
		};
		this.region = new MouseRegion(inner, (event) => {
			if (event.type !== "click" || event.button !== "left" || !this.summary.trim()) {
				return undefined;
			}
			const currentlyCollapsed = this.isCollapsed(hostExpanded);
			this.collapsedOverride = !currentlyCollapsed;
			this.onRequestRender?.();
			return { handled: true };
		});
	}

	setSummary(summary: string): void {
		this.summary = summary;
		this.invalidate();
		this.onRequestRender?.();
	}

	getSummary(): string {
		return this.summary;
	}

	isCollapsed(hostExpanded = false): boolean {
		if (this.collapsedOverride !== undefined) return this.collapsedOverride;
		return !hostExpanded;
	}

	private renderInner(width: number, hostExpanded: boolean): string[] {
		const th = this.getTheme();
		const pad = " ".repeat(Math.max(1, this.outputPad));
		const contentWidth = Math.max(20, width - pad.length * 2);
		const cleanBody = this.summary.trim();
		if (!cleanBody) return [];

		const bullet = th.fg("muted", "◆ ");
		const header = th.fg("dim", th.bold("Recap"));
		const collapsed = this.isCollapsed(hostExpanded);

		if (collapsed) {
			const preview = (cleanBody.split("\n")[0] ?? cleanBody).trim();
			const body = preview ? th.fg("dim", `  ${preview}`) : "";
			const line = truncateToWidth(`${pad}${bullet}${header}${body}`, width, th.fg("dim", "..."));
			const lineVis = visibleWidth(line);
			return [line + " ".repeat(Math.max(0, width - lineVis))];
		}

		// Expanded: wraps "◆ Recap  <summary>" across lines
		const inlineText = `${bullet}${header}${th.fg("dim", `  ${cleanBody}`)}`;
		const wrapped = wrapTextWithAnsi(inlineText, contentWidth);
		const lines: string[] = [];
		for (const wLine of wrapped) {
			const full = `${pad}${wLine}`;
			const vis = visibleWidth(full);
			lines.push(full + " ".repeat(Math.max(0, width - vis)));
		}
		return lines;
	}

	render(width: number): string[] {
		return this.region.render(width);
	}

	handleMouse(event: Parameters<MouseRegion["handleMouse"]>[0]) {
		return this.region.handleMouse(event);
	}

	invalidate(): void {
		this.region.invalidate();
	}
}

export interface RecapOptions {
	enabled?: () => boolean;
	recapMinIdleMs?: number;
	pollIntervalMs?: number;
	retryIntervalMs?: number;
	now?: () => number;
	getChatContainer?: () => Container | undefined;
	getTheme?: () => Theme | undefined;
}

export interface RecapController {
	readonly focusTracker: FocusTracker;
	onSessionStart(ctx: ExtensionContext): void;
	onTurnSettled(ctx: ExtensionContext): void;
	onNewPrompt(): void;
	onTerminalInput(data: string): void;
	triggerAutoRecap(): Promise<boolean>;
	dispose(): void;
}

const sessionMemoryWatermarks = new Map<string, number>();

export function createRecapController(
	pi: ExtensionAPI,
	getOverlayState: () => boolean,
	onRequestRender: () => void,
	options: RecapOptions = {},
): RecapController {
	const nowFn = options.now ?? (() => Date.now());
	const minIdleMs = options.recapMinIdleMs ?? RECAP_MIN_IDLE_MS;
	const pollIntervalMs = options.pollIntervalMs ?? RECAP_POLL_INTERVAL_MS;
	const retryIntervalMs = options.retryIntervalMs ?? AUTO_RECAP_RETRY_INTERVAL_MS;
	const isEnabled = options.enabled ?? (() => true);

	const focusTracker = new FocusTracker(minIdleMs, retryIntervalMs);
	let activeCtx: ExtensionContext | undefined;
	let cachedTheme: Theme | undefined;
	let lastTurnEndAt = 0;
	let lastRecapMainTurn = 0;
	let recapEpoch = 0;
	let recapInFlight = false;
	let pollTimer: ReturnType<typeof setInterval> | undefined;

	function currentSessionKey(ctx: ExtensionContext | undefined = activeCtx): string {
		try {
			return ctx?.sessionManager?.getSessionFile?.() ?? "__default__";
		} catch {
			return "__default__";
		}
	}

	function syncWatermark(entries: unknown[]): number {
		const mainTurns = mainTurnCount(entries);
		const persisted = lastRecapWatermark(entries);
		const inMem = sessionMemoryWatermarks.get(currentSessionKey()) ?? 0;
		const highest = Math.max(persisted, inMem, lastRecapMainTurn);
		lastRecapMainTurn = highest;
		// Heal watermark if conversation shrank (e.g. after rewind / fork / tree navigation)
		if (lastRecapMainTurn > mainTurns) {
			lastRecapMainTurn = Math.max(0, mainTurns - 1);
			sessionMemoryWatermarks.set(currentSessionKey(), lastRecapMainTurn);
		}
		return mainTurns;
	}

	function commitWatermark(mainTurns: number): void {
		lastRecapMainTurn = mainTurns;
		sessionMemoryWatermarks.set(currentSessionKey(), mainTurns);
	}

	function isEligibleForAutoRecap(): boolean {
		try {
			if (!isEnabled() || !activeCtx || !activeCtx.hasUI || activeCtx.mode !== "tui") return false;
			if (!activeCtx.isIdle() || activeCtx.hasPendingMessages() || getOverlayState()) return false;
			if (!activeCtx.model || !activeCtx.modelRegistry) return false;
			return true;
		} catch {
			return false;
		}
	}

	async function handleAutoRecap(): Promise<boolean> {
		if (!isEligibleForAutoRecap() || !activeCtx) return false;
		const ctx = activeCtx;
		const epoch = recapEpoch;
		let entries: unknown[];
		try {
			entries = ctx.sessionManager.getEntries();
		} catch {
			return false;
		}
		const mainTurns = syncWatermark(entries);

		const now = nowFn();
		const idleMs = lastTurnEndAt > 0 ? now - lastTurnEndAt : 0;
		const idleOk = lastTurnEndAt > 0 && idleMs >= minIdleMs;

		const gate = recapGate(mainTurns, lastRecapMainTurn, true, idleOk);
		if (!gate.ok) return false;
		if (recapInFlight) return false;

		const transcript = buildRecapTranscript(entries);
		if (!transcript) return false;

		let model: ExtensionContext["model"];
		let modelRegistry: ExtensionContext["modelRegistry"];
		try {
			model = ctx.model;
			modelRegistry = ctx.modelRegistry;
			cachedTheme = options.getTheme?.() ?? ctx.ui?.theme ?? cachedTheme;
		} catch {
			return false;
		}
		if (!model || !modelRegistry) return false;

		recapInFlight = true;
		focusTracker.noteAutoRecapAttempt(now);

		try {
			const result = await modelRegistry.complete(
				model,
				{
					systemPrompt: RECAP_SYSTEM,
					messages: [
						{
							role: "user",
							content: [{ type: "text", text: transcript }],
							timestamp: now,
						},
					],
				},
				{ maxTokens: 256, temperature: 0.2 },
			);

			let raw = "";
			if (typeof result?.content === "string") {
				raw = result.content;
			} else if (Array.isArray(result?.content)) {
				raw = result.content
					.filter(
						(part: unknown): part is { type: string; text: string } =>
							typeof part === "object" &&
							part !== null &&
							(part as { type?: string }).type === "text" &&
							typeof (part as { text?: string }).text === "string",
					)
					.map((part) => part.text)
					.join("");
			}

			const summary = cleanRecapText(raw);
			if (!summary) {
				recapInFlight = false;
				return false;
			}

			// Cancelled by a new user prompt or session switch while generating
			if (recapEpoch !== epoch) {
				recapInFlight = false;
				return false;
			}

			// Long-tail auto output: commit watermark & mark shown, but suppress display
			if (shouldSuppressAutoRecapDisplay(raw, summary)) {
				commitWatermark(mainTurns);
				recapInFlight = false;
				focusTracker.markRecapShown();
				return false;
			}

			commitWatermark(mainTurns);
			recapInFlight = false;
			focusTracker.markRecapShown();

			const chatContainer = options.getChatContainer?.();
			const themeToUse = options.getTheme?.() ?? cachedTheme;
			if (chatContainer && themeToUse) {
				const liveView = new RecapEntryView(summary, () => options.getTheme?.() ?? themeToUse, false, 1, onRequestRender);
				const liveWrapper = new Container();
				liveWrapper.addChild(new Spacer(1));
				liveWrapper.addChild(liveView);
				chatContainer.addChild(liveWrapper);
				onRequestRender();
				return true;
			}

			const preview = Array.from(summary).slice(0, RECAP_PERSIST_MAX_CHARS).join("");
			const data: RecapEntryData = {
				summary,
				preview,
				auto: true,
				mainTurns,
				timestamp: nowFn(),
			};
			pi.appendEntry?.(RECAP_ENTRY_TYPE, data);
			onRequestRender();
			return true;
		} catch {
			recapInFlight = false;
			return false;
		}
	}

	function startPolling(): void {
		stopPolling();
		if (pollIntervalMs <= 0) return;
		pollTimer = setInterval(() => {
			if (focusTracker.recapDue(nowFn()) && isEligibleForAutoRecap()) {
				void handleAutoRecap();
			}
		}, pollIntervalMs);
		pollTimer.unref?.();
	}

	function stopPolling(): void {
		if (pollTimer) {
			clearInterval(pollTimer);
			pollTimer = undefined;
		}
	}

	return {
		focusTracker,
		onSessionStart(ctx: ExtensionContext) {
			activeCtx = ctx;
			recapEpoch++;
			recapInFlight = false;
			focusTracker.onFocusGained();
			try {
				cachedTheme = options.getTheme?.() ?? ctx.ui?.theme ?? cachedTheme;
				const entries = ctx.sessionManager?.getEntries?.() ?? [];
				lastRecapMainTurn = 0;
				syncWatermark(entries);
				const persistedTs = extractLastEntryTimestamp(entries);
				lastTurnEndAt = persistedTs > 0 ? persistedTs : entries.length > 0 ? nowFn() : 0;
			} catch {
				lastTurnEndAt = 0;
			}
			startPolling();
		},
		onTurnSettled(ctx: ExtensionContext) {
			activeCtx = ctx;
			try {
				const entries = ctx.sessionManager?.getEntries?.() ?? [];
				syncWatermark(entries);
			} catch {
				// ignore stale ctx
			}
			lastTurnEndAt = nowFn();
		},
		onNewPrompt() {
			recapEpoch++;
		},
		onTerminalInput(data: string) {
			const now = nowFn();
			if (data === "\x1b[O") {
				focusTracker.onFocusLost(now);
			} else if (data === "\x1b[I") {
				const due = focusTracker.recapDue(now);
				focusTracker.onFocusGained();
				if (due && isEligibleForAutoRecap()) {
					void handleAutoRecap();
				}
			}
		},
		triggerAutoRecap() {
			return handleAutoRecap();
		},
		dispose() {
			stopPolling();
			recapEpoch++;
			recapInFlight = false;
			activeCtx = undefined;
		},
	};
}
