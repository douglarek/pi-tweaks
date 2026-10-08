export interface SessionLike {
	getSteeringMessages?(): readonly string[];
	getFollowUpMessages?(): readonly string[];
	clearQueue?(): { steering?: string[]; followUp?: string[] };
	abort?(): Promise<void> | void;
	waitForIdle?(): Promise<void> | void;
	followUp?(text: string): Promise<unknown> | unknown;
	prompt?(text: string): Promise<unknown> | unknown;
	isStreaming?: boolean;
	isIdle?: boolean;
}

export interface SubmittableEditor {
	getText(): string;
	setText(text: string): void;
	onSubmit?: (text: string) => Promise<void> | void;
}

export function resolveSession(root: unknown, customSession?: () => unknown): SessionLike | undefined {
	if (typeof customSession === "function") {
		const s = customSession() as SessionLike | undefined;
		if (s && typeof s.clearQueue === "function" && typeof s.abort === "function") {
			return s;
		}
	}
	const visited = new Set<unknown>();
	function scan(node: unknown): SessionLike | undefined {
		if (!node || typeof node !== "object" || visited.has(node)) return undefined;
		visited.add(node);
		const candidate = (node as { session?: SessionLike }).session;
		if (candidate && typeof candidate.clearQueue === "function" && typeof candidate.abort === "function") {
			return candidate;
		}
		if ((node as { layoutRoot?: unknown }).layoutRoot) {
			const found = scan((node as { layoutRoot?: unknown }).layoutRoot);
			if (found) return found;
		}
		if ((node as { currentLayout?: { root?: { component?: unknown } } }).currentLayout?.root?.component) {
			const found = scan((node as { currentLayout?: { root?: { component?: unknown } } }).currentLayout!.root!.component);
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

export function resolveEditor(root: unknown): SubmittableEditor | undefined {
	const visited = new Set<unknown>();
	function scan(node: unknown): SubmittableEditor | undefined {
		if (!node || typeof node !== "object" || visited.has(node)) return undefined;
		visited.add(node);
		const candidate = node as SubmittableEditor;
		if (typeof candidate.getText === "function" && typeof candidate.setText === "function" &&
			"onSubmit" in candidate) {
			return candidate;
		}
		if ((node as { layoutRoot?: unknown }).layoutRoot) {
			const found = scan((node as { layoutRoot?: unknown }).layoutRoot);
			if (found) return found;
		}
		if ((node as { currentLayout?: { root?: { component?: unknown } } }).currentLayout?.root?.component) {
			const found = scan((node as { currentLayout?: { root?: { component?: unknown } } }).currentLayout!.root!.component);
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

export function collectQueuedMessages(session: SessionLike): string[] {
	const steering = typeof session.getSteeringMessages === "function" ? [...session.getSteeringMessages()] : [];
	const followUp = typeof session.getFollowUpMessages === "function" ? [...session.getFollowUpMessages()] : [];
	return [...steering, ...followUp];
}

export async function dispatchEarliestQueuedMessage(
	session: SessionLike,
	submit?: (text: string) => Promise<void> | void,
): Promise<boolean> {
	const allQueued = collectQueuedMessages(session);
	if (allQueued.length === 0) return false;

	const first = allQueued[0];
	const remaining = allQueued.slice(1);

	session.clearQueue?.();

	if (session.isStreaming || session.isIdle === false) {
		await session.abort?.();
		if (typeof session.waitForIdle === "function") {
			await session.waitForIdle();
		}
	}

	for (const rem of remaining) {
		try {
			await session.followUp?.(rem);
		} catch {
			// Ignore follow-up errors
		}
	}

	if (typeof submit === "function") {
		await submit(first);
	} else if (typeof session.prompt === "function") {
		await session.prompt(first);
	}
	return true;
}

export interface QueueDispatchController {
	checkEditor(current?: unknown): void;
	dispose(): void;
	dispatchNow(): Promise<boolean>;
}

export interface QueueDispatchOptions {
	session?: () => SessionLike | undefined;
	enabled?: () => boolean;
	onRequestRender?: () => void;
}

export function installQueueDispatch(
	tui: unknown,
	options: QueueDispatchOptions = {},
): QueueDispatchController {
	let hookedEditor: SubmittableEditor | undefined;
	let originalSubmit: ((text: string) => Promise<void> | void) | undefined;
	let isDispatching = false;

	const enabled = () => options.enabled?.() ?? true;

	function hook(editor: SubmittableEditor) {
		if (hookedEditor === editor) return;
		unhook();
		hookedEditor = editor;
		originalSubmit = editor.onSubmit;

		const wrappedSubmit = async (text: string) => {
			const trimmed = text.trim();
			if (trimmed !== "" || !enabled()) {
				return originalSubmit?.(text);
			}

			if (isDispatching) return;

			const targetSession = resolveSession(tui, options.session);
			if (!targetSession) {
				return originalSubmit?.(text);
			}

			const queued = collectQueuedMessages(targetSession);
			if (queued.length === 0) {
				return originalSubmit?.(text);
			}

			isDispatching = true;
			try {
				await dispatchEarliestQueuedMessage(targetSession, originalSubmit);
				options.onRequestRender?.();
			} finally {
				isDispatching = false;
			}
		};

		editor.onSubmit = wrappedSubmit;
	}

	function unhook() {
		if (hookedEditor && originalSubmit) {
			hookedEditor.onSubmit = originalSubmit;
		}
		hookedEditor = undefined;
		originalSubmit = undefined;
	}

	const initialEditor = resolveEditor(tui);
	if (initialEditor) hook(initialEditor);

	return {
		checkEditor(current?: unknown) {
			const ed = (current as SubmittableEditor) ?? resolveEditor(tui);
			if (ed && ed !== hookedEditor) hook(ed);
		},
		dispose: unhook,
		dispatchNow: async () => {
			if (isDispatching) return false;
			const targetSession = resolveSession(tui, options.session);
			if (!targetSession) return false;
			isDispatching = true;
			try {
				const ok = await dispatchEarliestQueuedMessage(targetSession, hookedEditor?.onSubmit ?? originalSubmit);
				if (ok) options.onRequestRender?.();
				return ok;
			} finally {
				isDispatching = false;
			}
		},
	};
}
