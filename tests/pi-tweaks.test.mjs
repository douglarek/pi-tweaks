import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

function piPackage() {
	for (const path of (process.env.PATH ?? "").split(delimiter)) {
		const command = join(path, "pi");
		if (!existsSync(command)) continue;
		let directory = dirname(realpathSync(command));
		while (true) {
			const manifest = join(directory, "package.json");
			if (existsSync(manifest) && JSON.parse(readFileSync(manifest, "utf8")).name === "@earendil-works/pi-coding-agent") return directory;
			const parent = dirname(directory);
			if (parent === directory) break;
			directory = parent;
		}
	}
	throw new Error("A Pi Node installation must be available in PATH.");
}
const pkg = piPackage();
const extensionPath = fileURLToPath(new URL("../index.ts", import.meta.url));
const require = createRequire(`${pkg}/package.json`);
const { createJiti } = await import(pathToFileURL(require.resolve("jiti")).href);
const jiti = createJiti(import.meta.url, { moduleCache: false, fsCache: false, alias: {
	"@earendil-works/pi-coding-agent": `${pkg}/dist/index.js`,
	"@earendil-works/pi-tui": require.resolve("@earendil-works/pi-tui"),
} });
const { default: extension, installPiTweaks } = await jiti.import(extensionPath);
// Keep bracket-only fixtures isolated; production always loads both tweaks.
const installAiHoverFrame = (tui, getTheme, options = {}) =>
	installPiTweaks(tui, getTheme, { questionNav: () => false, ...options });
const { questionSnapshot, computeQuestionRail, railHit, railContains, railGutterContains,
	NAV_RIGHT_PADDING, NAV_HIT_WIDTH, NAV_GUTTER_WIDTH, cleanQuestion } =
	await jiti.import(fileURLToPath(new URL("../lib/question-navigation.ts", import.meta.url)));
const { AssistantMessageComponent, UserMessageComponent, SkillInvocationMessageComponent,
	ToolExecutionComponent, BashExecutionComponent, CustomMessageComponent, BranchSummaryMessageComponent,
	CompactionSummaryMessageComponent, initTheme } = await import(`${pkg}/dist/index.js`);
const { getThemeByName } = await import(`${pkg}/dist/modes/interactive/theme/theme.js`);
const { createInteractiveTuiReference } = await import(`${pkg}/dist/modes/interactive/tui-renderer.js`);
const { Container, ScrollView, Text, TuiAltScreen, VStack, sliceByColumn, stripTerminalSequences, visibleWidth } =
	await import(pathToFileURL(require.resolve("@earendil-works/pi-tui")).href);
initTheme("dark");
const theme = getThemeByName("dark");

