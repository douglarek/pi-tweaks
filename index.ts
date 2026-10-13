/**
 * pi-tweaks: compact tool calls, hover brackets, question navigation and a minimal jump arrow.
 * Tested with Pi 1.0.4 – 1.2.0.
 *
 * Loading the extension enables all tweaks. There are no per-feature switches
 * or preference files; manage the extension through Pi's resource configuration.
 * /question-nav <number> provides keyboard-only viewport navigation.
 *
 * Renderer hooks and scroll-view sizing overrides are scoped to active instances.
 * Screen chrome never enters model context, session history, or copied document text.
 * Unload/reload restores methods, content widths and scrollbar settings. Private TUI hooks may need adapting after Pi upgrades.
 */
import {
	AssistantMessageComponent,
	ToolExecutionComponent,
	type ExtensionAPI,
	type ExtensionContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { compositeTuiLine, Container, MouseRegion, Spacer, sliceByColumn, stripTerminalSequences,
	type Component, type TUI } from "@earendil-works/pi-tui";
import { contains, transcriptContainer, flowChildren, chatEntryBox, questionSnapshot, navEligible,
	computeQuestionRail, railContains, railGutterContains, railHit, paintQuestionNavigation, NAV_GUTTER_WIDTH,
	type LayoutBox, type LayoutFrame, type Pointer, type ChatScrollView, type ScrollbarMode,
	type QuestionRail } from "./lib/question-navigation.ts";
import { createToolCompactor } from "./lib/compact-tools.ts";
import { PromptSuggestionState, paintPromptSuggestion, handlePromptSuggestionInput,
	buildTranscript, sanitizeSuggestion } from "./lib/prompt-suggestion.ts";
import { installQueueDispatch, type QueueDispatchController, type SessionLike } from "./lib/queue-dispatch.ts";
import { installCompactFooter, type CompactFooterController } from "./lib/compact-footer.ts";
import { installDashboardCommands, registerDashboardTui, registerDashboardSession, registerDashboardEditor } from "./lib/dashboard.ts";
import { resolveSession, resolveEditor } from "./lib/queue-dispatch.ts";
import {
	createRecapController,
	RecapEntryView,
	RECAP_ENTRY_TYPE,
	type RecapEntryData,
} from "./lib/recap.ts";
import { installWebSearch } from "./lib/web-search.ts";

/** Internal test injection points, not plugin settings or persisted configuration. */
interface PiTweaksOptions {
	frames?: () => boolean;
	questionNav?: () => boolean;
	promptSuggestions?: () => boolean;
	queueDispatch?: () => boolean;
	footer?: () => boolean;
	session?: () => SessionLike | undefined;
	onTerminalInput?: (data: string) => void;
}
export interface PiTweaksController {
	(): void;
	jumpToQuestion(index: number): boolean;
	questionCount(): number;
	setSuggestion?(text: string | null): void;
	getSuggestion?(): string | null;
	clearSuggestion?(): void;
	dispatchQueuedMessage?(): Promise<boolean>;
	isFooterHovered?(): boolean;
	setFooterHovered?(hovered: boolean): boolean;
	hasOverlay?(): boolean;
	requestRender?(): void;
	getChatContainer?(): Container | undefined;
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
	doRender(): void;
	layoutRoot?: Component;
	scrollToEndIndicator?: () => string;
	scrollToEndIndicatorRect?: { row: number; column: number; width: number };
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

interface HoverSegment {
	box: LayoutBox;
	/**
	 * Matches grok-build Mode B (`group_selection_split = true` / `can_join_dense_run`):
	 * true for collapsed groupable blocks (collapsed Thinking and collapsed ToolExecutionComponent).
	 * Expanded blocks and non-groupable blocks (Assistant reply text, User messages) are false
	 * and always receive their own standalone bracket.
	 */
	canJoinDenseRun: boolean;
}

interface AssistantInternals {
	hideThinkingBlock?: boolean;
	thinkingVisibilityOverrides?: Map<number, boolean>;
}

function isThoughtCollapsed(asst: AssistantInternals, runIndex: number): boolean {
	return Boolean(asst.thinkingVisibilityOverrides?.get(runIndex) ?? asst.hideThinkingBlock);
}

function decomposeAssistantBox(entry: LayoutBox): HoverSegment[] {
	if (entry.rect.height <= 0) return [];
	const contentChildren = flowChildren(entry);
	if (contentChildren.length !== 1) return [{ box: entry, canJoinDenseRun: false }];
	const contentContainer = contentChildren[0];
	const inner = flowChildren(contentContainer);
	if (inner.length === 0) return [{ box: entry, canJoinDenseRun: false }];

	// Only split when the assistant message contains thinking blocks (MouseRegion)
	const hasThinking = inner.some((child) => child.component instanceof MouseRegion);
	if (!hasThinking) return [{ box: entry, canJoinDenseRun: false }];

	const asst = entry.component as unknown as AssistantInternals;
	const segments: HoverSegment[] = [];
	let pendingSpacer: LayoutBox | undefined;
	let currentTextGroup: LayoutBox | undefined;
	let thinkingRunIndex = 0;

	const flushTextGroup = () => {
		if (currentTextGroup) {
			segments.push({ box: currentTextGroup, canJoinDenseRun: false });
			currentTextGroup = undefined;
		}
	};

	for (const child of inner) {
		if (child.rect.height <= 0) continue;
		if (child.component instanceof Spacer) {
			pendingSpacer = child;
			continue;
		}

		if (child.component instanceof MouseRegion) {
			flushTextGroup();
			const runIndex = thinkingRunIndex++;
			const collapsed = isThoughtCollapsed(asst, runIndex);
			const topY = pendingSpacer ? pendingSpacer.rect.y : child.rect.y;
			const bottomY = child.rect.y + child.rect.height;
			pendingSpacer = undefined;
			segments.push({
				box: {
					component: child.component,
					rect: { x: entry.rect.x, y: topY, width: entry.rect.width, height: bottomY - topY },
					clip: entry.clip,
					children: [],
				},
				canJoinDenseRun: collapsed,
			});
		} else {
			// Reply text / markdown / error notice block (non-groupable)
			if (!currentTextGroup) {
				const topY = pendingSpacer ? pendingSpacer.rect.y : child.rect.y;
				const bottomY = child.rect.y + child.rect.height;
				pendingSpacer = undefined;
				currentTextGroup = {
					component: child.component,
					rect: { x: entry.rect.x, y: topY, width: entry.rect.width, height: bottomY - topY },
					clip: entry.clip,
					children: [],
				};
			} else {
				const bottomY = child.rect.y + child.rect.height;
				pendingSpacer = undefined;
				currentTextGroup.rect = {
					...currentTextGroup.rect,
					height: bottomY - currentTextGroup.rect.y,
				};
			}
		}
	}

	flushTextGroup();
	return segments.length > 0 ? segments : [{ box: entry, canJoinDenseRun: false }];
}

function chatHoverSegments(chatBox: LayoutBox): LayoutBox[] {
	const rawEntries = flowChildren(chatBox);
	const atomic: HoverSegment[] = [];

	for (const entry of rawEntries) {
		if (!entry.rect || entry.rect.height <= 0 || entry.component instanceof Spacer) continue;
		if (entry.component instanceof AssistantMessageComponent) {
			atomic.push(...decomposeAssistantBox(entry));
		} else if (entry.component instanceof ToolExecutionComponent) {
			const isExpanded = Boolean((entry.component as unknown as { expanded?: boolean }).expanded);
			atomic.push({ box: entry, canJoinDenseRun: !isExpanded });
		} else {
			atomic.push({ box: entry, canJoinDenseRun: false });
		}
	}

	// Mode B grouping: merge contiguous collapsed groupable blocks (collapsed tools + collapsed thoughts)
	const grouped: HoverSegment[] = [];
	for (const item of atomic) {
		const prev = grouped[grouped.length - 1];
		if (item.canJoinDenseRun && prev?.canJoinDenseRun) {
			const bottomY = item.box.rect.y + item.box.rect.height;
			prev.box.rect = {
				...prev.box.rect,
				height: bottomY - prev.box.rect.y,
			};
		} else {
			grouped.push({
				canJoinDenseRun: item.canJoinDenseRun,
				box: {
					...item.box,
					rect: { ...item.box.rect },
				},
			});
		}
	}

	return grouped.map((g) => g.box);
}

function hoveredChatEntry(box: LayoutBox, pointer: Pointer, chat: Component): LayoutBox | undefined {
	if (!box.rect || !box.clip || !Array.isArray(box.children) ||
		!contains(box.rect, pointer) || !contains(box.clip, pointer)) return undefined;
	if (box.component === chat) {
		const segments = chatHoverSegments(box);
		return segments.find((seg) => contains(seg.rect, pointer) && contains(seg.clip, pointer));
	}
	const children = flowChildren(box);
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
		typeof reference.compositeScrollToEndIndicator !== "function" || typeof reference.hasActiveSelection !== "function" ||
		typeof reference.doRender !== "function") {
		throw new Error("pi-tweaks needs Pi's compatible fullscreen TUI (tested with 1.0.4 – 1.2.0).");
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
	const renderDescriptor = Object.getOwnPropertyDescriptor(ui, "doRender");
	const indicatorDescriptor = Object.getOwnPropertyDescriptor(ui, "scrollToEndIndicator");
	const originalInput = ui.handleViewportInput;
	const originalPaint = ui.compositeScrollToEndIndicator;
	const originalRender = ui.doRender;
	const originalIndicator = ui.scrollToEndIndicator;
	const tools = createToolCompactor();
	let pointer: Pointer | undefined;
	let disposed = false;
	let lastRail: QuestionRail | undefined;
	let selectedQuestion: Component | undefined;
	let navPress: { point: Pointer; component?: Component; moved: boolean } | undefined;
	const scrollbarLeases = new Map<ChatScrollView, NavigationLease>();
	const suggestionState = new PromptSuggestionState();
	const queueDispatchEnabled = () => options.queueDispatch?.() ?? true;
	const queueController = installQueueDispatch(ui, {
		session: options.session,
		enabled: queueDispatchEnabled,
		onRequestRender: () => ui.requestRender(),
	});
	const footerEnabled = () => options.footer?.() ?? true;
	const footerController = installCompactFooter(ui, getTheme, {
		enabled: footerEnabled,
	});
	footerController.checkFooter(ui.layoutRoot ?? ui.currentLayout?.root.component);
	registerDashboardTui(ui);
	const resolvedSess = options.session?.() ?? resolveSession(ui.layoutRoot ?? ui.currentLayout?.root?.component);
	if (resolvedSess) registerDashboardSession(resolvedSess);
	const resolvedEd = resolveEditor(ui.layoutRoot ?? ui.currentLayout?.root?.component);
	if (resolvedEd) registerDashboardEditor(resolvedEd);
	const framesEnabled = () => options.frames?.() ?? true;
	const navEnabled = () => options.questionNav?.() ?? true;
	const suggestionsEnabled = () => options.promptSuggestions?.() ?? true;
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
		if (!framesEnabled() || !pointer || !layout?.root || ui.hasOverlay() || ui.hasActiveSelection() ||
			isIndicatorHovered(layout)) return undefined;
		const chat = transcriptContainer(layout);
		return chat ? hoveredChatEntry(layout.root, pointer, chat) : undefined;
	}

	function getBoxKey(box = getBox()): string {
		return box ? `${box.rect.y}:${box.rect.height}` : "";
	}
	function findScrollViewBox(box: LayoutBox, target: Component): LayoutBox | undefined {
		if (box.component === target) return box;
		for (const child of box.children) {
			const found = findScrollViewBox(child, target);
			if (found) return found;
		}
		return undefined;
	}
	function indicatorRect(layout = ui.currentLayout): { row: number; column: number; width: number } | undefined {
		if (disposed || !layout?.root || ui.hasOverlay() || ui.activeSearch) return undefined;
		const scrollView = layout.primaryScrollView as (ChatScrollView & { followEnd?: boolean }) | undefined;
		if (!scrollView || scrollView.followEnd === false || scrollView.isFollowingEnd) return undefined;
		const box = findScrollViewBox(layout.root, scrollView);
		const clip = box?.clip;
		if (!clip || clip.width < 3 || clip.height <= 0) return undefined;
		return {
			row: clip.y + clip.height - 1,
			column: clip.x + Math.floor((clip.width - 3) / 2),
			width: 3,
		};
	}
	function isIndicatorHovered(layout = ui.currentLayout): boolean {
		if (!pointer || nativeGesture()) return false;
		const rect = indicatorRect(layout) ?? ui.scrollToEndIndicatorRect;
		if (!rect) return false;
		return pointer.y === rect.row && pointer.x >= rect.column && pointer.x < rect.column + rect.width;
	}

	const patchedInput = function (this: HoverTUI, data: string): unknown {
		if (disposed) return originalInput.call(this, data);
		const previous = getBox()?.component;
		const previousBoxKey = getBoxKey();
		const previousSelected = selectedQuestion;
		const previousHit = navHoverKey();
		const previousFooterHover = footerController.isHovered();
		const previousIndicatorHover = isIndicatorHovered();
		if (data === "\x1b[O") {
			pointer = undefined;
			if (footerController.setHovered(false) || previousIndicatorHover) ui.requestRender();
		}
		options.onTerminalInput?.(data);
		const mouse = MOUSE_MOVE.exec(data);
		if (!mouse && suggestionsEnabled() && !ui.hasOverlay()) {
			const outcome = handlePromptSuggestionInput(data, ui.currentLayout, suggestionState, () => ui.requestRender());
			if (outcome) return outcome;
		}
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
		if (footerEnabled()) {
			footerController.checkPointer(movement ? point : undefined, ui.terminal.rows, ui.currentLayout);
		}
		const scroll = ui.currentLayout?.primaryScrollView;
		const oldTop = scroll?.scrollTop;
		const result = originalInput.call(this, data);
		if (oldTop !== scroll?.scrollTop || (button & 64) !== 0) selectedQuestion = undefined;
		if (previous !== getBox()?.component || previousBoxKey !== getBoxKey() || previousHit !== navHoverKey() ||
			previousSelected !== selectedQuestion || previousFooterHover !== footerController.isHovered() ||
			previousIndicatorHover !== isIndicatorHovered()) ui.requestRender();
		return result;
	};

	let paintingLayout: LayoutFrame | undefined;
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
		paintingLayout = layout;
		let result: string[];
		try {
			result = originalPaint.call(this, decorated, layout, width);
		} finally {
			paintingLayout = undefined;
		}
		lastRail = disposed ? undefined : navigationRail(layout, width);
		let finalScreen = lastRail ? paintQuestionNavigation(result, lastRail, getTheme(), width,
			ui.hasOverlay() || nativeGesture() ? undefined : pointer, !ui.hasActiveSelection()) : result;
		if (!disposed && suggestionsEnabled() && !ui.hasOverlay()) {
			finalScreen = paintPromptSuggestion(finalScreen, layout, suggestionState, getTheme(), width);
		}
		return finalScreen;
	};

	const patchedRender = function (this: HoverTUI): void {
		if (!disposed) {
			tools.prepare(this.layoutRoot ?? this.currentLayout?.root.component);
			queueController.checkEditor();
			footerController.checkFooter(this.layoutRoot ?? this.currentLayout?.root.component);
		}
		originalRender.call(this);
	};
	const minimalIndicator = () => {
		if (disposed) return originalIndicator?.() ?? "";
		if (ui.hasOverlay() || ui.activeSearch) return "";
		const hovered = isIndicatorHovered(paintingLayout ?? ui.currentLayout);
		return getTheme().fg(hovered ? "text" : "muted", " ▼ ");
	};
	if (typeof originalIndicator === "function") {
		Object.defineProperty(ui, "scrollToEndIndicator", { configurable: true, writable: true, value: minimalIndicator });
	}
	Object.defineProperty(ui, "doRender", { configurable: true, writable: true, value: patchedRender });
	Object.defineProperty(ui, "handleViewportInput", { configurable: true, writable: true, value: patchedInput });
	Object.defineProperty(ui, "compositeScrollToEndIndicator", { configurable: true, writable: true, value: patchedPaint });
	// Pi normally omits all-motion tracking in multiplexers; opt in only while this extension is active.
	if (insideMux) ui.terminal.write("\x1b[?1003h");

	const dispose = () => {
		if (disposed) return;
		disposed = true;
		queueController.dispose();
		footerController.dispose();
		pointer = undefined;
		navPress = undefined;
		lastRail = undefined;
		suggestionState.clear();
		tools.restore();
		restoreScrollbars();
		if (ui.doRender === patchedRender) {
			if (renderDescriptor) Object.defineProperty(ui, "doRender", renderDescriptor);
			else delete (ui as Partial<HoverTUI>).doRender;
		}
		if (ui.scrollToEndIndicator === minimalIndicator) {
			if (indicatorDescriptor) Object.defineProperty(ui, "scrollToEndIndicator", indicatorDescriptor);
			else delete (ui as Partial<HoverTUI>).scrollToEndIndicator;
		}
		if (ui.handleViewportInput === patchedInput) {
			if (inputDescriptor) Object.defineProperty(ui, "handleViewportInput", inputDescriptor);
			else delete (ui as Partial<HoverTUI>).handleViewportInput;
		}
		if (ui.compositeScrollToEndIndicator === patchedPaint) {
			if (paintDescriptor) Object.defineProperty(ui, "compositeScrollToEndIndicator", paintDescriptor);
			else delete (ui as Partial<HoverTUI>).compositeScrollToEndIndicator;
		}
		if (insideMux) ui.terminal.write("\x1b[?1003l");
		registerDashboardTui(null);
		ui.requestRender();
	};
	return Object.assign(dispose, {
		jumpToQuestion: (index: number) => jumpToQuestion(index),
		questionCount: () => questionSnapshot(ui.currentLayout)?.questions.length ?? 0,
		setSuggestion: (text: string | null) => {
			suggestionState.setSuggestion(text);
			if (typeof (ui as unknown as { renderNow?: (force?: boolean) => void }).renderNow === "function") {
				(ui as unknown as { renderNow: (force?: boolean) => void }).renderNow(true);
			} else {
				ui.requestRender(true);
			}
		},
		getSuggestion: () => suggestionState.getSuggestion(),
		clearSuggestion: () => {
			suggestionState.clear();
			if (typeof (ui as unknown as { renderNow?: (force?: boolean) => void }).renderNow === "function") {
				(ui as unknown as { renderNow: (force?: boolean) => void }).renderNow(true);
			} else {
				ui.requestRender(true);
			}
		},
		dispatchQueuedMessage: () => queueController.dispatchNow(),
		isFooterHovered: () => footerController.isHovered(),
		setFooterHovered: (hovered: boolean) => {
			const changed = footerController.setHovered(hovered);
			if (changed) ui.requestRender();
			return changed;
		},
		hasOverlay: () => ui.hasOverlay(),
		requestRender: () => ui.requestRender(),
		getChatContainer: () => ui.currentLayout ? transcriptContainer(ui.currentLayout) as Container | undefined : undefined,
	});
}

