/**
 * Native Web Search Tool for Gemini and GPT models.
 *
 * Provides real-time Web Search Grounding via Antigravity / OpenAI backend (CPA / custom endpoint).
 * - Dynamically resolves baseUrl and apiKey purely through Pi's native modelRegistry interfaces.
 * - Scoped to Gemini and GPT series models.
 * - Prioritized above other search tools (such as DuckDuckGo).
 * - Compact tool rendering with automatic folding/collapsing of extra output.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

export const WEB_SEARCH_TOOL_NAME = "web_search";
export const PREVIEW_LINES = 5;

/** Check if the provided model is supported for native web_search (Gemini or GPT series) */
export function isSupportedSearchModel(model?: { id?: string; name?: string; provider?: string } | null): boolean {
	if (!model) return false;
	const id = (model.id || "").toLowerCase();
	const name = (model.name || "").toLowerCase();
	const provider = (model.provider || "").toLowerCase();
	return (
		id.includes("gemini") ||
		name.includes("gemini") ||
		id.includes("gpt") ||
		name.includes("gpt") ||
		provider.includes("gemini")
	);
}

/** Backward-compatibility alias */
export const isGeminiModel = isSupportedSearchModel;

export interface ModelEndpointConfig {
	baseUrl: string;
	apiKey: string;
	headers?: Record<string, string>;
}

/**
 * Dynamically resolves the active endpoint's baseUrl and apiKey via Pi's native interfaces.
 */
export async function resolveModelEndpoint(ctx?: {
	model?: { id?: string; name?: string; provider?: string; baseUrl?: string };
	modelRegistry?: any;
}): Promise<ModelEndpointConfig> {
	const currentModel = ctx?.model;
	const registry = ctx?.modelRegistry;

	if (!currentModel) {
		throw new Error("No active model found in Pi session context.");
	}
	if (!registry) {
		throw new Error("Pi modelRegistry is not available in session context.");
	}

	let baseUrl = currentModel.baseUrl || "";
	let apiKey = "";
	let headers: Record<string, string> | undefined;

	if (typeof registry.getApiKeyAndHeaders === "function") {
		const auth = await registry.getApiKeyAndHeaders(currentModel);
		if (auth && auth.ok) {
			if (auth.baseUrl) baseUrl = auth.baseUrl;
			if (auth.apiKey) apiKey = auth.apiKey;
			if (auth.headers) headers = auth.headers;
		} else if (auth && !auth.ok && auth.error) {
			throw new Error(`Pi failed to authenticate model '${currentModel.id}': ${auth.error}`);
		}
	}

	if (!baseUrl && typeof registry.getProvider === "function" && currentModel.provider) {
		const provider = registry.getProvider(currentModel.provider);
		if (provider?.baseUrl) {
			baseUrl = provider.baseUrl;
		}
	}

	if (!baseUrl && typeof registry.getRegisteredProviderConfig === "function" && currentModel.provider) {
		const config = registry.getRegisteredProviderConfig(currentModel.provider);
		if (config?.baseUrl) {
			baseUrl = config.baseUrl;
		}
	}

	if (!apiKey && typeof registry.getApiKeyForProvider === "function" && currentModel.provider) {
		apiKey = (await registry.getApiKeyForProvider(currentModel.provider)) || "";
	}

	if (!baseUrl) {
		throw new Error(
			`Pi could not resolve baseUrl for provider '${currentModel.provider}'. Please ensure 'baseUrl' is configured in models.json.`,
		);
	}
	if (!apiKey) {
		throw new Error(
			`Pi could not resolve apiKey for provider '${currentModel.provider}'. Please ensure valid authentication is configured in models.json or /login.`,
		);
	}

	return { baseUrl, apiKey, headers };
}

export interface WebSearchDetails {
	query: string;
	sourcesCount: number;
	sources?: { title: string; url: string }[];
	error?: string;
}

