/** Shared layout geometry and screen-only question navigation. No session/model mutations. */
import { UserMessageComponent, SkillInvocationMessageComponent, type Theme } from "@earendil-works/pi-coding-agent";
import { compositeTuiLine, Container, Spacer, stripTerminalSequences, truncateToWidth,
	visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";

export interface Rect { x: number; y: number; width: number; height: number }
export interface Pointer { x: number; y: number }
export type ScrollbarMode = "hidden" | "auto" | "always";
export interface ChatScrollView extends Component {
	child?: Component;
	readonly scrollTop: number;
	readonly isFollowingEnd: boolean;
	readonly scrollbar: ScrollbarMode;
	setScrollbar(mode: ScrollbarMode): void;
	getContentWidth(width: number): number;
	scrollTo(row: number, options?: { disableFollow?: boolean }): void;
}
export interface LayoutBox {
	component: Component;
	rect: Rect;
	clip: Rect;
	children: LayoutBox[];
}
export interface LayoutFrame {
	root: LayoutBox;
	width: number;
	height: number;
	primaryScrollView?: ChatScrollView;
}
export interface Question {
	component: Component;
	text: string;
	/** Logical document row, independent of the live scroll offset. */
	row: number;
}
export interface QuestionSnapshot {
	questions: Question[];
	scroll: ChatScrollView;
	box: LayoutBox;
}
export interface QuestionRail extends QuestionSnapshot {
	viewport: Rect;
	gutter: Rect;
	hitArea: Rect;
	column: number;
	start: number;
	size: number;
	top: number;
	active: number;
}
export interface RailHit { kind: "tick" | "up" | "down"; index?: number }

export const MIN_NAV_WIDTH = 40;
export const NAV_RIGHT_PADDING = 0;
export const NAV_HIT_WIDTH = 4;
export const NAV_CONTENT_GAP = 1;
export const NAV_GUTTER_WIDTH = NAV_CONTENT_GAP + NAV_HIT_WIDTH + NAV_RIGHT_PADDING;
export function contains(rect: Rect, point: Pointer): boolean {
	return point.x >= rect.x && point.x < rect.x + rect.width &&
		point.y >= rect.y && point.y < rect.y + rect.height;
}
export function transcriptContainer(layout: LayoutFrame): Component | undefined {
	// Native Pi 1.0.4 – 1.1.0 primary document: [header, loaded resources, chat].
	const document = layout.primaryScrollView?.child as Container | undefined;
	const children = document?.children;
	if (!Array.isArray(children) || children.length !== 3 ||
		!children.every((child) => child.constructor === Container)) return undefined;
	return children[2];
}
export function flowChildren(box: LayoutBox): LayoutBox[] {
	if (box.children.length > 0) return box.children;
	const flow = (box.component as unknown as {
		mouseLayout?: { width: number; children: { component: Component; height: number }[] };
	}).mouseLayout;
	if (flow?.width !== box.rect.width || !Array.isArray(flow.children)) return [];
	let y = box.rect.y;
	return flow.children.map((child) => {
		const result = { component: child.component,
			rect: { x: box.rect.x, y, width: box.rect.width, height: child.height },
			clip: box.clip, children: [] };
		y += child.height;
		return result;
	});
}
function findBox(box: LayoutBox, component: Component): LayoutBox | undefined {
	if (box.component === component) return box;
	for (const child of flowChildren(box)) {
		const result = findBox(child, component);
		if (result) return result;
	}
	return undefined;
}
export function chatEntryBox(layout: LayoutFrame, component: Component): LayoutBox | undefined {
	const chat = transcriptContainer(layout);
	const box = chat ? findBox(layout.root, chat) : undefined;
	return box ? flowChildren(box).find((entry) => entry.component === component) : undefined;
}
export function cleanQuestion(text: string): string {
	return stripTerminalSequences(text).replace(/\r\n?/g, "\n").replace(/\t/g, "    ")
		.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "").trim();
}
function userText(component: Component): string {
	const text = (component as unknown as { text?: unknown }).text;
	return typeof text === "string" ? text : "";
}
export function questionSnapshot(layout?: LayoutFrame): QuestionSnapshot | undefined {
	if (!layout?.root || !layout.primaryScrollView) return undefined;
	const chat = transcriptContainer(layout);
	if (!chat) return undefined;
	const box = findBox(layout.root, layout.primaryScrollView);
	const chatBox = findBox(layout.root, chat);
	if (!box || !chatBox) return undefined;
	// Derive the offset from this layout frame, not scrollTop (which can change before repaint).
	const offset = box.rect.y - (box.children[0]?.rect.y ?? box.rect.y);
	const entries = flowChildren(chatBox);
	const questions: Question[] = [];
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		let text: string | undefined;
		if (entry.component instanceof UserMessageComponent) text = userText(entry.component);
		else if (entry.component instanceof SkillInvocationMessageComponent) {
			const block = (entry.component as unknown as {
				skillBlock?: { name?: string; userMessage?: string };
			}).skillBlock;
			text = block?.userMessage || `/skill:${block?.name ?? "skill"}`;
			// Pi renders the skill header and the question separately, but it is one user turn.
			let next = i + 1;
			while (entries[next]?.component instanceof Spacer) next++;
			if (block?.userMessage && entries[next]?.component instanceof UserMessageComponent &&
				userText(entries[next].component).trim() === block.userMessage.trim()) i = next;
		}
		if (text !== undefined) questions.push({ component: entry.component,
			text: cleanQuestion(text) || "(empty question)", row: Math.max(0, entry.rect.y - box.rect.y + offset) });
	}
	return { questions, scroll: layout.primaryScrollView, box };
}
export function navEligible(snapshot: QuestionSnapshot, width: number): boolean {
	return snapshot.questions.length >= 2 && width >= MIN_NAV_WIDTH &&
		snapshot.box.clip.width >= MIN_NAV_WIDTH && snapshot.box.clip.height >= 4;
}
export function computeQuestionRail(snapshot: QuestionSnapshot, selected?: Component): QuestionRail {
	const { questions, scroll, box } = snapshot;
	const chosen = selected ? questions.findIndex((question) => question.component === selected) : -1;
	let active = 0;
	if (chosen >= 0 && !scroll.isFollowingEnd) active = chosen;
	else if (scroll.isFollowingEnd) active = questions.length - 1;
	else for (let i = 0; i < questions.length; i++) {
		if (questions[i].row <= scroll.scrollTop) active = i;
	}
	const capacity = Math.max(1, Math.floor(box.clip.height) - 2);
	const size = Math.min(questions.length, capacity);
	const start = Math.max(0, Math.min(questions.length - size, active - Math.floor(size / 2)));
	const right = box.rect.x + box.rect.width;
	const hitArea = { x: right - NAV_RIGHT_PADDING - NAV_HIT_WIDTH, y: box.clip.y,
		width: NAV_HIT_WIDTH, height: box.clip.height };
	return { ...snapshot, viewport: box.clip,
		gutter: { x: right - NAV_GUTTER_WIDTH, y: box.clip.y, width: NAV_GUTTER_WIDTH, height: box.clip.height },
		hitArea, column: hitArea.x + NAV_HIT_WIDTH - 1, active, start, size,
		top: box.clip.y + Math.floor((box.clip.height - size - 2) / 2) };
}
export function railContains(rail: QuestionRail, point: Pointer): boolean {
	return contains(rail.hitArea, point) && contains(rail.viewport, point);
}
export function railGutterContains(rail: QuestionRail, point: Pointer): boolean {
	return contains(rail.gutter, point) && contains(rail.viewport, point);
}
export function railHit(rail: QuestionRail, point?: Pointer): RailHit | undefined {
	if (!point || !railContains(rail, point)) return undefined;
	if (point.y === rail.top) return { kind: "up", index: rail.active > 0 ? rail.active - 1 : undefined };
	if (point.y === rail.top + rail.size + 1) return { kind: "down",
		index: rail.active + 1 < rail.questions.length ? rail.active + 1 : undefined };
	const relative = point.y - rail.top - 1;
	return relative >= 0 && relative < rail.size ? { kind: "tick", index: rail.start + relative } : undefined;
}
export function paintQuestionNavigation(screen: string[], rail: QuestionRail, theme: Theme,
	width: number, pointer?: Pointer, preview = true): string[] {
	const result = [...screen];
	const top = Math.max(0, rail.viewport.y);
	const bottom = Math.min(screen.length, rail.viewport.y + rail.viewport.height);
	const cell = (row: number, text: string) => {
		if (row >= top && row < bottom) result[row] = compositeTuiLine(result[row] ?? "", text, rail.column, 1, width);
	};
	// Clear the whole reserved gutter, including Pi's native edge scrollbar.
	// Content is rendered at a narrower width before any of these cells are painted.
	for (let row = top; row < bottom; row++) result[row] = compositeTuiLine(result[row] ?? "",
		" ".repeat(rail.gutter.width), rail.gutter.x, rail.gutter.width, width);
	const hit = railHit(rail, pointer);
	const up = rail.active > 0;
	const down = rail.active + 1 < rail.questions.length;
	cell(rail.top, theme.fg(up ? (hit?.kind === "up" ? "accent" : "muted") : "borderMuted", "▴"));
	cell(rail.top + rail.size + 1, theme.fg(down ? (hit?.kind === "down" ? "accent" : "muted") : "borderMuted", "▾"));
	for (let i = 0; i < rail.size; i++) {
		const index = rail.start + i;
		const hovered = hit?.kind === "tick" && hit.index === index;
		const row = rail.top + i + 1;
		if (hovered) {
			// Keep the right edge anchored; grow left into already-reserved space.
			result[row] = compositeTuiLine(result[row] ?? "", theme.fg("accent", "─".repeat(rail.hitArea.width)),
				rail.hitArea.x, rail.hitArea.width, width);
		} else cell(row, theme.fg(index === rail.active ? "accent" : "muted", index === rail.active ? "━" : "╴"));
	}
	if (!preview || hit?.kind !== "tick" || hit.index === undefined) return result;
	const innerWidth = Math.min(56, Math.max(12, Math.floor(rail.viewport.width / 2)), rail.viewport.width - 5);
	const maxLines = Math.min(5, rail.viewport.height - 3);
	if (innerWidth < 12 || maxLines < 1) return result;
	const wrapped = wrapTextWithAnsi(rail.questions[hit.index].text, innerWidth);
	const textLines = wrapped.slice(0, maxLines);
	if (wrapped.length > maxLines) textLines[maxLines - 1] = truncateToWidth(textLines[maxLines - 1], innerWidth - 1, "") + "…";
	const cardWidth = innerWidth + 4;
	const cardHeight = textLines.length + 3;
	const column = Math.max(rail.viewport.x, rail.hitArea.x - cardWidth - 1);
	const tickRow = rail.top + 1 + hit.index - rail.start;
	const row = Math.max(top, Math.min(bottom - cardHeight, tickRow - Math.floor(cardHeight / 2)));
	const label = truncateToWidth(` Question ${hit.index + 1}/${rail.questions.length} `, cardWidth - 2, "");
	const title = `╭${label}${"─".repeat(Math.max(0, cardWidth - 2 - visibleWidth(label)))}╮`;
	const lines = [theme.bg("selectedBg", theme.fg("borderMuted", title))];
	for (const text of textLines) {
		const content = ` ${text}${" ".repeat(Math.max(0, innerWidth - visibleWidth(text)))} `;
		lines.push(theme.bg("selectedBg", theme.fg("borderMuted", "│") + theme.fg("text", content) + theme.fg("borderMuted", "│")));
	}
	lines.push(theme.bg("selectedBg", theme.fg("dim", `│${" ".repeat(cardWidth - 2)}│`)));
	lines.push(theme.bg("selectedBg", theme.fg("borderMuted", `╰${"─".repeat(cardWidth - 2)}╯`)));
	for (let i = 0; i < lines.length; i++) result[row + i] = compositeTuiLine(result[row + i] ?? "", lines[i], column, cardWidth, width);
	return result;
}
