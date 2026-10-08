import { compositeTuiLine, matchesKey, truncateToWidth, visibleWidth,
	type Component, type Theme } from "@earendil-works/pi-tui";
import type { LayoutBox, LayoutFrame } from "./question-navigation.ts";

export interface EditorLike {
	getText(): string;
	setText(text: string): void;
	getCursor?(): { line: number; col: number };
	getPaddingX?(): number;
	focused?: boolean;
}

export class PromptSuggestionState {
	private suggestion: string | null = null;
	private generation = 0;
	private dismissed = false;

	beginFetch(): number {
		this.generation = (this.generation + 1) | 0;
		return this.generation;
	}

	setSuggestion(text: string | null, generation?: number): boolean {
		if (generation !== undefined && generation !== this.generation) {
			return false;
		}
		if (!text || !text.trim()) {
			this.suggestion = null;
			return false;
		}
		this.suggestion = text.trim();
		this.dismissed = false;
		return true;
	}

	getSuggestion(): string | null {
		return this.suggestion;
	}

	getGhost(currentText: string): string | null {
		if (!this.suggestion || this.dismissed) return null;
		if (this.suggestion.startsWith(currentText)) {
			const rest = this.suggestion.slice(currentText.length);
			return rest.length > 0 ? rest : null;
		}
		return null;
	}

	accept(currentText: string): string | null {
		const ghost = this.getGhost(currentText);
		if (!ghost) return null;
		const result = this.suggestion;
		this.clear();
		return result;
	}

	dismiss(): void {
		this.dismissed = true;
	}

	clear(): void {
		this.suggestion = null;
		this.dismissed = false;
		this.generation = (this.generation + 1) | 0;
	}
}

export function sanitizeSuggestion(raw: string): string | null {
	if (!raw) return null;
	let line = raw.trim().split(/\r?\n/)[0]?.trim() ?? "";
	line = line.replace(/<\|eos\|>/gu, "").trim();
	line = line.replace(/^["'`“”‘’]+|["'`“”‘’]+$/gu, "").trim();
	if (!line) return null;
	const lowered = line.toLowerCase();
	const meta = ["none", "n/a", "no suggestion", "nothing", "(silence)", "silence", "null"];
	if (meta.some((m) => lowered === m || lowered.startsWith(`${m}.`))) {
		return null;
	}
	return line;
}

export function buildTranscript(entries: unknown[], maxLines = 8, charBudget = 12000): string | null {
	if (!Array.isArray(entries) || entries.length === 0) return null;
	const lines: string[] = [];
	let usedChars = 0;
	let sawAssistant = false;

	for (let i = entries.length - 1; i >= 0 && lines.length < maxLines; i--) {
		const entry = entries[i] as { type?: string; message?: { role?: string; content?: unknown } } | undefined;
		if (!entry || entry.type !== "message" || !entry.message) continue;
		const role = entry.message.role;
		if (role !== "user" && role !== "assistant") continue;

		let content = "";
		if (typeof entry.message.content === "string") {
			content = entry.message.content;
		} else if (Array.isArray(entry.message.content)) {
			content = entry.message.content
				.filter((part: unknown): part is { type: string; text: string } =>
					typeof part === "object" && part !== null &&
					(part as { type?: string }).type === "text" &&
					typeof (part as { text?: string }).text === "string")
				.map((part) => part.text)
				.join("\n");
		}
		content = content.trim();
		if (!content) continue;

		if (content.length > 1000) {
			content = `${content.slice(0, 1000)}…`;
		}

		const speaker = role === "user" ? "User" : "Agent";
		if (role === "assistant") sawAssistant = true;

		const line = `${speaker}: ${content}`;
		if (usedChars + line.length > charBudget && lines.length > 0) break;
		usedChars += line.length;
		lines.unshift(line);
	}

	if (!sawAssistant || lines.length === 0) return null;
	return lines.join("\n\n");
}

export function findEditorBox(box: LayoutBox): { box: LayoutBox; editor: EditorLike } | undefined {
	if (!box || !box.rect) return undefined;
	const comp = box.component as unknown as EditorLike;
	if (comp && typeof comp.getText === "function" && typeof comp.setText === "function") {
		return { box, editor: comp };
	}
	if (Array.isArray(box.children) && box.children.length > 0) {
		for (const child of box.children) {
			const found = findEditorBox(child);
			if (found) return found;
		}
	}
	if (Array.isArray((box.component as { children?: Component[] })?.children)) {
		let y = box.rect.y;
		for (const child of (box.component as { children: Component[] }).children) {
			const height = typeof child.render === "function" ? child.render(box.rect.width).length : box.rect.height;
			const childBox: LayoutBox = { component: child, rect: { x: box.rect.x, y, width: box.rect.width, height }, clip: box.clip, children: [] };
			const found = findEditorBox(childBox);
			if (found) return found;
			y += height;
		}
	}
	return undefined;
}

export function paintPromptSuggestion(
	screen: string[],
	layout: LayoutFrame,
	state: PromptSuggestionState,
	theme: Theme,
	width: number,
): string[] {
	if (!state.getSuggestion() || !layout?.root) return screen;
	const match = findEditorBox(layout.root);
	if (!match) return screen;
	const { box, editor } = match;
	const currentText = editor.getText();
	const ghost = state.getGhost(currentText);
	if (!ghost) return screen;

	const cursor = editor.getCursor ? editor.getCursor() : { line: 0, col: currentText.length };
	if (cursor.line !== 0 || cursor.col !== currentText.length) return screen;

	const row = box.rect.y + 1;
	if (row < 0 || row >= screen.length) return screen;

	const paddingX = editor.getPaddingX ? editor.getPaddingX() : 0;
	const textWidth = visibleWidth(currentText);
	const startCol = box.rect.x + paddingX + textWidth + 1;
	const available = Math.max(0, box.rect.x + box.rect.width - paddingX - startCol);
	if (available <= 0) return screen;

	const truncated = truncateToWidth(ghost, available, "");
	if (!truncated) return screen;

	const ghostWidth = visibleWidth(truncated);
	const styledGhost = `\x1b[2m${theme.fg("dim", truncated)}\x1b[22m`;

	const decorated = [...screen];
	decorated[row] = compositeTuiLine(decorated[row] ?? "", styledGhost, startCol, ghostWidth, width);
	return decorated;
}

export function handlePromptSuggestionInput(
	data: string,
	layout: LayoutFrame | undefined,
	state: PromptSuggestionState,
	requestRender: () => void,
): { consume: boolean } | undefined {
	if (!layout?.root) return undefined;
	const match = findEditorBox(layout.root);
	if (!match) return undefined;
	const { editor } = match;
	const currentText = editor.getText();
	const ghost = state.getGhost(currentText);
	if (!ghost) return undefined;

	const cursor = editor.getCursor ? editor.getCursor() : { line: 0, col: currentText.length };
	if (cursor.line !== 0 || cursor.col !== currentText.length) return undefined;

	if (matchesKey(data, "tab") || matchesKey(data, "right")) {
		const full = state.accept(currentText);
		if (full) {
			editor.setText(full);
			requestRender();
			return { consume: true };
		}
	} else if (matchesKey(data, "escape") && currentText === "") {
		state.dismiss();
		requestRender();
		return { consume: true };
	}

	return undefined;
}