/** Execute the search request using credentials and model obtained from Pi */
export async function executeAntigravitySearch(
	query: string,
	ctx?: {
		model?: { id?: string; name?: string; provider?: string; baseUrl?: string };
		modelRegistry?: any;
	},
	signal?: AbortSignal,
): Promise<{ text: string; sources: { title: string; url: string }[] }> {
	const { baseUrl, apiKey, headers: extraHeaders } = await resolveModelEndpoint(ctx);

	const url = `${baseUrl.replace(/\/+$/, "")}/responses`;
	const targetModel = ctx?.model?.id && isSupportedSearchModel(ctx.model)
		? ctx.model.id
		: "gemini-3.8-flash-high";

	const requestHeaders: Record<string, string> = {
		"Authorization": `Bearer ${apiKey}`,
		"Content-Type": "application/json",
		...(extraHeaders || {}),
	};

	const response = await fetch(url, {
		method: "POST",
		headers: requestHeaders,
		body: JSON.stringify({
			model: targetModel,
			input: query,
			tools: [{ type: "web_search_preview" }],
		}),
		signal,
	});

	if (!response.ok) {
		const errorText = await response.text().catch(() => "");
		throw new Error(`Web search endpoint returned HTTP ${response.status}: ${errorText}`);
	}

	const data = (await response.json()) as {
		output?: Array<{
			type?: string;
			action?: { queries?: string[]; sources?: Array<{ title?: string; url?: string }> };
			content?: Array<{ text?: string; annotations?: Array<{ title?: string; url?: string }> }>;
		}>;
	};

	const searchCall = data.output?.find((o) => o.type === "web_search_call");
	const message = data.output?.find((o) => o.type === "message");
	const text = message?.content?.map((c) => c.text).filter(Boolean).join("\n") || "";

	const sources: { title: string; url: string }[] = [];
	const seenUrls = new Set<string>();

	if (searchCall?.action?.sources && Array.isArray(searchCall.action.sources)) {
		for (const s of searchCall.action.sources) {
			if (s?.url && !seenUrls.has(s.url)) {
				seenUrls.add(s.url);
				sources.push({ title: s.title || s.url, url: s.url });
			}
		}
	}

	if (message?.content && Array.isArray(message.content)) {
		for (const c of message.content) {
			if (c?.annotations && Array.isArray(c.annotations)) {
				for (const a of c.annotations) {
					if (a?.url && !seenUrls.has(a.url)) {
						seenUrls.add(a.url);
						sources.push({ title: a.title || a.url, url: a.url });
					}
				}
			}
		}
	}

	return { text, sources };
}

/** Synchronize web_search tool activation based on whether current model is supported (Gemini/GPT) */
export function syncWebSearchToolState(
	pi: ExtensionAPI,
	model?: { id?: string; name?: string; provider?: string } | null,
): boolean {
	if (typeof pi.getActiveTools !== "function" || typeof pi.setActiveTools !== "function") {
		return false;
	}
	const supported = isSupportedSearchModel(model);
	const activeTools = pi.getActiveTools() ?? [];
	const hasTool = activeTools.includes(WEB_SEARCH_TOOL_NAME);

	if (supported && !hasTool) {
		pi.setActiveTools([...activeTools, WEB_SEARCH_TOOL_NAME]);
		return true;
	} else if (!supported && hasTool) {
		pi.setActiveTools(activeTools.filter((t) => t !== WEB_SEARCH_TOOL_NAME));
		return false;
	}
	return supported;
}