class Terminal {
	columns = 60;
	rows = 22;
	kittyProtocolActive = false;
	writes = [];
	start(input, resize) { this.input = input; this.resize = resize; }
	stop() { this.input = undefined; }
	write(data) { this.writes.push(data); }
	async drainInput() {}
	moveBy() {}
	hideCursor() {}
	showCursor() {}
	clearLine() {}
	clearFromCursor() {}
	clearScreen() {}
	setTitle() {}
	setProgress() {}
}
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
function message(text, thinking) {
	return { role: "assistant", content: [...(thinking ? [{ type: "thinking", thinking }] : []), { type: "text", text }],
		api: "openai-completions", provider: "test", model: "test", usage, stopReason: "stop", timestamp: Date.now() };
}
function boxOf(box, component) {
	if (box.component === component) return box;
	for (const child of box.children) {
		const match = boxOf(child, component);
		if (match) return match;
	}
	if (box.children.length === 0 && Array.isArray(box.component.children)) {
		let y = box.rect.y;
		for (const child of box.component.children) {
			const height = child.render(box.rect.width).length;
			const match = boxOf({ component: child, rect: { x: box.rect.x, y, width: box.rect.width, height },
				clip: box.clip, children: [] }, component);
			if (match) return match;
			y += height;
		}
	}
}
function fixture({ text = "第一块 AI 消息。\n\nSecond line with **Markdown** and a [link](https://example.com).",
	thinking, padding = 1, rows = 22, columns = 60, two = false } = {}) {
	const terminal = new Terminal();
	terminal.rows = rows;
	terminal.columns = columns;
	const document = new Container();
	const user = new UserMessageComponent("USER MESSAGE");
	document.addChild(user);
	const assistant = new AssistantMessageComponent(message(text, thinking), !!thinking, undefined, "Thinking...", padding);
	document.addChild(assistant);
	let second;
	if (two) {
		document.addChild(new Text("TOOL OUTPUT", 1, 0));
		second = new AssistantMessageComponent(message("另一块 AI 回复"));
		document.addChild(second);
	}
	// Match InteractiveMode's primary document: header, loaded resources, then chat.
	const scrollHeader = new Container();
	scrollHeader.addChild(new Text("SCROLL HEADER", 1, 0));
	const resources = new Container();
	resources.addChild(new Text("LOADED RESOURCES", 1, 0));
	const fullDocument = new Container();
	fullDocument.addChild(scrollHeader);
	fullDocument.addChild(resources);
	fullDocument.addChild(document);
	const scroll = new ScrollView(fullDocument, { primary: true, follow: "end", scrollbar: "hidden" });
	const editor = new Text("EDITOR", 0, 0);
	const keys = [];
	editor.handleInput = (input) => keys.push(input);
	const root = new VStack([
		{ component: new Text("HEADER", 0, 0), basis: 1, shrink: 0 },
		{ component: scroll, basis: 0, grow: 1 },
		{ component: editor, basis: 1, shrink: 0 },
	]);
	const copies = [];
	const tui = new TuiAltScreen(terminal, false, undefined, { copyOnSelect: false,
		copySelection: async (text) => { copies.push(text); return true; } });
	tui.setLayoutRoot(root);
	tui.setFocus(editor);
	tui.start();
	tui.renderNow(true);
	const emit = (button, x, y, suffix = "M") => terminal.input(`\x1b[<${button};${x + 1};${y + 1}${suffix}`);
	const render = () => { tui.renderNow(); return tui.getScreenLines().map(stripTerminalSequences); };
	const box = (component = assistant) => boxOf(tui.currentLayout.root, component);
	const hover = (component = assistant) => {
		const region = box(component);
		const top = Math.max(region.rect.y, region.clip.y);
		const bottom = Math.min(region.rect.y + region.rect.height, region.clip.y + region.clip.height);
		emit(35, 5, top + Math.min(1, bottom - top - 1));
		return render();
	};
	return { terminal, tui, assistant, second, user, document, scrollHeader, resources,
		scroll, editor, root, keys, copies, emit, render, box, hover };
}
const hasBracket = (lines) => lines.some((line) => /^[┌│└]/u.test(line));
function lifecycle(f, preferenceDir) {
	const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = preferenceDir;
	const handlers = new Map();
	const commands = new Map();
	const widgets = new Map();
	const notifications = [];
	const ui = { theme, notify: (message, type) => notifications.push({ message, type }),
		setWidget: (key, factory) => {
			widgets.get(key)?.dispose?.();
			widgets.delete(key);
			if (factory) widgets.set(key, factory(f.tui, theme));
		} };
	const ctx = { hasUI: true, mode: "tui", ui };
	extension({ on: (name, handler) => handlers.set(name, handler), registerCommand: (name, command) => commands.set(name, command) });
	if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
	return { handlers, commands, widgets, notifications, ctx };
}