export default function piTweaks(pi: ExtensionAPI): void {
	let detach: PiTweaksController | undefined;
	let activeTheme: Theme | undefined;
	const recap = createRecapController(
		pi,
		() => detach?.hasOverlay?.() ?? false,
		() => detach?.requestRender?.(),
		{
			getChatContainer: () => detach?.getChatContainer?.(),
			getTheme: () => activeTheme,
		},
	);
	function remove(): void {
		recap.dispose();
		detach?.();
		detach = undefined;
	}
	pi.registerEntryRenderer?.<RecapEntryData>(RECAP_ENTRY_TYPE, (entry, options, theme) => {
		activeTheme = theme;
		const summary = entry.data?.summary?.trim();
		if (!summary) return undefined;
		return new RecapEntryView(summary, () => activeTheme ?? theme, options.expanded, 1, () => detach?.requestRender?.());
	});
	pi.on("session_start", (_event, ctx) => {
		remove();
		if (!ctx.hasUI || ctx.mode !== "tui") return;
		activeTheme = ctx.ui.theme;
		ctx.ui.setWidget(WIDGET_KEY, (tui, widgetTheme) => {
			if (widgetTheme) activeTheme = widgetTheme;
			if (tui.mode === "fullscreen") {
				try {
					detach = installPiTweaks(tui, () => {
						try {
							return ctx.ui.theme ?? activeTheme!;
						} catch {
							return activeTheme!;
						}
					}, {
						onTerminalInput: (data) => recap.onTerminalInput(data),
					});
					recap.onSessionStart(ctx);
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

	pi.on("agent_settled", async (event, ctx) => {
		recap.onTurnSettled(ctx);
		if (event.aborted) {
			detach?.clearSuggestion?.();
			return;
		}
		if (!detach || !ctx.hasUI || ctx.mode !== "tui") return;
		if (ctx.ui.getEditorText().trim() !== "") return;
		if (ctx.hasPendingMessages() || !ctx.isIdle()) return;

		const model = ctx.model;
		if (!model || !ctx.modelRegistry) return;

		const entries = ctx.sessionManager.getEntries();
		const transcript = buildTranscript(entries);
		if (!transcript) return;

		const systemPrompt = "You predict the next line the USER will type into their coding agent.\n" +
			"You see a transcript. The last line is from the agent.\n" +
			"Write only that next user line, or NONE.\n\n" +
			"Predict what they would type, not what you think they should do.\n" +
			"A wrong line is worse than NONE.\n" +
			"Write NONE if the next line is long, new, or not obvious.\n" +
			"Never write filler, a question, or agent voice.\n\n" +
			"If you write a line, use 2-12 words in their style.\n" +
			"Reply with only the line or NONE.";

		const userPrompt = `CWD: ${ctx.cwd}\n\nTranscript:\n\n${transcript}\n\nPredict the user's next message. Reply with ONLY the suggestion text.`;

		try {
			const result = await ctx.modelRegistry.complete(
				model,
				{
					systemPrompt,
					messages: [
						{
							role: "user",
							content: [{ type: "text", text: userPrompt }],
							timestamp: Date.now(),
						},
					],
				},
				{ maxTokens: 48, temperature: 0.2 },
			);

			let raw = "";
			if (typeof result?.content === "string") {
				raw = result.content;
			} else if (Array.isArray(result?.content)) {
				raw = result.content
					.filter((part: unknown): part is { type: string; text: string } =>
						typeof part === "object" && part !== null &&
						(part as { type?: string }).type === "text" &&
						typeof (part as { text?: string }).text === "string")
					.map((part) => part.text)
					.join("");
			}

			const sanitized = sanitizeSuggestion(raw);
			if (sanitized && ctx.ui.getEditorText().trim() === "") {
				detach.setSuggestion?.(sanitized);
			}
		} catch {
			// Silently ignore completion errors (e.g. offline, auth, rate limit)
		}
	});

	pi.on("user_bash", () => {
		recap.onNewPrompt();
		detach?.clearSuggestion?.();
	});

	pi.on("before_agent_start", () => {
		recap.onNewPrompt();
		detach?.clearSuggestion?.();
	});

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

	// Register Dashboard & Location Picker commands and shortcuts (Ctrl+L, Ctrl+\, /dashboard, /cd)
	installDashboardCommands(pi);

	// Register Antigravity Google Web Search tool (scoped to Gemini models with priority over DuckDuckGo)
	installWebSearch(pi);
}