export function installWebSearch(pi: ExtensionAPI): void {
	if (typeof pi.registerTool !== "function") {
		return;
	}

	pi.registerTool({
		name: WEB_SEARCH_TOOL_NAME,
		label: "Web Search",
		description:
			"Primary and authoritative Web Search engine powered by Google / OpenAI Search Grounding. Provides real-time search results, live web information, current events, documentation, and citations. HIGHEST PRIORITY: Whenever web search is needed on Gemini and GPT models, ALWAYS prefer this tool before DuckDuckGo or any other search tool.",
		promptSnippet: "Search the web using native search grounding (highest priority for Gemini and GPT models)",
		promptGuidelines: [
			"PRIORITY SEARCH RULE: When using Gemini or GPT models, ALWAYS prioritize using 'web_search' as your first-choice web search tool.",
			"Prefer 'web_search' over DuckDuckGo ('mcp__ddg_search__search') for real-time web searches, news, current facts, or live verification.",
			"Only fall back to DuckDuckGo if 'web_search' fails or is unavailable.",
		],
		parameters: {
			type: "object",
			required: ["query"],
			properties: {
				query: {
					type: "string",
					description: "Search query string. Be specific and descriptive.",
				},
			},
		},
		defaultActive: false,
		async execute(_toolCallId, params: { query: string }, signal, _onUpdate, ctx) {
			const currentModel = ctx?.model;
			if (!isSupportedSearchModel(currentModel)) {
				return {
					content: [
						{
							type: "text",
							text: `web_search is exclusively available for Gemini and GPT models. Current model is '${currentModel?.id || "unknown"}'. Please use alternative search tools like DuckDuckGo.`,
						},
					],
					details: { query: params.query, sourcesCount: 0, error: "model_not_supported" },
				};
			}

			try {
				const { text, sources } = await executeAntigravitySearch(params.query, ctx, signal);
				let resultText = text || "No text summary returned by Web Search.";
				if (sources.length > 0) {
					resultText += "\n\n### Web Sources:\n" + sources.map((s) => `- [${s.title}](${s.url})`).join("\n");
				}

				// Apply built-in truncation to protect LLM context window
				const truncation = truncateHead(resultText, {
					maxLines: DEFAULT_MAX_LINES,
					maxBytes: DEFAULT_MAX_BYTES,
				});
				let contentText = truncation.content;
				if (truncation.truncated) {
					const omitted = truncation.totalLines - truncation.outputLines;
					contentText += `\n\n[Search output truncated: ${omitted} lines omitted]`;
				}

				return {
					content: [{ type: "text", text: contentText }],
					details: { query: params.query, sourcesCount: sources.length, sources } as WebSearchDetails,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [
						{
							type: "text",
							text: `Web search error: ${message}\nPlease fall back to DuckDuckGo search.`,
						},
					],
					details: { query: params.query, sourcesCount: 0, error: message } as WebSearchDetails,
				};
			}
		},

		// Compact rendering for tool invocation
		renderCall(args, theme) {
			const query = args?.query || "";
			const text = theme.fg("toolTitle", theme.bold("web_search ")) + theme.fg("accent", `"${query}"`);
			return new Text(text, 0, 0);
		},

		// Collapsed rendering by default: folds excess lines into an expandable summary
		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) {
				return new Text(theme.fg("warning", "Searching web..."), 0, 0);
			}

			const details = result.details as WebSearchDetails | undefined;
			if (details?.error && details.error !== "model_not_supported") {
				return new Text(theme.fg("error", `✗ Search failed: ${details.error}`), 0, 0);
			}

			const content = result.content?.[0];
			const text = content && content.type === "text" ? content.text.trim() : "";
			if (!text) {
				return new Text(theme.fg("dim", "No search results returned"), 0, 0);
			}

			const lines = text.split("\n");
			const sourcesCount = details?.sourcesCount ?? 0;

			// Unexpanded (default): fold output to first 5 lines and display fold hint
			if (!expanded) {
				if (lines.length <= PREVIEW_LINES) {
					return new Text(lines.map((l) => theme.fg("toolOutput", l)).join("\n"), 0, 0);
				}

				const displayLines = lines.slice(0, PREVIEW_LINES);
				const remaining = lines.length - PREVIEW_LINES;
				let foldedText = displayLines.map((l) => theme.fg("toolOutput", l)).join("\n");
				foldedText += `\n${theme.fg("muted", `... (${remaining} more lines, ctrl+o to expand)`)}`;
				return new Text(foldedText, 0, 0);
			}

			// Expanded view: full output capped to prevent terminal overflow
			const MAX_EXPANDED = 100;
			const displayLines = lines.slice(0, MAX_EXPANDED);
			let expandedText = theme.fg("success", `Web Search Results (${sourcesCount} sources):`) + "\n";
			expandedText += displayLines.map((l) => theme.fg("toolOutput", l)).join("\n");
			if (lines.length > MAX_EXPANDED) {
				expandedText += `\n${theme.fg("muted", `... (${lines.length - MAX_EXPANDED} more lines omitted)`)}`;
			}
			return new Text(expandedText, 0, 0);
		},
	});

	// Hook lifecycle events to sync tool availability based on active model
	pi.on("session_start", (_event, ctx) => {
		syncWebSearchToolState(pi, ctx.model);
	});

	pi.on("model_select", (event, _ctx) => {
		syncWebSearchToolState(pi, event.model);
	});

	pi.on("before_agent_start", (_event, ctx) => {
		syncWebSearchToolState(pi, ctx.model);
	});
}