test("pi-tweaks regression suite", async (t) => {
	await t.test("hover paints only the AI margin; leaving hides it and message text/OSC marks are unchanged", () => {
		const f = fixture({ two: true });
		const baseline = f.render();
		const raw = f.assistant.render(f.box().rect.width);
		const unpatch = installAiHoverFrame(f.tui, () => theme);
		try {
			assert.equal(hasBracket(f.render()), false);
			const hovered = f.hover();
			const box = f.box();
			assert.equal(hovered[box.rect.y][0], "┌");
			assert.equal(hovered[box.rect.y + box.rect.height - 1][0], "└");
			for (let row = box.rect.y; row < box.rect.y + box.rect.height; row++) {
				assert.equal(hovered[row].slice(1).trimEnd(), (baseline[row] ?? "").slice(1).trimEnd());
			}
			assert.deepEqual(f.assistant.render(box.rect.width), raw);
			assert.match(raw[0], /^\x1b\]133;A/);
			const secondHover = f.hover(f.second);
			assert.equal(secondHover[box.rect.y], baseline[box.rect.y]);
			assert.equal(secondHover[f.box(f.second).rect.y][0], "┌");
			f.emit(35, 4, f.terminal.rows - 1);
			assert.equal(hasBracket(f.render()), false);
			assert.equal(hasBracket(f.hover(f.user)), true, "user messages need the same hover marker");
			assert.equal(hasBracket(f.hover(f.scrollHeader)), false, "scrollable header is not transcript information");
			assert.equal(hasBracket(f.hover(f.resources)), false, "resource listing is not transcript information");
		} finally { unpatch(); f.tui.stop(); }
	});

	await t.test("all transcript messages qualify, including user and skill entries", () => {
		const f = fixture({ rows: 60 });
		const unpatch = installAiHoverFrame(f.tui, () => theme);
		const tool = (isError, pending = false) => {
			const component = new ToolExecutionComponent("mcp__duckduckgo__search", `call-${isError}-${pending}`,
				{ query: "test" }, { showImages: false }, undefined, f.tui, process.cwd());
			if (!pending) component.updateResult({ content: [{ type: "text", text: "TOOL RESULT" }], isError });
			return component;
		};
		const bash = new BashExecutionComponent("printf test", f.tui);
		bash.appendOutput("BASH RESULT\n");
		bash.setComplete(0, false);
		const anonymous = new Container();
		anonymous.addChild(new Text("UNKNOWN EXTENSION ENTRY", 1, 0));
		const selfRendered = new ToolExecutionComponent("self-tool", "self-call", {}, { showImages: false }, {
			renderShell: "self", renderCall: () => new Text("SELF TOOL CALL", 1, 0),
			renderResult: () => new Text("SELF TOOL RESULT", 1, 0),
		}, f.tui, process.cwd());
		selfRendered.updateResult({ content: [{ type: "text", text: "result" }], isError: false });
		const entries = [tool(false, true), tool(false), tool(true), selfRendered, bash,
			new CustomMessageComponent({ role: "custom", customType: "test", content: "CUSTOM INFO", display: true, timestamp: 0 }),
			new CompactionSummaryMessageComponent({ role: "compactionSummary", tokensBefore: 1000, summary: "summary", timestamp: 0 }),
			new BranchSummaryMessageComponent({ role: "branchSummary", summary: "summary", fromId: "test", timestamp: 0 }),
			new Text("SYSTEM NOTICE", 1, 0), anonymous];
		try {
			for (const entry of entries) {
				f.document.addChild(entry);
				const baseline = f.render();
				const region = f.box(entry);
				const hovered = f.hover(entry);
				assert.equal(hasBracket(hovered), true, `${entry.constructor.name} needs a bracket`);
				for (let row = region.rect.y; row < region.rect.y + region.rect.height; row++) {
					assert.equal(hovered[row].slice(1).trimEnd(), baseline[row].slice(1).trimEnd(), "payload must stay intact");
				}
				f.document.removeChild(entry);
				f.render();
			}
			assert.equal(hasBracket(f.hover(f.user)), true);
			const skill = new SkillInvocationMessageComponent({ name: "user-skill", content: "USER SKILL CONTENT" });
			f.document.addChild(skill);
			f.render();
			assert.equal(hasBracket(f.hover(skill)), true, "skill invocation messages also need a marker");
			assert.equal(hasBracket(f.hover(f.scrollHeader)), false);
			assert.equal(hasBracket(f.hover(f.resources)), false);
		} finally { unpatch(); f.tui.stop(); }
	});

	await t.test("tool expansion, streaming, and output copying retain native behavior", async () => {
		const f = fixture({ rows: 60 });
		const tool = new ToolExecutionComponent("read", "copy-call", { path: "/tmp/test" }, { showImages: false }, {}, f.tui, process.cwd());
		tool.updateResult({ content: [{ type: "text", text: "TOOL_COPY_PAYLOAD\n" + Array.from({ length: 20 }, (_, i) => `TOOL_LINE_${i}`).join("\n") }], isError: false });
		f.document.addChild(tool);
		f.render();
		const unpatch = installAiHoverFrame(f.tui, () => theme);
		try {
			assert.equal(hasBracket(f.hover(tool)), true);
			const headerRow = f.box(tool).rect.y + 2;
			f.emit(0, 5, headerRow);
			f.emit(0, 5, headerRow, "m");
			assert.equal(tool.expanded, true);
			assert.ok(f.render().some((line) => line.includes("TOOL_LINE_19")));
			assert.equal(hasBracket(f.hover(tool)), true);
			const outputRow = f.render().findIndex((line) => line.includes("TOOL_COPY_PAYLOAD"));
			f.emit(0, 0, outputRow);
			f.emit(32, 20, outputRow);
			f.emit(0, 20, outputRow, "m");
			assert.equal(await f.tui.copyActiveSelectionToClipboard(), true);
			assert.match(f.copies.at(-1), /TOOL_COPY_PAYLOAD/);
			assert.doesNotMatch(f.copies.at(-1), /[┌│└]/u);
			f.emit(0, 4, f.terminal.rows - 1);
			f.emit(0, 4, f.terminal.rows - 1, "m");
			f.hover(tool);
			tool.updateResult({ content: [{ type: "text", text: "STREAMED TOOL RESULT" }], isError: false }, true);
			const streamed = f.render();
			assert.ok(streamed.some((line) => line.includes("STREAMED TOOL RESULT")));
			assert.equal(hasBracket(streamed), true);
		} finally { unpatch(); f.tui.stop(); }
	});

	await t.test("text selection and clipboard contents never contain decorative brackets", async () => {
		const f = fixture();
		const unpatch = installAiHoverFrame(f.tui, () => theme);
		try {
			assert.equal(hasBracket(f.hover()), true);
			const box = f.box();
			const row = box.rect.y + 1;
			f.emit(0, 0, row);
			f.emit(32, 16, row);
			f.emit(0, 16, row, "m");
			assert.equal(hasBracket(f.render()), false);
			assert.equal(f.tui.hasActiveSelection(), true);
			assert.equal(await f.tui.copyActiveSelectionToClipboard(), true);
			assert.equal(f.copies.length, 1);
			assert.match(f.copies[0], /第一块 AI 消息/);
			assert.doesNotMatch(f.copies[0], /[┌│└]/u);
		} finally { unpatch(); f.tui.stop(); }
	});

	await t.test("native thinking click-to-expand and keyboard input remain functional", () => {
		const f = fixture({ thinking: "Internal thought details." });
		const unpatch = installAiHoverFrame(f.tui, () => theme);
		try {
			const thoughtRow = f.render().findIndex((line) => line.includes("Thinking..."));
			assert.ok(thoughtRow >= 0);
			f.emit(0, 8, thoughtRow);
			f.emit(0, 8, thoughtRow, "m");
			assert.ok(f.render().some((line) => line.includes("Internal thought details.")));
			f.tui.setFocus(f.editor);
			f.terminal.input("hello");
			assert.deepEqual(f.keys, ["hello"]);
		} finally { unpatch(); f.tui.stop(); }
	});

	await t.test("clipped frames stay out of the header/editor and update for streaming and resize", () => {
		const long = Array.from({ length: 30 }, (_, i) => `Line ${i}: 测试内容`).join("\n");
		const f = fixture({ text: long, rows: 12, columns: 28 });
		const unpatch = installAiHoverFrame(f.tui, () => theme);
		try {
			const hovered = f.hover();
			assert.equal(hovered[0].trimEnd(), "HEADER");
			assert.equal(hovered.at(-1).trimEnd(), "EDITOR");
			assert.equal(hovered[1][0], "│", "a clipped top must not pretend to be the message's start");
			assert.equal(hovered.at(-2)[0], "└");
			f.assistant.updateContent(message(long + "\nNew streamed text"), true);
			assert.ok(f.render().some((line) => line.includes("New streamed")));
			assert.equal(f.render().at(-2)[0], "└");
			f.terminal.columns = 18;
			f.terminal.rows = 10;
			f.terminal.resize();
			const resized = f.render();
			assert.ok(resized.every((line) => visibleWidth(line) <= 18));
			assert.equal(resized[0].trimEnd(), "HEADER");
			assert.equal(resized.at(-1).trimEnd(), "EDITOR");
			f.emit(64, 4, 5);
			assert.equal(hasBracket(f.render()), false, "wheel scrolling must clear a stale hover");
		} finally { unpatch(); f.tui.stop(); }
	});

	await t.test("zero-padding, overlays, and terminal focus-out fail safely", () => {
		const noMargin = fixture({ padding: 0 });
		const removeNoMargin = installAiHoverFrame(noMargin.tui, () => theme);
		try {
			const baseline = noMargin.render();
			const hovered = noMargin.hover();
			const region = noMargin.box();
			for (let row = region.rect.y; row < region.rect.y + region.rect.height; row++) {
				if ((baseline[row] ?? "").trim().length > 0) assert.equal(hovered[row], baseline[row]);
			}
		} finally { removeNoMargin(); noMargin.tui.stop(); }
		const f = fixture();
		const unpatch = installAiHoverFrame(f.tui, () => theme);
		try {
			assert.equal(hasBracket(f.hover()), true);
			const overlay = f.tui.showOverlay(new Text("MODAL", 0, 0), { width: 12, row: 3, col: 0 });
			assert.equal(hasBracket(f.render()), false);
			overlay.hide();
			f.hover();
			f.terminal.input("\x1b[O");
			assert.equal(hasBracket(f.render()), false);
		} finally { unpatch(); f.tui.stop(); }
	});

	await t.test("theme changes are evaluated at paint time and instance methods restore exactly", () => {
		const f = fixture();
		const originalInput = f.tui.handleViewportInput;
		const originalPaint = f.tui.compositeScrollToEndIndicator;
		let colorTheme = theme;
		const unpatch = installAiHoverFrame(f.tui, () => colorTheme);
		try {
			f.hover();
			colorTheme = { fg: (_token, text) => `\x1b[38;2;1;2;3m${text}\x1b[39m` };
			f.render();
			assert.ok(f.tui.getScreenLines().some((line) => line.includes("\x1b[38;2;1;2;3m┌")));
			unpatch();
			unpatch();
			assert.equal(f.tui.handleViewportInput, originalInput);
			assert.equal(f.tui.compositeScrollToEndIndicator, originalPaint);
			assert.equal(Object.hasOwn(f.tui, "handleViewportInput"), false);
			assert.equal(Object.hasOwn(f.tui, "compositeScrollToEndIndicator"), false);
			assert.equal(hasBracket(f.render()), false);
		} finally { unpatch(); f.tui.stop(); }
	});

	await t.test("the CLI's stable TUI Proxy patches its real renderer, not the empty Proxy target", () => {
		const f = fixture();
		const originalInput = f.tui.handleViewportInput;
		const originalSymbols = Object.getOwnPropertySymbols(f.tui);
		const reference = createInteractiveTuiReference(() => f.tui);
		const unpatch = installAiHoverFrame(reference, () => theme);
		try {
			assert.notEqual(f.tui.handleViewportInput, originalInput);
			assert.equal(hasBracket(f.hover()), true);
			assert.deepEqual(Object.getOwnPropertySymbols(f.tui), originalSymbols);
			unpatch();
			assert.equal(f.tui.handleViewportInput, originalInput);
			assert.equal(hasBracket(f.render()), false);
		} finally { unpatch(); f.tui.stop(); }
	});

	await t.test("tmux motion mode is enabled only while installed and restored on detach", () => {
		const old = process.env.TMUX;
		process.env.TMUX = "test";
		const f = fixture();
		try {
			const unpatch = installAiHoverFrame(f.tui, () => theme);
			assert.ok(f.terminal.writes.includes("\x1b[?1003h"));
			unpatch();
			assert.ok(f.terminal.writes.includes("\x1b[?1003l"));
		} finally {
			f.tui.stop();
			if (old === undefined) delete process.env.TMUX; else process.env.TMUX = old;
		}
	});

	await t.test("loading enables tweaks; unload/reload and non-TUI modes clean up without config files", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-tweaks-lifecycle-"));
		const f = fixture();
		const originalInput = f.tui.handleViewportInput;
		const life = lifecycle(f, dir);
		try {
			life.handlers.get("session_start")({}, life.ctx);
			assert.equal(hasBracket(f.hover()), true);
			assert.deepEqual([...life.widgets.values()][0].render(60), []);
			assert.deepEqual([...life.commands.keys()], ["question-nav"]);
			life.handlers.get("session_shutdown")({ reason: "reload" }, life.ctx);
			assert.equal(f.tui.handleViewportInput, originalInput);
			assert.equal(hasBracket(f.hover()), false);
			life.widgets.values().next().value?.dispose();
			const reloaded = lifecycle(f, dir);
			reloaded.handlers.get("session_start")({}, reloaded.ctx);
			assert.equal(hasBracket(f.hover()), true);
			reloaded.handlers.get("session_shutdown")({}, reloaded.ctx);
			assert.equal(f.tui.handleViewportInput, originalInput);
			const nonTui = lifecycle(f, dir);
			nonTui.handlers.get("session_start")({}, { ...nonTui.ctx, hasUI: false, mode: "print" });
			assert.equal(nonTui.widgets.size, 0);
			assert.equal(f.tui.handleViewportInput, originalInput);
			assert.deepEqual(readdirSync(dir), []);
		} finally { life.handlers.get("session_shutdown")({}, life.ctx); f.tui.stop(); rmSync(dir, { recursive: true, force: true }); }
	});

	await t.test("question rail previews and clicks jump only the viewport, not message contents", () => {
		const f = fixture({ rows: 16, columns: 70 });
		const users = [f.user];
		for (let i = 1; i < 5; i++) {
			const user = new UserMessageComponent(`QUESTION_${i} 中文提问 🚀`);
			users.push(user);
			f.document.addChild(user);
			f.document.addChild(new AssistantMessageComponent(message(Array.from({ length: 12 }, (_, line) => `ANSWER_${i}_${line}`).join("\n"))));
		}
		f.render();
		const originals = users.map((user) => user.text);
		const unpatch = installAiHoverFrame(f.tui, () => theme, { questionNav: () => true });
		try {
			f.render(); f.render();
			assert.equal(f.scroll.scrollbar, "always");
			const snapshot = questionSnapshot(f.tui.currentLayout);
			assert.equal(snapshot.questions.length, 5);
			assert.deepEqual(snapshot.questions.map((entry) => entry.text), originals);
			const rail = computeQuestionRail(snapshot);
			const y = rail.top + 1;
			f.emit(35, rail.column, y);
			const preview = f.render();
			assert.ok(preview.some((line) => line.includes("Question 1/5")));
			assert.ok(preview.some((line) => line.includes("USER MESSAGE")));
			assert.ok(preview.every((line) => visibleWidth(line) <= f.terminal.columns));
			assert.doesNotMatch(f.tui.currentLayout.lines.join("\n"), /Question 1\/5/);
			f.emit(0, rail.column, y);
			f.emit(0, rail.column, y, "m");
			const jumped = f.render();
			assert.equal(f.scroll.scrollTop, questionSnapshot(f.tui.currentLayout).questions[0].row);
			assert.equal(f.scroll.isFollowingEnd, false);
			assert.equal(f.box(f.user).rect.y, f.tui.currentLayout.root.children[1].rect.y);
			assert.ok(jumped.some((line) => line.includes("USER MESSAGE")));
			assert.deepEqual(users.map((user) => user.text), originals);
			assert.equal(unpatch.questionCount(), 5);
			assert.equal(unpatch.jumpToQuestion(3), true);
			f.render();
			assert.ok(f.render().some((line) => line.includes("QUESTION_3")));
			assert.equal(unpatch.jumpToQuestion(99), false);
			unpatch();
			assert.equal(f.scroll.scrollbar, "hidden");
		} finally { unpatch(); f.tui.stop(); }
	});

	await t.test("short edge ticks grow left on hover without reflow and every expanded cell is clickable", () => {
		const f = fixture({ rows: 16, columns: 70 });
		for (let i = 0; i < 3; i++) {
			f.document.addChild(new UserMessageComponent(`HOVER_QUESTION_${i}`));
			f.document.addChild(new AssistantMessageComponent(message(Array.from({ length: 10 }, () => "answer text").join("\n"))));
		}
		f.render();
		const originalWidth = f.scroll.getContentWidth;
		const unpatch = installAiHoverFrame(f.tui, () => theme, { questionNav: () => true });
		try {
			f.render(); f.render();
			let snapshot = questionSnapshot(f.tui.currentLayout);
			let rail = computeQuestionRail(snapshot);
			assert.equal(snapshot.box.children[0].rect.width, f.terminal.columns - NAV_GUTTER_WIDTH);
			assert.equal(rail.hitArea.width, NAV_HIT_WIDTH);
			assert.equal(rail.hitArea.x + rail.hitArea.width, f.terminal.columns - NAV_RIGHT_PADDING);
			assert.equal(rail.column, f.terminal.columns - 1);
			const idle = f.render();
			assert.equal(stripTerminalSequences(sliceByColumn(idle[rail.top + 1], rail.hitArea.x, NAV_HIT_WIDTH, true)), " ".repeat(NAV_HIT_WIDTH - 1) + "╴");
			for (let column = rail.hitArea.x; column < rail.hitArea.x + rail.hitArea.width; column++) {
				f.emit(35, column, rail.top + 1);
				const preview = f.render();
				assert.ok(preview.some((line) => line.includes("Question 1/4")));
				assert.equal(stripTerminalSequences(sliceByColumn(preview[rail.top + 1], rail.hitArea.x, NAV_HIT_WIDTH, true)), "─".repeat(NAV_HIT_WIDTH));
				assert.equal(questionSnapshot(f.tui.currentLayout).box.children[0].rect.width, snapshot.box.children[0].rect.width, "hover must not reflow the transcript");
				f.emit(0, column, rail.top + 1);
				f.emit(0, column, rail.top + 1, "m");
				f.render();
				snapshot = questionSnapshot(f.tui.currentLayout);
				assert.equal(f.scroll.scrollTop, snapshot.questions[0].row, "each hit-area cell must activate the same question");
				rail = computeQuestionRail(snapshot, f.user);
			}
			const edge = { x: rail.gutter.x, y: rail.top + 1 };
			assert.equal(railContains(rail, edge), false);
			assert.equal(railGutterContains(rail, edge), true);
			const before = f.scroll.scrollTop;
			f.emit(0, edge.x, edge.y); f.emit(0, edge.x, edge.y, "m"); f.render();
			assert.equal(f.scroll.scrollTop, before, "the blank gap beside the expanded tick must not start a scrollbar drag");
			assert.equal(f.tui.scrollbarDrag, undefined);
			assert.equal(f.tui.selectionPressActive, false);
			unpatch();
			assert.equal(f.scroll.getContentWidth, originalWidth);
			assert.equal(Object.hasOwn(f.scroll, "getContentWidth"), false);
			assert.equal(f.scroll.getContentWidth(f.terminal.columns), f.terminal.columns);
		} finally { unpatch(); f.tui.stop(); }
	});

	await t.test("navigation destinations stay marked after mouse leave and clear on manual scroll", () => {
		const f = fixture({ rows: 16, columns: 70 });
		const second = new UserMessageComponent("TARGET SECOND QUESTION");
		f.document.addChild(new AssistantMessageComponent(message(Array.from({ length: 18 }, () => "long answer").join("\n"))));
		f.document.addChild(second);
		f.document.addChild(new AssistantMessageComponent(message(Array.from({ length: 18 }, () => "second answer").join("\n"))));
		f.render();
		const unpatch = installAiHoverFrame(f.tui, () => theme, { questionNav: () => true });
		try {
			f.render(); f.render();
			assert.equal(unpatch.jumpToQuestion(0), true);
			f.render();
			f.emit(35, 5, f.terminal.rows - 1);
			f.render();
			const targetRow = f.box(f.user).rect.y;
			assert.ok(f.tui.getScreenLines()[targetRow].includes(theme.getFgAnsi("accent") + "┌"));
			assert.equal(unpatch.jumpToQuestion(1), true);
			f.render();
			assert.ok(f.tui.getScreenLines()[f.box(second).rect.y].includes(theme.getFgAnsi("accent") + "┌"));
			f.emit(64, 4, 5);
			assert.equal(hasBracket(f.render()), false, "manual viewport scrolling clears the pinned destination");
		} finally { unpatch(); f.tui.stop(); }
	});

	await t.test("content sizing restores original hidden, auto and always scrollbar modes", () => {
		for (const mode of ["hidden", "auto", "always"]) {
			const f = fixture({ rows: 16, columns: 70 });
			f.document.addChild(new UserMessageComponent("SECOND QUESTION"));
			f.document.addChild(new AssistantMessageComponent(message("second answer")));
			f.scroll.setScrollbar(mode); f.render();
			const originalWidth = f.scroll.getContentWidth;
			const nativeWidth = f.scroll.getContentWidth(70);
			const unpatch = installAiHoverFrame(f.tui, () => theme, { questionNav: () => true });
			try {
				f.render(); f.render();
				assert.equal(f.scroll.getContentWidth(70), 70 - NAV_GUTTER_WIDTH);
				unpatch(); f.render();
				assert.equal(f.scroll.scrollbar, mode);
				assert.equal(f.scroll.getContentWidth, originalWidth);
				assert.equal(f.scroll.getContentWidth(70), nativeWidth);
			} finally { unpatch(); f.tui.stop(); }
		}
	});

	await t.test("rail chevrons/wheel work; cancelled rail drags and normal text selection stay native", async () => {
		const f = fixture({ rows: 16, columns: 70 });
		for (let i = 0; i < 5; i++) {
			f.document.addChild(new UserMessageComponent(`NEXT_QUESTION_${i}`));
			f.document.addChild(new AssistantMessageComponent(message(Array.from({ length: 10 }, () => "answer line").join("\n"))));
		}
		f.render();
		const unpatch = installAiHoverFrame(f.tui, () => theme, { questionNav: () => true });
		try {
			f.render(); f.render();
			unpatch.jumpToQuestion(0); f.render();
			let rail = computeQuestionRail(questionSnapshot(f.tui.currentLayout), f.user);
			const start = f.scroll.scrollTop;
			f.emit(0, rail.column, rail.top);
			f.emit(0, rail.column, rail.top, "m");
			f.render();
			assert.equal(f.scroll.scrollTop, start, "disabled up arrow must not invoke native scrollbar dragging");
			f.emit(0, rail.column, rail.top + 2);
			f.emit(32, rail.column - 2, rail.top + 3);
			f.emit(0, rail.column - 2, rail.top + 3, "m");
			f.render();
			assert.equal(f.scroll.scrollTop, start, "drag away cancels a question click");
			assert.equal(f.tui.selectionPressActive, false);
			f.emit(65, rail.column, rail.top + 1);
			f.render();
			assert.equal(f.scroll.scrollTop, questionSnapshot(f.tui.currentLayout).questions[1].row);
			unpatch.jumpToQuestion(0); f.render();
			rail = computeQuestionRail(questionSnapshot(f.tui.currentLayout), f.user);
			const userRow = f.box(f.user).rect.y + 1;
			f.emit(0, 0, userRow);
			f.emit(32, rail.column, userRow);
			f.emit(0, rail.column, userRow, "m");
			f.render();
			assert.equal(await f.tui.copyActiveSelectionToClipboard(), true);
			assert.match(f.copies.at(-1), /USER MESSAGE/);
			assert.doesNotMatch(f.copies.at(-1), /[▴▾━╴]|Question/);
		} finally { unpatch(); f.tui.stop(); }
	});

	await t.test("long histories window ticks without collisions; resize and single-question views restore gutters", () => {
		const f = fixture({ rows: 12, columns: 60 });
		const users = [f.user];
		for (let i = 1; i <= 35; i++) {
			const user = new UserMessageComponent(`DUPLICATE QUESTION ${i % 2}`);
			users.push(user);
			f.document.addChild(user);
			f.document.addChild(new AssistantMessageComponent(message("answer")));
		}
		f.render();
		const unpatch = installAiHoverFrame(f.tui, () => theme, { questionNav: () => true });
		try {
			f.render(); f.render();
			let rail = computeQuestionRail(questionSnapshot(f.tui.currentLayout));
			assert.equal(rail.questions.length, 36, "repeated text must not merge user turns");
			assert.ok(rail.size <= rail.viewport.height - 2);
			assert.ok(rail.start > 0 && rail.active >= rail.start && rail.active < rail.start + rail.size);
			for (let i = 0; i < rail.size; i++) assert.equal(railHit(rail, { x: rail.column, y: rail.top + 1 + i }).index, rail.start + i);
			unpatch.jumpToQuestion(0); f.render();
			rail = computeQuestionRail(questionSnapshot(f.tui.currentLayout), f.user);
			assert.equal(rail.start, 0);
			f.terminal.columns = 25; f.terminal.resize(); f.render(); f.render();
			assert.equal(f.scroll.scrollbar, "hidden");
			assert.ok(f.render().every((line) => visibleWidth(line) <= 25));
			f.terminal.columns = 60; f.terminal.resize(); f.render(); f.render();
			assert.equal(f.scroll.scrollbar, "always");
			f.document.clear(); f.document.addChild(f.user); f.document.addChild(f.assistant);
			f.render(); f.render();
			assert.equal(f.scroll.scrollbar, "hidden");
			assert.equal(unpatch.questionCount(), 1);
		} finally { unpatch(); f.tui.stop(); }
	});

	await t.test("question previews are terminal-safe and skill headers are indexed as one user turn", () => {
		const f = fixture({ rows: 25, columns: 70 });
		const text = "中文 🚀 \\x1b not real ANSI";
		const skill = new SkillInvocationMessageComponent({ name: "test", content: "private skill body", userMessage: text });
		f.document.addChild(skill); f.document.addChild(new UserMessageComponent(text));
		f.render();
		assert.equal(questionSnapshot(f.tui.currentLayout).questions.length, 2);
		assert.equal(cleanQuestion("question\x1b[31m RED\x1b[0m\x1b]52;c;bad\x07\x00"), "question RED");
		const unpatch = installAiHoverFrame(f.tui, () => theme, { questionNav: () => true });
		try {
			f.render(); f.render();
			const rail = computeQuestionRail(questionSnapshot(f.tui.currentLayout));
			f.emit(35, rail.column, rail.top + 2);
			const preview = f.render();
			assert.ok(preview.some((line) => line.includes("Question 2/2")));
			assert.ok(preview.some((line) => line.includes("中文 🚀")));
			assert.ok(preview.every((line) => visibleWidth(line) <= 70));
			const overlay = f.tui.showOverlay(new Text("MODAL", 0, 0), { width: 20 });
			f.render();
			const before = f.scroll.scrollTop;
			f.emit(0, rail.column, rail.top + 1); f.emit(0, rail.column, rail.top + 1, "m");
			assert.equal(f.scroll.scrollTop, before);
			assert.equal(unpatch.jumpToQuestion(0), false);
			overlay.hide();
		} finally { unpatch(); f.tui.stop(); }
	});

	await t.test("no feature switches: legacy configs are ignored and numbered commands only scroll", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-tweaks-no-config-"));
		writeFileSync(join(dir, "ai-hover-frame.json"), '{"enabled":false,"questionNav":false}');
		writeFileSync(join(dir, "pi-tweaks.json"), "{broken");
		const f = fixture({ rows: 15, columns: 70 });
		f.document.addChild(new UserMessageComponent("SECOND PROMPT"));
		f.document.addChild(new AssistantMessageComponent(message(Array.from({ length: 20 }, () => "second answer").join("\n"))));
		f.render();
		const originalInput = f.tui.handleViewportInput;
		const life = lifecycle(f, dir);
		try {
			life.handlers.get("session_start")({}, life.ctx);
			f.render(); f.render();
			assert.equal(f.scroll.scrollbar, "always");
			assert.equal(life.notifications.length, 0, "obsolete switch files must not affect loading");
			await life.commands.get("question-nav").handler("1", life.ctx);
			f.render();
			assert.ok(f.render().some((line) => line.includes("USER MESSAGE")));
			await life.commands.get("question-nav").handler("off", life.ctx);
			assert.equal(f.scroll.scrollbar, "always", "off is not a configuration action");
			assert.ok(life.notifications.some((notice) => notice.message.includes("Usage:")));
			assert.deepEqual(readdirSync(dir).sort(), ["ai-hover-frame.json", "pi-tweaks.json"]);
			assert.equal(readFileSync(join(dir, "pi-tweaks.json"), "utf8"), "{broken");
			life.handlers.get("session_shutdown")({}, life.ctx);
			assert.equal(f.tui.handleViewportInput, originalInput);
			assert.equal(f.scroll.scrollbar, "hidden");
		} finally { life.handlers.get("session_shutdown")({}, life.ctx); f.tui.stop(); rmSync(dir, { recursive: true, force: true }); }
	});

	await t.test("incompatible or regular TUIs are rejected without patching", () => {
		for (const mode of ["regular", "fullscreen"]) {
			const ui = { mode };
			assert.throws(() => installAiHoverFrame(ui, () => theme), /compatible fullscreen/);
			assert.deepEqual(Object.keys(ui), ["mode"]);
		}
	});
});
