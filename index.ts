/**
 * pi-tweaks: message hover brackets and a question timeline. Tested with Pi 1.0.4.
 *
 * Loading the extension enables both features. There are no per-feature switches
 * or preference files; manage the extension through Pi's resource configuration.
 * /question-nav <number> provides keyboard-only viewport navigation.
 *
 * Renderer hooks and scroll-view sizing overrides are scoped to active instances.
 * Screen chrome never enters model context, session history, or copied document text.
 * Unload/reload restores methods, content widths and scrollbar settings. Private TUI hooks may need adapting after Pi upgrades.
 */
import {
	type ExtensionAPI,
	type ExtensionContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { compositeTuiLine, Spacer, sliceByColumn, stripTerminalSequences,
	type Component, type TUI } from "@earendil-works/pi-tui";
import { contains, transcriptContainer, flowChildren, chatEntryBox, questionSnapshot, navEligible,
	computeQuestionRail, railContains, railGutterContains, railHit, paintQuestionNavigation, NAV_GUTTER_WIDTH,
	type LayoutBox, type LayoutFrame, type Pointer, type ChatScrollView, type ScrollbarMode,
	type QuestionRail } from "./lib/question-navigation.ts";

/** Internal test injection points, not plugin settings or persisted configuration. */
interface PiTweaksOptions {
	frames?: () => boolean;
	questionNav?: () => boolean;
}
export interface PiTweaksController {
	(): void;
	jumpToQuestion(index: number): boolean;
	questionCount(): number;
}
interface NavigationLease {
	active: boolean;
	scrollbar: ScrollbarMode;
	contentWidth: ChatScrollView["getContentWidth"];
	widthDescriptor?: PropertyDescriptor;
	patchedWidth: ChatScrollView["getContentWidth"];
}
interface HoverTUI extends TUI {
	currentLayout?: LayoutFrame;
	hasActiveSelection(): boolean;
	handleViewportInput(data: string): unknown;
	compositeScrollToEndIndicator(screen: string[], layout: LayoutFrame, width: number): string[];
	selectionPressActive?: boolean;
	mouseCapture?: unknown;
	mousePressTarget?: unknown;
	scrollbarDrag?: unknown;
	activeSearch?: unknown;
	clearTextSelection?(): void;
	closeSearch?(): void;
}

const WIDGET_KEY = "pi-tweaks-controller";
const MOUSE_MOVE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/;

function hoveredChatEntry(box: LayoutBox, pointer: Pointer, chat: Component): LayoutBox | undefined {
	if (!box.rect || !box.clip || !Array.isArray(box.children) ||
		!contains(box.rect, pointer) || !contains(box.clip, pointer)) return undefined;
	const children = flowChildren(box);
	if (box.component === chat) {
		const entry = children.find((child) => contains(child.rect, pointer) && contains(child.clip, pointer));
		if (!entry || entry.component instanceof Spacer) return undefined;
		// Every message type qualifies, including user and skill invocation entries.
		return entry;
	}
	for (let i = children.length - 1; i >= 0; i--) {
		const result = hoveredChatEntry(children[i], pointer, chat);
		if (result) return result;
	}
	return undefined;
}

/** Exported for the local regression tests; not a supported Pi renderer API. */
export function installPiTweaks(tui: TUI, getTheme: () => Theme, options: PiTweaksOptions = {}): PiTweaksController {
	const reference = tui as HoverTUI;
	if (reference.mode !== "fullscreen" || typeof reference.handleViewportInput !== "function" ||
		typeof reference.compositeScrollToEndIndicator !== "function" || typeof reference.hasActiveSelection !== "function") {
		throw new Error("pi-tweaks needs Pi's compatible fullscreen TUI (tested with 1.0.4).");
	}
	// Widget factories receive a stable TUI Proxy. defineProperty on that Proxy
	// does NOT reach its renderer, whereas method calls are bound to the renderer.
	// A short-lived, uniquely named method recovers that receiver; remove it immediately.
	const probe = Symbol("pi-tweaks-renderer");
	let renderer: HoverTUI | undefined;
	if (!Reflect.set(reference, probe, function (this: HoverTUI) { return this; })) {
		throw new Error("Cannot access the active fullscreen renderer.");
	}
	try {
		renderer = Reflect.get(reference, probe).call(reference) as HoverTUI;
	} finally {
		Reflect.deleteProperty(renderer ?? reference, probe);
	}
	if (!renderer) throw new Error("Cannot resolve the active fullscreen renderer.");
	const ui = renderer;

	const inputDescriptor = Object.getOwnPropertyDescriptor(ui, "handleViewportInput");
	const paintDescriptor = Object.getOwnPropertyDescriptor(ui, "compositeScrollToEndIndicator");
	const originalInput = ui.handleViewportInput;
	const originalPaint = ui.compositeScrollToEndIndicator;
	let pointer: Pointer | undefined;
	let disposed = false;
	let lastRail: QuestionRail | undefined;
	let selectedQuestion: Component | undefined;
	let navPress: { point: Pointer; component?: Component; moved: boolean } | undefined;
	const scrollbarLeases = new Map<ChatScrollView, NavigationLease>();
	const framesEnabled = () => options.frames?.() ?? true;
	const navEnabled = () => options.questionNav?.() ?? true;
	const term = process.env.TERM?.toLowerCase() ?? "";
	const insideMux = process.env.TMUX !== undefined || process.env.ZELLIJ !== undefined ||
		process.env.STY !== undefined || term.startsWith("tmux") || term.startsWith("screen");

	function restoreScrollbars(except?: ChatScrollView): void {
		for (const [scroll, lease] of scrollbarLeases) {
			if (scroll === except) continue;
			scrollbarLeases.delete(scroll);
			lease.active = false;
			if (scroll.getContentWidth === lease.patchedWidth) {
				if (lease.widthDescriptor) Object.defineProperty(scroll, "getContentWidth", lease.widthDescriptor);
				else delete (scroll as Partial<ChatScrollView>).getContentWidth;
			}
			if (scroll.scrollbar === "always") scroll.setScrollbar(lease.scrollbar);
			ui.requestRender();
		}
	}
	function navigationRail(layout: LayoutFrame, width: number): QuestionRail | undefined {
		const snapshot = questionSnapshot(layout);
		if (!navEnabled() || !snapshot || !navEligible(snapshot, width)) {
			restoreScrollbars();
			return undefined;
		}
		const scroll = snapshot.scroll;
		restoreScrollbars(scroll);
		let lease = scrollbarLeases.get(scroll);
		if (!lease) {
			if (typeof scroll.getContentWidth !== "function") return undefined;
			const originalWidth = scroll.getContentWidth;
			const acquired: NavigationLease = {
				active: true, scrollbar: scroll.scrollbar, contentWidth: originalWidth,
				widthDescriptor: Object.getOwnPropertyDescriptor(scroll, "getContentWidth"),
				patchedWidth: function (this: ChatScrollView, available: number): number {
					const nativeWidth = originalWidth.call(this, available);
					return acquired.active ? Math.max(1, Math.min(nativeWidth, available - NAV_GUTTER_WIDTH)) : nativeWidth;
				},
			};
			lease = acquired;
			Object.defineProperty(scroll, "getContentWidth", { configurable: true, writable: true, value: acquired.patchedWidth });
			scrollbarLeases.set(scroll, acquired);
			ui.requestRender();
		} else if (scroll.scrollbar !== "always") lease.scrollbar = scroll.scrollbar;
		if (scroll.scrollbar !== "always") scroll.setScrollbar("always");
		// Wait for native reflow to reserve the entire hit area and outer padding.
		if ((snapshot.box.children[0]?.rect.width ?? snapshot.box.rect.width) > snapshot.box.rect.width - NAV_GUTTER_WIDTH) return undefined;
		return computeQuestionRail(snapshot, selectedQuestion);
	}
	function jumpToQuestion(index: number, component?: Component): boolean {
		const snapshot = questionSnapshot(ui.currentLayout);
		if (!snapshot || ui.hasOverlay()) return false;
		const question = component ? snapshot.questions.find((entry) => entry.component === component) :
			Number.isInteger(index) && index >= 0 ? snapshot.questions[index] : undefined;
		if (!question) return false;
		if (ui.activeSearch) ui.closeSearch?.();
		ui.clearTextSelection?.();
		pointer = undefined;
		navPress = undefined;
		selectedQuestion = question.component;
		snapshot.scroll.scrollTo(question.row, { disableFollow: true });
		ui.requestRender();
		return true;
	}
	function nativeGesture(): boolean {
		return !!(ui.selectionPressActive || ui.mouseCapture || ui.mousePressTarget || ui.scrollbarDrag);
	}
	function navHoverKey(): string {
		const hit = navEnabled() && lastRail ? railHit(lastRail, pointer) : undefined;
		return hit ? `${hit.kind}:${hit.index ?? "disabled"}` : "";
	}
	function getBox(layout = ui.currentLayout): LayoutBox | undefined {
		if (!framesEnabled() || !pointer || !layout?.root || ui.hasOverlay() || ui.hasActiveSelection()) return undefined;
		const chat = transcriptContainer(layout);
		return chat ? hoveredChatEntry(layout.root, pointer, chat) : undefined;
	}

	const patchedInput = function (this: HoverTUI, data: string): unknown {
		if (disposed) return originalInput.call(this, data);
		const previous = getBox()?.component;
		const previousSelected = selectedQuestion;
		const previousHit = navHoverKey();
		const mouse = MOUSE_MOVE.exec(data);
		const button = mouse ? Number(mouse[1]) : 0;
		const point = mouse ? { x: Number(mouse[2]) - 1, y: Number(mouse[3]) - 1 } : undefined;
		const release = mouse?.[4] === "m";
		const movement = !!mouse && !release && (button & 32) !== 0 && (button & 64) === 0 && (button & 3) === 3;
		if (navPress && point) {
			const press = navPress;
			if (point.x !== press.point.x || point.y !== press.point.y) press.moved = true;
			pointer = undefined;
			if (release) {
				navPress = undefined;
				if (!press.moved && press.component) jumpToQuestion(0, press.component);
			}
			ui.requestRender();
			return { consume: true };
		}
		if (!mouse) navPress = undefined;
		if (navEnabled() && lastRail && point && !ui.hasOverlay() && !nativeGesture() &&
			(button & 28) === 0 && railContains(lastRail, point)) {
			const hit = railHit(lastRail, point);
			if ((button & 64) !== 0) {
				jumpToQuestion(lastRail.active + ((button & 1) === 0 ? -1 : 1));
				pointer = undefined;
				return { consume: true };
			}
			if (!release && (button & 32) === 0 && (button & 3) === 0) {
				navPress = { point, component: hit?.index === undefined ? undefined : lastRail.questions[hit.index]?.component, moved: false };
				pointer = undefined;
				ui.requestRender();
				return { consume: true };
			}
			if (movement) {
				pointer = point;
				if (previous !== getBox()?.component || previousHit !== navHoverKey()) ui.requestRender();
				return { consume: true }; // Keep native scrollbar dragging out of the question rail.
			}
		}
		// The empty edge padding is not a hidden native scrollbar target.
		// Keep native text drags and wheel scrolling intact, but consume idle motion/clicks here.
		if (navEnabled() && lastRail && point && !ui.hasOverlay() && !nativeGesture() &&
			(button & 28) === 0 && railGutterContains(lastRail, point) && (button & 64) === 0) {
			if (!release && (button & 32) === 0 && (button & 3) === 0) {
				navPress = { point, moved: false };
				pointer = undefined;
				ui.requestRender();
				return { consume: true };
			}
			if (movement) {
				pointer = point;
				if (previous !== getBox()?.component || previousHit !== navHoverKey()) ui.requestRender();
				return { consume: true };
			}
		}
		pointer = movement ? point : undefined;
		const scroll = ui.currentLayout?.primaryScrollView;
		const oldTop = scroll?.scrollTop;
		const result = originalInput.call(this, data);
		if (oldTop !== scroll?.scrollTop || (button & 64) !== 0) selectedQuestion = undefined;
		if (previous !== getBox()?.component || previousHit !== navHoverKey() || previousSelected !== selectedQuestion) ui.requestRender();
		return result;
	};

	const patchedPaint = function (this: HoverTUI, screen: string[], layout: LayoutFrame, width: number): string[] {
		const hovered = disposed ? undefined : getBox(layout);
		const target = !disposed && framesEnabled() && selectedQuestion && !ui.hasOverlay() && !ui.hasActiveSelection()
			? chatEntryBox(layout, selectedQuestion) : undefined;
		const brackets: { box: LayoutBox; color: "borderMuted" | "accent" }[] = [];
		if (hovered && hovered.component !== target?.component) brackets.push({ box: hovered, color: "borderMuted" });
		if (target) brackets.push({ box: target, color: "accent" });
		let decorated = screen;
		for (const { box, color } of brackets) {
			const column = box.rect.x;
			const top = Math.max(0, box.rect.y, box.clip.y);
			const bottom = Math.min(screen.length, box.rect.y + box.rect.height, box.clip.y + box.clip.height);
			if (column >= Math.max(0, box.clip.x) && column < Math.min(width, box.clip.x + box.clip.width)) {
				if (decorated === screen) decorated = [...screen];
				const theme = getTheme();
				for (let row = top; row < bottom; row++) {
					const first = stripTerminalSequences(sliceByColumn(screen[row] ?? "", column, width - column, true))[0] ?? "";
					// Some self-rendered/custom entries have no margin. Never erase a payload character;
					// existing whitespace and box-border cells are safe to use as screen chrome.
					if (first !== "" && first !== " " && !/[─━│┃┌┐└┘╭╮╰╯]/u.test(first)) continue;
					const glyph = box.rect.height <= 1 ? "│" : row === box.rect.y ? "┌" :
						row === box.rect.y + box.rect.height - 1 ? "└" : "│";
					decorated[row] = compositeTuiLine(screen[row] ?? "", theme.fg(color, glyph), column, 1, width);
				}
			}
		}
		// Screen-only chrome: native copy uses the unchanged document, never these decorations.
		const result = originalPaint.call(this, decorated, layout, width);
		lastRail = disposed ? undefined : navigationRail(layout, width);
		return lastRail ? paintQuestionNavigation(result, lastRail, getTheme(), width,
			ui.hasOverlay() || nativeGesture() ? undefined : pointer, !ui.hasActiveSelection()) : result;
	};

	Object.defineProperty(ui, "handleViewportInput", { configurable: true, writable: true, value: patchedInput });
	Object.defineProperty(ui, "compositeScrollToEndIndicator", { configurable: true, writable: true, value: patchedPaint });
	// Pi normally omits all-motion tracking in multiplexers; opt in only while this extension is active.
	if (insideMux) ui.terminal.write("\x1b[?1003h");

	const dispose = () => {
		if (disposed) return;
		disposed = true;
		pointer = undefined;
		navPress = undefined;
		lastRail = undefined;
		restoreScrollbars();
		if (ui.handleViewportInput === patchedInput) {
			if (inputDescriptor) Object.defineProperty(ui, "handleViewportInput", inputDescriptor);
			else delete (ui as Partial<HoverTUI>).handleViewportInput;
		}
		if (ui.compositeScrollToEndIndicator === patchedPaint) {
			if (paintDescriptor) Object.defineProperty(ui, "compositeScrollToEndIndicator", paintDescriptor);
			else delete (ui as Partial<HoverTUI>).compositeScrollToEndIndicator;
		}
		if (insideMux) ui.terminal.write("\x1b[?1003l");
		ui.requestRender();
	};
	return Object.assign(dispose, { jumpToQuestion: (index: number) => jumpToQuestion(index),
		questionCount: () => questionSnapshot(ui.currentLayout)?.questions.length ?? 0 });
}

export default function piTweaks(pi: ExtensionAPI): void {
	let detach: PiTweaksController | undefined;
	function remove(): void {
		detach?.();
		detach = undefined;
	}
	pi.on("session_start", (_event, ctx) => {
		remove();
		if (!ctx.hasUI || ctx.mode !== "tui") return;
		ctx.ui.setWidget(WIDGET_KEY, (tui) => {
			if (tui.mode === "fullscreen") {
				try {
					detach = installPiTweaks(tui, () => ctx.ui.theme);
				} catch (error) {
					ctx.ui.notify(`pi-tweaks could not attach: ${error instanceof Error ? error.message : String(error)}`, "warning");
				}
			} else {
				ctx.ui.notify("pi-tweaks needs fullscreen mode. Switch modes, then /reload.", "info");
			}
			// A zero-height widget obtains the active TUI without replacing editor/header/footer.
			return { render: () => [], invalidate() {}, dispose: remove };
		});
	});
	pi.on("session_shutdown", remove);
	pi.registerCommand("question-nav", {
		description: "Scroll to a user question: /question-nav <question number>",
		handler: async (args, ctx) => {
			const number = args.trim();
			if (!/^\d+$/.test(number) || Number(number) < 1) {
				ctx.ui.notify(`Usage: /question-nav <number>. ${detach?.questionCount() ?? 0} questions are rendered.`, number ? "warning" : "info");
				return;
			}
			if (!detach?.jumpToQuestion(Number(number) - 1)) {
				ctx.ui.notify(`Cannot jump to question ${number}. ${detach?.questionCount() ?? 0} questions are rendered; fullscreen UI is required.`, "warning");
			}
		},
	});
}
