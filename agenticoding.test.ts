import test from "node:test";
import assert from "node:assert/strict";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { registerHandoffCommand } from "./handoff/command.js";
import { registerHandoffTool } from "./handoff/tool.js";
import { registerHandoffCompaction } from "./handoff/compact.js";
import { registerWatchdog } from "./watchdog.js";
import { createState, resetState } from "./state.js";
import {
	buildChildToolNames,
	createChildTools,
	executeSpawn,
	registerSpawnTool,
} from "./spawn/index.js";
import { renderSpawnResult } from "./spawn/renderer.js";
import { registerLedgerRehydration } from "./ledger/rehydration.js";
import { createLedgerToolDefinitions } from "./ledger/tools.js";
import registerAgenticoding from "./index.js";

type Handler = (args: any, ctx: any) => any;

const theme = {
	fg: (_name: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

function createRenderContext(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		expanded: false,
		showImages: true,
		toolCallId: "tool-call-1",
		lastComponent: undefined,
		invalidate: () => {},
		...overrides,
	};
}

function createSession(messages: any[]) {
	return {
		messages,
		subscribe: () => () => {},
		getToolDefinition: () => undefined,
		sessionManager: { getCwd: () => process.cwd() },
		abort: async () => {},
	} as unknown as import("@earendil-works/pi-coding-agent").AgentSession;
}

function stripAnsi(text: string): string {
	return text.replace(/\u001b\[[0-9;]*m/g, "").replace(/\u001b\][^\u0007]*\u0007/g, "");
}

class MockPi {
	commands = new Map<string, { description?: string; handler: Handler }>();
	tools = new Map<string, any>();
	handlers = new Map<string, Handler[]>();
	activeTools: string[] = [];
	toolSources = new Map<string, string>();
	sentUserMessages: Array<{ content: string; options: any }> = [];
	appendedEntries: Array<{ customType: string; data: any }> = [];

	registerCommand(name: string, definition: { description?: string; handler: Handler }) {
		this.commands.set(name, definition);
	}

	registerTool(definition: any) {
		this.tools.set(definition.name, definition);
	}

	on(event: string, handler: Handler) {
		const handlers = this.handlers.get(event) ?? [];
		handlers.push(handler);
		this.handlers.set(event, handlers);
	}

	getActiveTools() {
		return [...this.activeTools];
	}

	setActiveTools(tools: string[]) {
		this.activeTools = [...tools];
		for (const tool of tools) {
			if (!this.toolSources.has(tool)) {
				this.toolSources.set(tool, "builtin");
			}
		}
	}

	setToolSource(name: string, source: string) {
		this.toolSources.set(name, source);
	}

	getAllTools() {
		return this.activeTools.map((name) => ({
			name,
			description: "",
			parameters: {},
			sourceInfo: {
				path: `<${this.toolSources.get(name) ?? "builtin"}:${name}>`,
				source: this.toolSources.get(name) ?? "builtin",
				scope: "temporary",
				origin: "top-level",
			},
		}));
	}

	getThinkingLevel() {
		return "medium";
	}

	sendUserMessage(content: string, options?: any) {
		this.sentUserMessages.push({ content, options });
	}

	appendEntry(customType: string, data: any) {
		this.appendedEntries.push({ customType, data });
	}
}

test("/handoff sends the direction back through the LLM without opening the editor", async () => {
	const pi = new MockPi();
	const state = createState();
	registerHandoffCommand(pi as any, state);

	await pi.commands.get("handoff")!.handler("implement auth", {
		hasUI: true,
		isIdle: () => true,
		ui: { notify: (_message: string) => {} },
	});

	assert.deepEqual(state.pendingRequestedHandoff, {
		direction: "implement auth",
		enforcementAttempts: 0,
		toolCalled: false,
	});
	assert.deepEqual(pi.sentUserMessages, [
		{
			content:
				"Handoff direction: implement auth\n\nPrepare a real handoff in the current session and current context. Before calling the handoff tool, capture any reusable state in the ledger if needed. Then complete the picture in a concise but sufficiently detailed handoff brief and call the handoff tool in this turn. Preserve the important knowledge that is still only present in the current context so the next clean context can start well without re-deriving it. Use any structure that makes the next work unambiguous. Include findings, current state, unresolved questions, failed paths worth avoiding, next steps, refs, constraints, and spawn ideas when useful. Reference ledger entries by name when relevant.",
			options: undefined,
		},
	]);
});

test("/handoff requires a direction", async () => {
	const pi = new MockPi();
	const state = createState();
	registerHandoffCommand(pi as any, state);

	const notifications: string[] = [];
	await pi.commands.get("handoff")!.handler("   ", {
		hasUI: true,
		isIdle: () => true,
		ui: { notify: (message: string) => notifications.push(message) },
	});

	assert.deepEqual(notifications, ["Usage: /handoff <direction>"]);
	assert.deepEqual(pi.sentUserMessages, []);
});

test("handoff tool triggers compaction and resumes with the compacted task", async () => {
	const pi = new MockPi();
	const state = createState();
	state.pendingRequestedHandoff = { direction: "implement auth", enforcementAttempts: 0, toolCalled: false };
	registerHandoffTool(pi as any, state);

	let compactOptions: any;
	const result = await pi.tools.get("handoff").execute(
		"1",
		{ task: "Goal: continue" },
		undefined,
		undefined,
		{
			compact: (options: any) => {
				compactOptions = options;
			},
		},
	);

	assert.equal(state.pendingHandoff?.source, "tool");
	assert.match(state.pendingHandoff?.task ?? "", /## Handoff — Continue Previous Work/);
	assert.match(state.pendingHandoff?.task ?? "", /Goal: continue/);
	assert.equal(state.pendingRequestedHandoff?.toolCalled, true);
	assert.equal(typeof compactOptions?.onComplete, "function");
	assert.equal(result.content[0].text, "Handoff started.");
	assert.equal(result.terminate, true);

	compactOptions.onComplete({});
	assert.deepEqual(pi.sentUserMessages, [{ content: "Proceed.", options: undefined }]);
});

test("handoff compaction replaces old context with the queued task", async () => {
	const pi = new MockPi();
	const state = createState();
	state.pendingHandoff = { task: "Goal: continue", source: "tool" };
	state.pendingRequestedHandoff = { direction: "implement auth", enforcementAttempts: 1, toolCalled: true };
	registerHandoffCompaction(pi as any, state);

	const [handler] = pi.handlers.get("session_before_compact")!;
	const result = await handler(
		{
			preparation: { tokensBefore: 123 },
			branchEntries: [{ id: "leaf-1" }],
		},
		{},
	);

	assert.equal(state.pendingHandoff, null);
	assert.equal(state.pendingRequestedHandoff, null);
	assert.equal(result.compaction.summary, "Goal: continue");
	assert.equal(result.compaction.tokensBefore, 123);
	assert.equal(result.compaction.firstKeptEntryId, "leaf-1-handoff-cut");
	assert.deepEqual(result.compaction.details, { handoff: true, task: "Goal: continue" });
});

test("watchdog records context usage without user notifications", async () => {
	const pi = new MockPi();
	const state = createState();
	registerWatchdog(pi as any, state);
	const [handler] = pi.handlers.get("agent_end")!;

	const notifications: string[] = [];
	await handler(
		{},
		{
			hasUI: true,
			ui: { notify: (message: string) => notifications.push(message) },
			getContextUsage: () => ({ percent: 70 }),
		},
	);

	assert.equal(state.lastContextPercent, 70);
	assert.deepEqual(notifications, []);
});

test("context injects watchdog reminder before each LLM call", async () => {
	const pi = new MockPi();
	registerAgenticoding(pi as any);
	const [handler] = pi.handlers.get("context")!;

	const result = await handler(
		{ messages: [{ role: "user", content: "hi", timestamp: 1 }] },
		{
			getContextUsage: () => ({ percent: 70 }),
		},
	);

	assert.equal(result.messages.length, 2);
	assert.deepEqual(result.messages[0], { role: "user", content: "hi", timestamp: 1 });
	assert.equal(result.messages[1].role, "custom");
	assert.equal(result.messages[1].customType, "agenticoding-watchdog");
	assert.equal(result.messages[1].display, false);
	assert.match(result.messages[1].content, /Context at 70%/);
});

test("watchdog stays advisory when a requested handoff is not completed", async () => {
	const pi = new MockPi();
	const state = createState();
	state.pendingRequestedHandoff = { direction: "implement auth", enforcementAttempts: 0, toolCalled: false };
	registerWatchdog(pi as any, state);
	const [handler] = pi.handlers.get("agent_end")!;

	const notifications: string[] = [];
	await handler(
		{},
		{
			hasUI: true,
			ui: { notify: (message: string) => notifications.push(message) },
			getContextUsage: () => ({ percent: 20 }),
		},
	);

	assert.equal(state.pendingRequestedHandoff, null);
	assert.deepEqual(notifications, []);
	assert.deepEqual(pi.sentUserMessages, []);
});

test("collapsed nested spawn render shows preview and stats", () => {
	const state = createState();
	const childSpawnTool = createChildTools(new MockPi() as any, state, "medium", 0).find(t => t.name === "spawn")!;
	const session = createSession([
		{ role: "assistant", content: [{ type: "text", text: "one\ntwo\nthree\nfour\nfive\nsix\nseven" }] },
	]);
	state.childSessions.set("tool-call-1", session);

	const component = childSpawnTool.renderResult(
		{
			content: [{ type: "text", text: "ignored" }],
			details: {
				depth: 1,
				model: "mock-model",
				thinking: "medium",
				truncated: true,
				stats: { inputTokens: 12, outputTokens: 34, turns: 2, cost: 0.125 },
			},
		},
		{ expanded: false },
		theme,
		createRenderContext(),
	) as any;

	const lines = component.render(120);
	assert.ok(lines.some((l: string) => l.includes("mock-model • medium")));
	assert.ok(lines.some((l: string) => l.includes("one")));
	assert.ok(lines.some((l: string) => l.includes("five")));
	assert.ok(lines.some((l: string) => l.includes("... 2 more lines")));
	assert.ok(lines.some((l: string) => l.includes("tokens: 12/34")));
	assert.ok(lines.some((l: string) => l.includes("[truncated]")));
});

test("collapsed nested spawn render keeps all text blocks from the last assistant message", () => {
	const state = createState();
	const childSpawnTool = createChildTools(new MockPi() as any, state, "medium", 0).find(t => t.name === "spawn")!;
	const session = createSession([
		{ role: "assistant", content: [{ type: "text", text: "first" }, { type: "text", text: "second" }] },
	]);
	state.childSessions.set("tool-call-1", session);

	const component = childSpawnTool.renderResult(
		{
			content: [{ type: "text", text: "ignored" }],
			details: { depth: 1, model: "mock-model", thinking: "medium", truncated: false },
		},
		{ expanded: false },
		theme,
		createRenderContext(),
	) as any;

	const lines = component.render(120);
	assert.ok(lines.some((l: string) => l.includes("first")));
	assert.ok(lines.some((l: string) => l.includes("second")));
});

test("nested spawn render is safe without details", () => {
	const state = createState();
	const childSpawnTool = createChildTools(new MockPi() as any, state, "medium", 0).find(t => t.name === "spawn")!;
	const session = createSession([
		{ role: "assistant", content: [{ type: "text", text: "hello" }] },
	]);
	state.childSessions.set("tool-call-1", session);

	const component = childSpawnTool.renderResult(
		{ content: [{ type: "text", text: "ignored" }] },
		{ expanded: false },
		theme,
		createRenderContext(),
	) as any;

	const lines = component.render(120);
	assert.ok(lines.some((l: string) => l.includes("hello")));
});

test("expanded nested spawn header stays within width after indent", () => {
	const state = createState();
	const childSpawnTool = createChildTools(new MockPi() as any, state, "medium", 0).find(t => t.name === "spawn")!;
	const session = createSession([
		{ role: "assistant", content: [{ type: "text", text: "hello" }] },
	]);
	state.childSessions.set("tool-call-1", session);

	const component = childSpawnTool.renderResult(
		{
			content: [{ type: "text", text: "ignored" }],
			details: { depth: 2, model: "model-name", thinking: "medium", truncated: false },
		},
		{ expanded: true },
		theme,
		createRenderContext({ expanded: true }),
	) as any;

	const lines = component.render(24);
	assert.ok(lines[0].startsWith("        "));
	assert.ok(stripAnsi(lines[0]).length <= 24);
});

test("nested spawn clears cached render when showImages changes", () => {
	const state = createState();
	const childSpawnTool = createChildTools(new MockPi() as any, state, "medium", 0).find(t => t.name === "spawn")!;
	const session = createSession([
		{ role: "assistant", content: [{ type: "text", text: "hello" }, { type: "image", data: "iVBOR", mimeType: "image/png" }] },
	]);
	state.childSessions.set("tool-call-1", session);

	const component = childSpawnTool.renderResult(
		{
			content: [{ type: "text", text: "ignored" }],
			details: { depth: 1, model: "mock-model", thinking: "medium", truncated: false },
		},
		{ expanded: true },
		theme,
		createRenderContext({ expanded: true, showImages: true }),
	) as any;
	const linesWithImages = component.render(120);

	const sameComponent = childSpawnTool.renderResult(
		{
			content: [{ type: "text", text: "ignored" }],
			details: { depth: 1, model: "mock-model", thinking: "medium", truncated: false },
		},
		{ expanded: true },
		theme,
		createRenderContext({ expanded: true, showImages: false, lastComponent: component }),
	) as any;
	const linesWithoutImages = sameComponent.render(120);

	assert.equal(sameComponent, component);
	assert.notEqual(linesWithImages, linesWithoutImages);
});

test("nested spawn rerenders when stats become unavailable", () => {
	const state = createState();
	const childSpawnTool = createChildTools(new MockPi() as any, state, "medium", 0).find(t => t.name === "spawn")!;
	const session = createSession([
		{ role: "assistant", content: [{ type: "text", text: "hello" }] },
	]);
	state.childSessions.set("tool-call-1", session);

	const component = childSpawnTool.renderResult(
		{
			content: [{ type: "text", text: "ignored" }],
			details: { depth: 1, model: "mock-model", thinking: "medium", truncated: false },
		},
		{ expanded: false },
		theme,
		createRenderContext(),
	) as any;
	const before = component.render(120);
	assert.equal(before.some((l: string) => l.includes("stats unavailable")), false);

	const sameComponent = childSpawnTool.renderResult(
		{
			content: [{ type: "text", text: "ignored" }],
			details: { depth: 1, model: "mock-model", thinking: "medium", truncated: false, outcome: "success", statsUnavailable: true },
		},
		{ expanded: false },
		theme,
		createRenderContext({ lastComponent: component }),
	) as any;
	const after = sameComponent.render(120);

	assert.equal(sameComponent, component);
	assert.ok(after.some((l: string) => l.includes("stats unavailable")));
	assert.equal(after.some((l: string) => l.includes("initializing")), false);
});

test("spawn execute propagates only executable parent tools to child session", async () => {
	const pi = new MockPi();
	pi.setActiveTools(["read", "bash", "spawn", "handoff", "future_tool"]);
	pi.setToolSource("future_tool", "project");
	const state = createState();

	let seenConfig: any;
	const mockFactory = async (config: any) => {
		seenConfig = config;
		const session = {
			messages: [] as any[],
			prompt: async () => {
				session.messages = [{ role: "assistant", content: [{ type: "text", text: "child result" }] }];
			},
			abort: async () => {},
			getSessionStats: () => undefined,
		};
		return { session: session as any };
	};

	registerSpawnTool(pi as any, state, mockFactory as any);

	await pi.tools.get("spawn").execute(
		"spawn-1",
		{ prompt: "Do the task", thinking: "high" },
		undefined,
		undefined,
		{ model: { id: "mock-model" }, cwd: "/tmp" },
	);

	assert.equal(seenConfig.model.id, "mock-model");
	assert.equal(seenConfig.thinkingLevel, "high");
	assert.equal(seenConfig.cwd, "/tmp");
	assert.equal(seenConfig.tools.includes("read"), true);
	assert.equal(seenConfig.tools.includes("bash"), true);
	assert.equal(seenConfig.tools.includes("future_tool"), false);
	assert.equal(seenConfig.tools.includes("handoff"), false);
	assert.equal(seenConfig.tools.includes("spawn"), false);
});

test("spawn execute builds prompt with ledger and task", async () => {
	const pi = new MockPi();
	pi.setActiveTools(["read", "bash", "spawn"]);
	const state = createState();
	state.ledger.set("entry-a", "preview line\nfull body");

	let seenPrompt = "";
	const mockFactory = async (config: any) => {
		const session = {
			messages: [] as any[],
			prompt: async (prompt: string) => {
				seenPrompt = prompt;
				session.messages = [{ role: "assistant", content: [{ type: "text", text: "child result" }] }];
			},
			abort: async () => {},
			getSessionStats: () => undefined,
		};
		return { session: session as any };
	};

	registerSpawnTool(pi as any, state, mockFactory as any);

	await pi.tools.get("spawn").execute(
		"spawn-1",
		{ prompt: "Do the task" },
		undefined,
		undefined,
		{ model: { id: "mock-model" }, cwd: "/tmp" },
	);

	// Verify user-facing invariants: task text is included, ledger entries are referenced
	assert.match(seenPrompt, /Do the task/);
	assert.match(seenPrompt, /entry-a: preview line/);
});

test("spawn renderResult falls back to static text when no live session is stored", () => {
	const state = createState();
	const pi = new MockPi();
	registerSpawnTool(pi as any, state);

	const result = pi.tools.get("spawn").renderResult(
		{
			content: [{ type: "text", text: "fallback output" }],
			details: { depth: 1, model: "m", thinking: "low", truncated: false },
		},
		{ expanded: false },
		theme,
		createRenderContext(),
	) as any;

	const lines = result.render(120);
	assert.ok(lines.some((l: string) => l.includes("m • low")));
	assert.ok(lines.some((l: string) => l.includes("fallback output")));
});

test("spawn renderResult distinguishes aborted and error outcomes", () => {
	const state = createState();
	const pi = new MockPi();
	registerSpawnTool(pi as any, state);

	const aborted = pi.tools.get("spawn").renderResult(
		{
			content: [{ type: "text", text: "stopped" }],
			details: { depth: 1, model: "m", thinking: "low", truncated: false, outcome: "aborted" },
		},
		{ expanded: false },
		theme,
		createRenderContext(),
	) as any;
	const error = pi.tools.get("spawn").renderResult(
		{
			content: [{ type: "text", text: "failed" }],
			details: { depth: 1, model: "m", thinking: "low", truncated: false, outcome: "error" },
		},
		{ expanded: false },
		theme,
		createRenderContext(),
	) as any;

	const abortedLines = aborted.render(120);
	const errorLines = error.render(120);
	assert.ok(abortedLines.some((l: string) => l.includes("✗ m • low")));
	assert.ok(abortedLines.some((l: string) => l.includes("aborted")));
	assert.ok(errorLines.some((l: string) => l.includes("⚠ m • low")));
	assert.ok(errorLines.some((l: string) => l.includes("error")));
});

test("spawn execute returns result and stats", async () => {
	const pi = new MockPi();
	pi.setActiveTools(["read", "bash", "spawn"]);
	const state = createState();

	const updates: any[] = [];
	const mockFactory = async () => {
		const session = {
			messages: [] as any[],
			prompt: async () => {
				session.messages = [{ role: "assistant", content: [{ type: "text", text: "child result" }] }];
			},
			abort: async () => {},
			getSessionStats: () => ({
				tokens: { input: 11, output: 22, cacheRead: 3, cacheWrite: 4, total: 40 },
				cost: 0.5,
				assistantMessages: 2,
			}),
		};
		return { session: session as any };
	};

	registerSpawnTool(pi as any, state, mockFactory as any);

	const result = await pi.tools.get("spawn").execute(
		"spawn-1",
		{ prompt: "Do the task", thinking: "high" },
		undefined,
		(update: any) => updates.push(update),
		{ model: { id: "mock-model" }, cwd: "/tmp" },
	);

	assert.deepEqual(updates, [{
		content: [],
		details: { depth: 1, model: "mock-model", thinking: "high", truncated: false, outcome: "running" },
	}]);
	assert.equal(result.content[0].text, "child result");
	assert.equal(result.details.outcome, "success");
	assert.deepEqual(result.details.stats, {
		inputTokens: 11,
		outputTokens: 22,
		cacheReadTokens: 3,
		cacheWriteTokens: 4,
		totalTokens: 40,
		cost: 0.5,
		turns: 2,
	});
});

test("spawn execute marks stats unavailable when stats collection throws", async () => {
	const pi = new MockPi();
	pi.setActiveTools(["read", "bash", "spawn"]);
	const state = createState();

	const warnings: any[] = [];
	const originalWarn = console.warn;
	console.warn = (...args: any[]) => {
		warnings.push(args);
	};

	try {
		const mockFactory = async () => {
			const session = {
				messages: [] as any[],
				prompt: async () => {
					session.messages = [{ role: "assistant", content: [{ type: "text", text: "child result" }] }];
				},
				abort: async () => {},
				getSessionStats: () => {
					throw new Error("stats failed");
				},
			};
			return { session: session as any };
		};

		registerSpawnTool(pi as any, state, mockFactory as any);
		const result = await pi.tools.get("spawn").execute(
			"spawn-1",
			{ prompt: "Do the task" },
			undefined,
			undefined,
			{ model: { id: "mock-model" }, cwd: "/tmp" },
		);

		assert.equal(result.details.stats, undefined);
		assert.equal(result.details.statsUnavailable, true);
		assert.equal(warnings.length, 1);
		assert.match(String(warnings[0][1]), /stats failed/);
		assert.equal(warnings[0][2], "spawn-1");
	} finally {
		console.warn = originalWarn;
	}
});

test("spawn execute throws when child produces no output", async () => {
	const pi = new MockPi();
	pi.setActiveTools(["read", "bash", "spawn"]);
	const state = createState();

	const mockFactory = async () => {
		const session = {
			messages: [] as any[],
			prompt: async () => {},
			abort: async () => {},
			getSessionStats: () => undefined,
		};
		return { session: session as any };
	};

	registerSpawnTool(pi as any, state, mockFactory as any);

	await assert.rejects(
		() => pi.tools.get("spawn").execute("spawn-1", { prompt: "Do the task" }, undefined, undefined, { model: { id: "mock-model" }, cwd: "/tmp" }),
		/Child agent produced no output\./,
	);
});

test("spawn execute clears childSessions when prompt throws", async () => {
	const pi = new MockPi();
	pi.setActiveTools(["read", "bash", "spawn"]);
	const state = createState();

	const mockFactory = async () => {
		const session = {
			messages: [] as any[],
			prompt: async () => {
				throw new Error("prompt failed");
			},
			abort: async () => {},
			getSessionStats: () => undefined,
		};
		return { session: session as any };
	};

	registerSpawnTool(pi as any, state, mockFactory as any);

	await assert.rejects(
		() => pi.tools.get("spawn").execute("spawn-1", { prompt: "Do the task" }, undefined, undefined, { model: { id: "mock-model" }, cwd: "/tmp" }),
		/prompt failed/,
	);
	assert.equal(state.childSessions.size, 0);
});

test("spawn execute clears childSessions after successful completion when unrendered", async () => {
	const pi = new MockPi();
	pi.setActiveTools(["read", "bash", "spawn"]);
	const state = createState();

	const mockFactory = async () => {
		const session = {
			messages: [] as any[],
			prompt: async () => {
				session.messages = [{ role: "assistant", content: [{ type: "text", text: "child result" }] }];
			},
			abort: async () => {},
			getSessionStats: () => undefined,
		};
		return { session: session as any };
	};

	registerSpawnTool(pi as any, state, mockFactory as any);
	const result = await pi.tools.get("spawn").execute(
		"spawn-1",
		{ prompt: "Do the task" },
		undefined,
		undefined,
		{ model: { id: "mock-model" }, cwd: "/tmp" },
	);

	assert.equal(result.content[0].text, "child result");
	assert.equal(state.childSessions.size, 0);
});

test("spawn execute fails explicitly without a configured model", async () => {
	const pi = new MockPi();
	const state = createState();
	registerSpawnTool(pi as any, state);
	await assert.rejects(
		() => pi.tools.get("spawn").execute("spawn-1", { prompt: "Do the task" }, undefined, undefined, { cwd: "/tmp" }),
		/No model configured\. Cannot spawn child agent\./,
	);
});

test("child tool set omits spawn and handoff at max depth", () => {
	const state = createState();
	const childTools = createChildTools(new MockPi() as any, state, "medium", 1);
	assert.equal(childTools.some(t => t.name === "spawn"), false);
	const maxDepthToolNames = buildChildToolNames(
		["read", "bash", "spawn", "handoff", "future_tool"],
		childTools,
		[
			{ name: "read", sourceInfo: { source: "builtin" } },
			{ name: "bash", sourceInfo: { source: "builtin" } },
			{ name: "spawn", sourceInfo: { source: "builtin" } },
			{ name: "handoff", sourceInfo: { source: "builtin" } },
			{ name: "future_tool", sourceInfo: { source: "project" } },
		] as any,
	);
	assert.equal(maxDepthToolNames.includes("spawn"), false);
	assert.equal(maxDepthToolNames.includes("handoff"), false);
	assert.equal(maxDepthToolNames.includes("future_tool"), false);

	const nestedTools = createChildTools(new MockPi() as any, state, "medium", 0);
	assert.ok(nestedTools.some(t => t.name === "spawn"));
});

test("spawn renderResult transfers session ownership out of shared state", () => {
	const state = createState();
	const session = createSession([
		{ role: "assistant", content: [{ type: "text", text: "hello" }] },
	]);
	state.childSessions.set("tool-call-1", session);

	const pi = new MockPi();
	registerSpawnTool(pi as any, state);

	const component = pi.tools.get("spawn").renderResult(
		{ content: [{ type: "text", text: "hello" }], details: { depth: 1, model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext(),
	) as any;

	assert.equal(state.childSessions.has("tool-call-1"), false);
	const lines = component.render(120);
	assert.ok(lines.some((l: string) => l.includes("hello")));
});

test("spawn renderResult reuses lastComponent", () => {
	const state = createState();
	const session = createSession([
		{ role: "assistant", content: [{ type: "text", text: "hello" }] },
	]);
	state.childSessions.set("tool-call-1", session);

	const pi = new MockPi();
	registerSpawnTool(pi as any, state);

	const first = pi.tools.get("spawn").renderResult(
		{ content: [{ type: "text", text: "hello" }], details: { depth: 1, model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext(),
	);
	const second = pi.tools.get("spawn").renderResult(
		{ content: [{ type: "text", text: "hello" }], details: { depth: 1, model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext({ lastComponent: first }),
	);
	assert.equal(first, second);
});

test("resetState aborts and clears child session registries", () => {
	const state = createState();
	let abortCalls = 0;
	const session = {
		...createSession([]),
		abort: async () => {
			abortCalls++;
		},
	} as any;
	state.childSessions.set("tool-call-1", session);
	state.liveChildSessions.set("tool-call-1", session);
	resetState(state);
	assert.equal(abortCalls, 1);
	assert.equal(state.childSessions.size, 0);
	assert.equal(state.liveChildSessions.size, 0);
});

test("resetState aborts a claimed child session after render ownership transfer", () => {
	const state = createState();
	const childSpawnTool = createChildTools(new MockPi() as any, state, "medium", 0).find(t => t.name === "spawn")!;
	let abortCalls = 0;
	const session = {
		...createSession([{ role: "assistant", content: [{ type: "text", text: "hello" }] }]),
		abort: async () => {
			abortCalls++;
		},
	} as any;
	state.childSessions.set("tool-call-1", session);
	state.liveChildSessions.set("tool-call-1", session);

	childSpawnTool.renderResult(
		{ content: [{ type: "text", text: "ignored" }], details: { depth: 1, model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext(),
	);

	assert.equal(state.childSessions.has("tool-call-1"), false);
	assert.equal(state.liveChildSessions.has("tool-call-1"), true);

	resetState(state);

	assert.equal(abortCalls, 1);
	assert.equal(state.childSessions.size, 0);
	assert.equal(state.liveChildSessions.size, 0);
});

test("executeSpawn suppresses stale child sessions after resetState during async setup", async () => {
	const pi = new MockPi();
	pi.setActiveTools(["read", "bash", "spawn"]);
	const state = createState();

	let resolveFactory!: (value: any) => void;
	const factoryReady = new Promise<any>((resolve) => {
		resolveFactory = resolve;
	});
	let promptCalled = false;
	let abortCalls = 0;
	let onUpdateCalled = false;
	const staleSession = {
		messages: [] as any[],
		prompt: async () => {
			promptCalled = true;
			staleSession.messages = [{ role: "assistant", content: [{ type: "text", text: "stale result" }] }];
		},
		abort: async () => {
			abortCalls++;
		},
		getSessionStats: () => undefined,
	};

	const executePromise = executeSpawn(
		"spawn-1",
		pi as any,
		{ model: { id: "mock-model" }, cwd: "/tmp" } as any,
		state,
		{ prompt: "Do the task" },
		undefined,
		() => {
			onUpdateCalled = true;
		},
		"medium",
		0,
		async () => factoryReady,
	);

	resetState(state);
	const freshSession = createSession([{ role: "assistant", content: [{ type: "text", text: "fresh result" }] }]);
	state.childSessions.set("spawn-1", freshSession);
	state.liveChildSessions.set("spawn-1", freshSession);
	resolveFactory({ session: staleSession as any });

	await assert.rejects(() => executePromise, /invalidated by reset/i);
	assert.equal(onUpdateCalled, false);
	assert.equal(promptCalled, false);
	assert.equal(abortCalls, 1);
	assert.equal(state.childSessions.get("spawn-1"), freshSession);
	assert.equal(state.liveChildSessions.get("spawn-1"), freshSession);
});

test("child tool names inherit builtin parent tools, exclude handoff, and keep spawn when depth allows", () => {
	const state = createState();
	const childTools = createChildTools(new MockPi() as any, state, "medium", 0);
	assert.ok(childTools.some(t => t.name === "spawn"), "depth-0 child tool definitions should still expose spawn");
	const toolNames = buildChildToolNames(
		["read", "bash", "handoff", "future_tool"],
		childTools,
		[
			{ name: "read", sourceInfo: { source: "builtin" } },
			{ name: "bash", sourceInfo: { source: "builtin" } },
			{ name: "handoff", sourceInfo: { source: "builtin" } },
			{ name: "future_tool", sourceInfo: { source: "project" } },
		] as any,
	);

	assert.ok(toolNames.includes("read"));
	assert.ok(toolNames.includes("bash"));
	assert.equal(toolNames.includes("future_tool"), false);
	assert.ok(toolNames.includes("ledger_add"));
	assert.ok(toolNames.includes("ledger_get"));
	assert.ok(toolNames.includes("ledger_list"));
	assert.equal(toolNames.includes("handoff"), false);
	assert.equal(toolNames.includes("spawn"), true);
});

function createSubscribableSession(messages: any[] = []) {
	let handler: ((event: any) => void) | undefined;
	return {
		session: {
			messages,
			subscribe: (cb: (event: any) => void) => {
				handler = cb;
				return () => { handler = undefined; };
			},
			getToolDefinition: () => undefined,
			sessionManager: { getCwd: () => process.cwd() },
			abort: async () => {},
		} as unknown as import("@earendil-works/pi-coding-agent").AgentSession,
		emit: (event: any) => handler?.(event),
	};
}

test("nested spawn live action tracks tool execution events", () => {
	const state = createState();
	const childSpawnTool = createChildTools(new MockPi() as any, state, "medium", 0).find(t => t.name === "spawn")!;
	const { session, emit } = createSubscribableSession([]);
	state.childSessions.set("tool-call-1", session);

	// Mock console.warn to suppress any expected-but-harmless warnings
	// (e.g., streaming component errors in headless test env).
	const originalWarn = console.warn;
	console.warn = () => {};

	try {
		const component = childSpawnTool.renderResult(
			{ content: [{ type: "text", text: "ignored" }], details: { depth: 1, model: "m", thinking: "low", truncated: false } },
			{ expanded: false },
			theme,
			createRenderContext(),
		) as any;

		// message_start → thinking
		emit({ type: "message_start", message: { role: "assistant", content: [] } });
		let lines = component.render(120);
		assert.ok(lines.some((l: string) => l.includes("thinking")), `expected thinking, got: ${lines.join("\n")}`);

		// message_update with text → live preview
		emit({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "writing code now" }] } });
		lines = component.render(120);
		assert.ok(lines.some((l: string) => l.includes("writing code now")), `expected live text preview, got: ${lines.join("\n")}`);

		// message_end → success marker in identity line
		emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "summary" }], stopReason: "end_turn" } });
		lines = component.render(120);
		assert.ok(lines.some((l: string) => l.includes("✅")), `expected success marker, got: ${lines.join("\n")}`);

		// Tool events degrade gracefully in minimal test env and still update live action
		emit({ type: "tool_execution_start", toolCallId: "tc-1", toolName: "bash", args: { command: "ls" } });
		lines = component.render(120);
		assert.ok(lines.some((l: string) => l.includes("[bash]")), `expected tool live action, got: ${lines.join("\n")}`);
	} finally {
		console.warn = originalWarn;
	}
});

test("nested spawn handleEvent recovers from malformed events", () => {
	const state = createState();
	const childSpawnTool = createChildTools(new MockPi() as any, state, "medium", 0).find(t => t.name === "spawn")!;
	const { session, emit } = createSubscribableSession([]);
	state.childSessions.set("tool-call-1", session);

	const warnings: any[] = [];
	const originalWarn = console.warn;
	console.warn = (...args: any[]) => warnings.push(args);

	try {
		const component = childSpawnTool.renderResult(
			{ content: [{ type: "text", text: "ignored" }], details: { depth: 1, model: "m", thinking: "low", truncated: false } },
			{ expanded: false },
			theme,
			createRenderContext(),
		) as any;

		// Emit a malformed event that will throw inside handleEvent
		emit({ type: "message_start", message: null });
		assert.equal(warnings.length, 1);
		assert.match(String(warnings[0][1]), /message_start/);

		// Subsequent valid events still process
		emit({ type: "message_start", message: { role: "assistant", content: [] } });
		const lines = component.render(120);
		assert.ok(lines.some((l: string) => l.includes("thinking")), `expected thinking after recovery, got: ${lines.join("\n")}`);
	} finally {
		console.warn = originalWarn;
	}
});

test("nested spawn message_end with aborted stopReason clears pending tools", () => {
	const state = createState();
	const childSpawnTool = createChildTools(new MockPi() as any, state, "medium", 0).find(t => t.name === "spawn")!;
	const { session, emit } = createSubscribableSession([]);
	state.childSessions.set("tool-call-1", session);

	const component = childSpawnTool.renderResult(
		{ content: [{ type: "text", text: "ignored" }], details: { depth: 1, model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext(),
	) as any;

	// Start an assistant message
	emit({ type: "message_start", message: { role: "assistant", content: [] } });
	// End it with aborted — sets lastAction to "aborted"
	emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "partial" }], stopReason: "aborted", errorMessage: "killed" } });

	const lines = component.render(120);
	assert.ok(lines.some((l: string) => l.includes("aborted")), `expected aborted, got: ${lines.join("\n")}`);
});

test("nested spawn dispose stops event processing", () => {
	const state = createState();
	const childSpawnTool = createChildTools(new MockPi() as any, state, "medium", 0).find(t => t.name === "spawn")!;
	const { session, emit } = createSubscribableSession([]);
	state.childSessions.set("tool-call-1", session);

	const component = childSpawnTool.renderResult(
		{ content: [{ type: "text", text: "ignored" }], details: { depth: 1, model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext(),
	) as any;

	component.dispose();

	// Emit event after dispose — should not update state or crash
	emit({ type: "message_start", message: { role: "assistant", content: [] } });
	const after = component.render(120);

	assert.ok(after.every((line: string) => !line.includes("thinking")), `unexpected post-dispose update: ${after.join("\n")}`);
});

test("nested spawn dispose aborts a claimed live child session", () => {
	const state = createState();
	const childSpawnTool = createChildTools(new MockPi() as any, state, "medium", 0).find(t => t.name === "spawn")!;
	let abortCalls = 0;
	const session = {
		...createSession([{ role: "assistant", content: [{ type: "text", text: "hello" }] }]),
		abort: async () => {
			abortCalls++;
		},
	} as any;
	state.childSessions.set("tool-call-1", session);
	state.liveChildSessions.set("tool-call-1", session);

	const component = childSpawnTool.renderResult(
		{ content: [{ type: "text", text: "ignored" }], details: { depth: 1, model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext(),
	) as any;

	assert.equal(state.childSessions.has("tool-call-1"), false);
	assert.equal(state.liveChildSessions.has("tool-call-1"), true);

	component.dispose();

	assert.equal(abortCalls, 1);
	assert.equal(state.liveChildSessions.has("tool-call-1"), false);
});

test("spawn execute short-circuits when signal is already aborted", async () => {
	const pi = new MockPi();
	pi.setActiveTools(["read", "bash", "spawn"]);
	const state = createState();

	let abortCalled = false;
	let promptCalled = false;
	let onUpdateCalled = false;
	const mockFactory = async () => {
		const session = {
			messages: [] as any[],
			prompt: async () => {
				promptCalled = true;
			},
			abort: async () => { abortCalled = true; },
			getSessionStats: () => undefined,
		};
		return { session: session as any };
	};

	registerSpawnTool(pi as any, state, mockFactory as any);

	const controller = new AbortController();
	controller.abort();

	await assert.rejects(
		() => pi.tools.get("spawn").execute(
			"spawn-1",
			{ prompt: "Do the task" },
			controller.signal,
			() => { onUpdateCalled = true; },
			{ model: { id: "mock-model" }, cwd: "/tmp" },
		),
		/abort/i,
	);

	assert.equal(abortCalled, true);
	assert.equal(promptCalled, false);
	assert.equal(onUpdateCalled, false);
	assert.equal(state.childSessions.size, 0);
	assert.equal(state.liveChildSessions.size, 0);
});

test("spawn execute truncates very long child output", async () => {
	const pi = new MockPi();
	pi.setActiveTools(["read", "bash", "spawn"]);
	const state = createState();

	// Generate > 2000 lines of output
	const longText = Array.from({ length: 2100 }, (_, i) => `Line ${i + 1}`).join("\n");

	const mockFactory = async () => {
		const session = {
			messages: [] as any[],
			prompt: async () => {
				session.messages = [{ role: "assistant", content: [{ type: "text", text: longText }] }];
			},
			abort: async () => {},
			getSessionStats: () => undefined,
		};
		return { session: session as any };
	};

	registerSpawnTool(pi as any, state, mockFactory as any);

	const result = await pi.tools.get("spawn").execute(
		"spawn-1",
		{ prompt: "Generate lots of output" },
		undefined,
		undefined,
		{ model: { id: "mock-model" }, cwd: "/tmp" },
	);

	assert.equal(result.details.truncated, true);
	assert.ok(result.content[0].text.includes("[Result truncated"));
	assert.equal(state.liveChildSessions.size, 0);
});

test("spawn execute truncates child output by byte limit", async () => {
	const pi = new MockPi();
	pi.setActiveTools(["read", "bash", "spawn"]);
	const state = createState();
	const longText = "🙂".repeat(20_000);

	const mockFactory = async () => {
		const session = {
			messages: [] as any[],
			prompt: async () => {
				session.messages = [{ role: "assistant", content: [{ type: "text", text: longText }] }];
			},
			abort: async () => {},
			getSessionStats: () => undefined,
		};
		return { session: session as any };
	};

	registerSpawnTool(pi as any, state, mockFactory as any);

	const result = await pi.tools.get("spawn").execute(
		"spawn-1",
		{ prompt: "Generate byte-heavy output" },
		undefined,
		undefined,
		{ model: { id: "mock-model" }, cwd: "/tmp" },
	);

	assert.equal(result.details.truncated, true);
	assert.ok(result.content[0].text.includes("[Result truncated"));
	assert.ok(result.content[0].text.length < longText.length);
	assert.equal(result.content[0].text.includes("\n"), true);
});

test("spawn execute tells children when no ledger entries exist", async () => {
	const pi = new MockPi();
	pi.setActiveTools(["read", "bash", "spawn"]);
	const state = createState();
	let promptText = "";
	const mockFactory = async () => {
		const session = {
			messages: [] as any[],
			prompt: async (text: string) => {
				promptText = text;
				session.messages = [{ role: "assistant", content: [{ type: "text", text: "done" }] }];
			},
			abort: async () => {},
			getSessionStats: () => undefined,
		};
		return { session: session as any };
	};

	registerSpawnTool(pi as any, state, mockFactory as any);

	await pi.tools.get("spawn").execute(
		"spawn-1",
		{ prompt: "Do the task" },
		undefined,
		undefined,
		{ model: { id: "mock-model" }, cwd: "/tmp" },
	);

	assert.match(promptText, /No ledger entries\./);
	assert.doesNotMatch(promptText, /Available ledger entries:/);
});

test("executeSpawn → onUpdate → renderResult chains session ownership", async () => {
	const pi = new MockPi();
	pi.setActiveTools(["read", "bash", "spawn"]);
	const state = createState();

	let onUpdateCalled = false;
	let renderComponent: any = null;
	const mockFactory = async () => {
		const session = {
			messages: [] as any[],
			prompt: async () => {
				session.messages = [{ role: "assistant", content: [{ type: "text", text: "result" }] }];
			},
			abort: async () => {},
			getSessionStats: () => undefined,
		};
		return { session: session as any };
	};

	registerSpawnTool(pi as any, state, mockFactory as any);

	const executePromise = pi.tools.get("spawn").execute(
		"spawn-1",
		{ prompt: "Do the task" },
		undefined,
		(update: any) => {
			onUpdateCalled = true;
			// Simulate pi rendering during execution by calling renderResult
			// with the same toolCallId the execute call is using.
			renderComponent = pi.tools.get("spawn").renderResult(
				{ content: [], details: update.details },
				{ expanded: false },
				theme,
				{ toolCallId: "spawn-1", expanded: false, showImages: true, lastComponent: undefined, invalidate: () => {} },
			);
		},
		{ model: { id: "mock-model" }, cwd: "/tmp" },
	);

	const result = await executePromise;

	// onUpdate was called
	assert.equal(onUpdateCalled, true);

	// renderComponent from onUpdate has a live session attached
	assert.equal(typeof renderComponent.hasSession, "function");
	assert.equal(renderComponent.hasSession(), true);

	// Session ownership was transferred out of the render handoff queue
	assert.equal(state.childSessions.has("spawn-1"), false);
	assert.equal(state.liveChildSessions.has("spawn-1"), false);

	// Component renders session content
	const lines = renderComponent.render(120);
	const text = lines.join(" ");
	assert.ok(text.includes("result"), `expected result in render, got: ${text}`);

	// Final execute result is also correct
	assert.equal(result.content[0].text, "result");
});

test("spawn render shows success state when stats are unavailable", () => {
	const state = createState();
	const childSpawnTool = createChildTools(new MockPi() as any, state, "medium", 0).find(t => t.name === "spawn")!;
	const session = createSession([
		{ role: "assistant", content: [{ type: "text", text: "final summary" }] },
	]);
	state.childSessions.set("tool-call-1", session);

	const component = childSpawnTool.renderResult(
		{
			content: [{ type: "text", text: "ignored" }],
			details: { depth: 1, model: "mock-model", thinking: "medium", truncated: false, outcome: "success", statsUnavailable: true },
		},
		{ expanded: false },
		theme,
		createRenderContext(),
	) as any;

	const lines = component.render(120);
	assert.ok(lines.some((l: string) => l.includes("✅ [depth 1] mock-model • medium")));
	assert.ok(lines.some((l: string) => l.includes("stats unavailable")));
	assert.equal(lines.some((l: string) => l.includes("initializing")), false);
});

test("spawn execute aborts child session when signal fires during execution", async () => {
	const pi = new MockPi();
	pi.setActiveTools(["read", "bash", "spawn"]);
	const state = createState();

	let abortCalled = false;
	let resolvePrompt!: () => void;
	let promptStarted!: () => void;
	const started = new Promise<void>((resolve) => { promptStarted = resolve; });
	const mockFactory = async () => {
		const session = {
			messages: [] as any[],
			prompt: async () => {
				promptStarted();
				await new Promise<void>((resolve) => { resolvePrompt = resolve; });
				session.messages = [{ role: "assistant", content: [{ type: "text", text: "aborted mid-flight" }] }];
			},
			abort: async () => {
				abortCalled = true;
				resolvePrompt();
			},
			getSessionStats: () => undefined,
		};
		return { session: session as any };
	};

	registerSpawnTool(pi as any, state, mockFactory as any);

	const controller = new AbortController();
	const executePromise = pi.tools.get("spawn").execute(
		"spawn-1",
		{ prompt: "Do the task" },
		controller.signal,
		undefined,
		{ model: { id: "mock-model" }, cwd: "/tmp" },
	);

	await started;
	controller.abort();

	const result = await executePromise;
	assert.equal(abortCalled, true);
	assert.equal(state.childSessions.size, 0);
	assert.equal(state.liveChildSessions.size, 0);
	assert.equal(result.content[0].text, "aborted mid-flight");
	assert.equal(result.details.outcome, "aborted");
});

test("spawn renderCall shows prompt preview and thinking level", () => {
	const state = createState();
	const pi = new MockPi();
	registerSpawnTool(pi as any, state);

	const tool = pi.tools.get("spawn");

	// Collapsed: short prompt
	const collapsed = tool.renderCall({ prompt: "Do X" }, theme, { expanded: false });
	const collapsedLines = collapsed.render(120);
	assert.ok(collapsedLines.some((l: string) => l.includes("spawn")));
	assert.ok(collapsedLines.some((l: string) => l.includes("Do X")));

	// Collapsed: long prompt shows truncation hint
	const longPrompt = Array.from({ length: 10 }, (_, i) => `Line ${i}`).join("\n");
	const truncated = tool.renderCall({ prompt: longPrompt }, theme, { expanded: false });
	const truncatedLines = truncated.render(120);
	assert.ok(truncatedLines.some((l: string) => l.includes("more lines")));

	// With thinking level
	const withThinking = tool.renderCall({ prompt: "Do X", thinking: "high" }, theme, { expanded: false });
	const thinkingLines = withThinking.render(120);
	assert.ok(thinkingLines.some((l: string) => l.includes("high")));

	// Expanded: shows full prompt
	const expanded = tool.renderCall({ prompt: longPrompt }, theme, { expanded: true });
	const expandedLines = expanded.render(120);
	assert.ok(!expandedLines.some((l: string) => l.includes("more lines")));
});

test("spawn execute rejects at max spawn depth", async () => {
	const pi = new MockPi();
	pi.setActiveTools(["read", "bash", "spawn"]);
	const state = createState();

	// At max depth, spawn is excluded from child tools
	const childTools = createChildTools(pi as any, state, "medium", 1);
	assert.equal(childTools.some(t => t.name === "spawn"), false);

	// executeSpawn directly called at max depth throws
	await assert.rejects(
		executeSpawn(
			"spawn-1",
			pi as any,
			{} as any,
			state,
			{ prompt: "Do the task" },
			undefined,
			undefined,
			"medium",
			1,
		),
		/Max spawn depth/,
	);
});

test("ledger rehydration rebuilds the latest epoch and enables ledger tools", async () => {
	const pi = new MockPi();
	const state = createState();
	registerLedgerRehydration(pi as any, state);
	const [handler] = pi.handlers.get("session_start")!;

	await handler(
		{},
		{
			sessionManager: {
				getBranch: () => [
					{ type: "custom", customType: "ledger-entry", data: { epoch: 1, name: "old", content: "old" } },
					{ type: "custom", customType: "ledger-entry", data: { epoch: 2, name: "keep", content: "new" } },
					{ type: "custom", customType: "ledger-entry", data: { epoch: 2, name: "keep", content: "newer" } },
				],
			},
		},
	);

	assert.equal(state.epoch, 2);
	assert.deepEqual(Array.from(state.ledger.entries()), [["keep", "newer"]]);
	assert.deepEqual(pi.activeTools, ["ledger_get", "ledger_list"]);
});

test("ledger tools add/get/list return stable contract details", async () => {
	const pi = new MockPi();
	const state = createState();
	const [ledgerAdd, ledgerGet, ledgerList] = createLedgerToolDefinitions(pi as any, state);

	const addResult = await ledgerAdd.execute("1", { name: "entry-a", content: "first line\nsecond line" }, undefined, undefined, {} as any);
	assert.deepEqual(addResult.details, { entries: ["entry-a"] });
	assert.equal(state.ledger.get("entry-a"), "first line\nsecond line");
	assert.equal(pi.appendedEntries.length, 1);
	assert.equal(pi.appendedEntries[0].customType, "ledger-entry");
	assert.equal(pi.appendedEntries[0].data.name, "entry-a");

	const getResult = await ledgerGet.execute("2", { name: "entry-a" }, undefined, undefined, {} as any);
	assert.equal(getResult.details.found, true);
	assert.deepEqual(getResult.details.entries, ["entry-a"]);
	assert.match(getResult.content[0].text, /--- entry-a ---/);
	assert.match(getResult.content[0].text, /second line/);

	const listResult = await ledgerList.execute("3", {}, undefined, undefined, {} as any);
	assert.deepEqual(listResult.details, { entries: ["entry-a"] });
	assert.match(listResult.content[0].text, /entry-a: first line/);
});

test("child ledger tools reject stale access after reset", async () => {
	const pi = new MockPi();
	const state = createState();
	state.ledger.set("entry-a", "alpha");
	let stale = false;
	const [ledgerAdd, ledgerGet, ledgerList] = createLedgerToolDefinitions(pi as any, state, { isStale: () => stale });

	stale = true;
	await assert.rejects(
		() => ledgerAdd.execute("1", { name: "entry-a", content: "alpha" }, undefined, undefined, {} as any),
		/invalidated by reset/i,
	);
	await assert.rejects(
		() => ledgerGet.execute("2", { name: "entry-a" }, undefined, undefined, {} as any),
		/invalidated by reset/i,
	);
	await assert.rejects(
		() => ledgerList.execute("3", {}, undefined, undefined, {} as any),
		/invalidated by reset/i,
	);
	assert.equal(state.ledger.get("entry-a"), "alpha");
	assert.equal(pi.appendedEntries.length, 0);
});

test("child ledger_add succeeds while child session is fresh", async () => {
	const pi = new MockPi();
	const state = createState();
	const [ledgerAdd] = createLedgerToolDefinitions(pi as any, state, { isStale: () => false });

	const result = await ledgerAdd.execute("1", { name: "entry-a", content: "alpha" }, undefined, undefined, {} as any);
	assert.deepEqual(result.details, { entries: ["entry-a"] });
	assert.equal(state.ledger.get("entry-a"), "alpha");
	assert.equal(pi.appendedEntries.length, 1);
});

test("ledger_get reports not found with current entry names", async () => {
	const pi = new MockPi();
	const state = createState();
	state.ledger.set("entry-a", "alpha");
	state.ledger.set("entry-b", "beta");
	const [, ledgerGet] = createLedgerToolDefinitions(pi as any, state);

	const result = await ledgerGet.execute("1", { name: "missing" }, undefined, undefined, {} as any);
	assert.deepEqual(result.details, { entries: ["entry-a", "entry-b"], found: false });
	assert.match(result.content[0].text, /Entry "missing" not found\./);
	assert.match(result.content[0].text, /entry-a: alpha/);
	assert.match(result.content[0].text, /entry-b: beta/);
});

test("ledger tools show empty-state placeholders", async () => {
	const pi = new MockPi();
	const state = createState();
	const [, ledgerGet, ledgerList] = createLedgerToolDefinitions(pi as any, state);

	const missing = await ledgerGet.execute("1", { name: "missing" }, undefined, undefined, {} as any);
	assert.deepEqual(missing.details, { entries: [], found: false });
	assert.match(missing.content[0].text, /Entries:\n\(empty\)/);

	const list = await ledgerList.execute("2", {}, undefined, undefined, {} as any);
	assert.deepEqual(list.details, { entries: [] });
	assert.match(list.content[0].text, /Entries:\n\(empty\)/);
});

test("nested spawn invalidate() flushes render cache", () => {
	const state = createState();
	const childSpawnTool = createChildTools(new MockPi() as any, state, "medium", 0).find(t => t.name === "spawn")!;
	const session = createSession([
		{ role: "assistant", content: [{ type: "text", text: "before" }] },
	]);
	state.childSessions.set("tool-call-1", session);

	const component = childSpawnTool.renderResult(
		{ content: [], details: { depth: 1, model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext(),
	) as any;

	const firstRender = component.render(120);
	assert.ok(firstRender.some((l: string) => l.includes("before")));

	// Same render call should hit cache
	const secondRender = component.render(120);
	assert.ok(secondRender.some((l: string) => l.includes("before")));

	// Modify underlying session data and invalidate
	session.messages[0].content[0].text = "after";
	component.invalidate();

	const thirdRender = component.render(120);
	assert.notEqual(firstRender, thirdRender);
	assert.ok(thirdRender.some((l: string) => l.includes("after")));
	assert.equal(thirdRender.some((l: string) => l.includes("before")), false);
});

test("nested spawn rebuildFromSession quietly tolerates missing tool definitions", () => {
	const state = createState();
	const childSpawnTool = createChildTools(new MockPi() as any, state, "medium", 0).find(t => t.name === "spawn")!;
	const session = {
		messages: [{
			role: "assistant",
			content: [{ type: "toolCall", name: "bash", id: "tc-1", arguments: { command: "ls" } }],
			stopReason: "error",
			errorMessage: "boom",
		}],
		subscribe: () => () => {},
		getToolDefinition: () => { throw new Error("missing tool definition"); },
		sessionManager: { getCwd: () => process.cwd() },
		abort: async () => {},
	} as any;
	state.childSessions.set("tool-call-1", session);

	const warnings: any[] = [];
	const originalWarn = console.warn;
	console.warn = (...args: any[]) => warnings.push(args);

	try {
		const component = childSpawnTool.renderResult(
			{ content: [], details: { depth: 1, model: "m", thinking: "low", truncated: false, outcome: "error" } },
			{ expanded: false },
			theme,
			createRenderContext(),
		) as any;

		const lines = component.render(120);
		assert.ok(lines.some((l: string) => l.includes("⚠ [depth 1] m • low")));
		assert.ok(lines.some((l: string) => l.includes("error")));
		assert.equal(state.childSessions.has("tool-call-1"), false);
		assert.deepEqual(warnings, []);
	} finally {
		console.warn = originalWarn;
	}
});

test("nested spawn attachSession recovers from subscribe throwing", () => {
	const state = createState();
	const childSpawnTool = createChildTools(new MockPi() as any, state, "medium", 0).find(t => t.name === "spawn")!;

	// Session whose subscribe() throws
	const throwingSession = {
		messages: [{ role: "assistant", content: [{ type: "text", text: "hello" }] }],
		subscribe: () => { throw new Error("subscribe failed"); },
		getToolDefinition: () => undefined,
		sessionManager: { getCwd: () => process.cwd() },
		abort: async () => {},
	} as any;
	state.childSessions.set("tool-call-1", throwingSession);

	const warnings: any[] = [];
	const originalWarn = console.warn;
	console.warn = (...args: any[]) => warnings.push(args);

	try {
		const component = childSpawnTool.renderResult(
			{ content: [], details: { depth: 1, model: "m", thinking: "low", truncated: false } },
			{ expanded: false },
			theme,
			createRenderContext(),
		) as any;

		// Should not crash, session attached, ownership transferred
		assert.equal(state.childSessions.has("tool-call-1"), false);
		assert.equal(warnings.length, 1);
		assert.match(String(warnings[0][0]), /Failed to subscribe/);

		// Should still render from session messages despite subscribe failure
		const lines = component.render(120);
		assert.ok(lines.some((l: string) => l.includes("hello")));
	} finally {
		console.warn = originalWarn;
	}
});

test("nested spawn rapid events collapse to last state", () => {
	const state = createState();
	const childSpawnTool = createChildTools(new MockPi() as any, state, "medium", 0).find(t => t.name === "spawn")!;
	const { session, emit } = createSubscribableSession([]);
	state.childSessions.set("tool-call-1", session);

	const component = childSpawnTool.renderResult(
		{ content: [], details: { depth: 1, model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext(),
	) as any;

	// Start a tool execution
	emit({ type: "tool_execution_start", toolCallId: "tc-1", toolName: "bash", args: { command: "ls" } });

	// Rapid burst of updates without rendering between them
	emit({ type: "tool_execution_update", toolCallId: "tc-1", partialResult: { content: [{ type: "text", text: "file1" }] } });
	emit({ type: "tool_execution_update", toolCallId: "tc-1", partialResult: { content: [{ type: "text", text: "file2" }] } });
	emit({ type: "tool_execution_update", toolCallId: "tc-1", partialResult: { content: [{ type: "text", text: "file3" }] } });

	// Single render should reflect last state
	const lines = component.render(120);
	assert.ok(lines.some((l: string) => l.includes("file3")));

	// End the tool and verify final state
	emit({ type: "tool_execution_end", toolCallId: "tc-1", result: { content: [{ type: "text", text: "done" }] }, isError: false });

	const finalLines = component.render(120);
	assert.ok(finalLines.some((l: string) => l.includes("✓")));
});

test("nested spawn isDetachedFromLiveState drops events when session is replaced", () => {
	const state = createState();
	const childSpawnTool = createChildTools(new MockPi() as any, state, "medium", 0).find(t => t.name === "spawn")!;
	const { session, emit } = createSubscribableSession([]);
	state.childSessions.set("tool-call-1", session);
	state.liveChildSessions.set("tool-call-1", session);

	const component = childSpawnTool.renderResult(
		{ content: [{ type: "text", text: "initial" }], details: { depth: 1, model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext(),
	) as any;

	// Replace the session in liveChildSessions with a different object
	const replacementSession = createSubscribableSession([]).session;
	state.liveChildSessions.set("tool-call-1", replacementSession);

	// Emit a message_start event — should be silently dropped
	emit({ type: "message_start", message: { role: "assistant", content: [] } });

	const lines = component.render(120);
	// Should NOT contain "thinking" because the event was dropped
	assert.ok(lines.every((l: string) => !l.includes("thinking")), `expected no thinking after detach, got: ${lines.join("\n")}`);
});

test("concurrent spawn executions produce independent results", async () => {
	const pi = new MockPi();
	const state = createState();

	let resolveA!: () => void;
	let resolveB!: () => void;
	let markStartedA!: () => void;
	let markStartedB!: () => void;
	const gateA = new Promise<void>((resolve) => { resolveA = resolve; });
	const gateB = new Promise<void>((resolve) => { resolveB = resolve; });
	const startedA = new Promise<void>((resolve) => { markStartedA = resolve; });
	const startedB = new Promise<void>((resolve) => { markStartedB = resolve; });
	const started: string[] = [];
	const outputs = new Map([
		["task A", "result-alpha"],
		["task B", "result-beta"],
	]);
	const sharedFactory = async () => {
		const session = {
			messages: [] as any[],
			prompt: async (prompt: string) => {
				const task = /## Task\n\n([\s\S]*?)\n\nWhen complete/.exec(prompt)?.[1] ?? "";
				started.push(task);
				if (task === "task A") {
					markStartedA();
					await gateA;
				}
				if (task === "task B") {
					markStartedB();
					await gateB;
				}
				session.messages = [{ role: "assistant", content: [{ type: "text", text: outputs.get(task) ?? task }] }];
			},
			abort: async () => {},
			getSessionStats: () => undefined,
		};
		return { session: session as any };
	};

	registerSpawnTool(pi as any, state, sharedFactory as any);
	const spawnTool = pi.tools.get("spawn");

	const resultP1 = spawnTool.execute(
		"spawn-A", { prompt: "task A" }, undefined, undefined,
		{ model: { id: "mock" }, cwd: "/tmp" },
	);
	const resultP2 = spawnTool.execute(
		"spawn-B", { prompt: "task B" }, undefined, undefined,
		{ model: { id: "mock" }, cwd: "/tmp" },
	);

	await Promise.all([startedA, startedB]);
	assert.deepEqual(started.sort(), ["task A", "task B"]);
	resolveA();
	resolveB();

	const [r1, r2] = await Promise.all([resultP1, resultP2]);

	assert.equal(r1.content[0].text, "result-alpha");
	assert.equal(r2.content[0].text, "result-beta");
	assert.equal(state.childSessions.has("spawn-A"), false);
	assert.equal(state.childSessions.has("spawn-B"), false);
});

test("nested spawn render cache preserves stable output for identical params", () => {
	const state = createState();
	const childSpawnTool = createChildTools(new MockPi() as any, state, "medium", 0).find(t => t.name === "spawn")!;
	const { session } = createSubscribableSession([]);
	state.childSessions.set("tool-call-1", session);

	const component = childSpawnTool.renderResult(
		{ content: [{ type: "text", text: "hello" }], details: { depth: 1, model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext(),
	) as any;

	const first = component.render(120);
	const second = component.render(120);
	assert.deepEqual(second, first);

	const wide = component.render(200);
	assert.ok(Array.isArray(wide));
	assert.ok(wide.some((l: string) => l.includes("hello") || l.includes("m • low")));
});

test("ledger tool definitions include prompt hints when withPromptHints is true", () => {
	const pi = new MockPi();
	const state = createState();
	const tools = createLedgerToolDefinitions(pi as any, state, { withPromptHints: true });

	for (const tool of tools) {
		assert.ok(typeof tool.promptSnippet === "string", `${tool.name} should have promptSnippet when withPromptHints=true`);
	}
	const ledgerAdd = tools.find(t => t.name === "ledger_add")!;
	assert.ok(Array.isArray(ledgerAdd.promptGuidelines), "ledger_add should have promptGuidelines array");
	assert.ok(ledgerAdd.promptGuidelines!.length > 0, "ledger_add promptGuidelines should not be empty");
});

test("ledger tool definitions omit prompt hints by default", () => {
	const pi = new MockPi();
	const state = createState();
	const tools = createLedgerToolDefinitions(pi as any, state);

	for (const tool of tools) {
		assert.equal(tool.promptSnippet, undefined, `${tool.name} should not have promptSnippet by default`);
	}
	const ledgerAdd = tools.find(t => t.name === "ledger_add")!;
	assert.equal(ledgerAdd.promptGuidelines, undefined, "ledger_add should not have promptGuidelines by default");
});

test("executeSpawn detects stale session before session creation", async () => {
	const pi = new MockPi();
	pi.setActiveTools(["read", "bash", "spawn"]);
	const state = createState();

	let resolveFactory!: (value: any) => void;
	const factoryReady = new Promise<any>((resolve) => {
		resolveFactory = resolve;
	});
	let factoryCalled = false;
	let abortCalls = 0;

	const executePromise = executeSpawn(
		"spawn-1",
		pi as any,
		{ model: { id: "mock-model" }, cwd: "/tmp" } as any,
		state,
		{ prompt: "Do the task" },
		undefined,
		undefined,
		"medium",
		0,
		async () => {
			factoryCalled = true;
			await factoryReady;
			return {
				session: {
					messages: [] as any[],
					prompt: async () => {},
					abort: async () => { abortCalls++; },
					getSessionStats: () => undefined,
				} as any,
			};
		},
	);

	// Reset state while executeSpawn is awaiting the factory
	resetState(state);
	// Now allow the factory to resolve — session should be immediately stale
	resolveFactory({});

	await assert.rejects(
		() => executePromise,
		/invalidated by reset/i,
	);
	assert.equal(factoryCalled, true);
	assert.equal(abortCalls, 1);
	assert.equal(state.childSessions.size, 0);
	assert.equal(state.liveChildSessions.size, 0);
});

test("executeSpawn aborts stale child when resetState fires during prompt", async () => {
	const pi = new MockPi();
	pi.setActiveTools(["read", "bash", "spawn"]);
	const state = createState();

	let rejectPrompt!: (err: Error) => void;
	let resolvePromptStarted!: () => void;
	const promptStartedPromise = new Promise<void>((r) => { resolvePromptStarted = r; });
	let abortCalls = 0;

	const executePromise = executeSpawn(
		"spawn-1",
		pi as any,
		{ model: { id: "mock-model" }, cwd: "/tmp" } as any,
		state,
		{ prompt: "Do the task" },
		undefined,
		undefined,
		"medium",
		0,
		async () => ({
			session: {
				messages: [] as any[],
				prompt: async () => {
					resolvePromptStarted();
					await new Promise<void>((_resolve, reject) => {
						rejectPrompt = reject;
					});
				},
				abort: async () => {
					abortCalls++;
					rejectPrompt?.(new Error("aborted"));
				},
				getSessionStats: () => undefined,
			} as any,
		}),
	);

	// Wait for session to be created and prompt to start
	await promptStartedPromise;
	// Reset state triggers abortAndClearChildSessions which calls session.abort()
	// abort() rejects the pending prompt, which causes the stale check to fire
	resetState(state);

	await assert.rejects(
		() => executePromise,
		/invalidated by reset/i,
	);
	// abort is called once by clearChildSession (identity match via liveChildSessions)
	assert.equal(abortCalls >= 1, true);
	assert.equal(state.childSessions.size, 0);
	assert.equal(state.liveChildSessions.size, 0);
});

test("handleEvent gracefully degrades with null message events", () => {
	const state = createState();
	const childSpawnTool = createChildTools(new MockPi() as any, state, "medium", 0).find(t => t.name === "spawn")!;
	const { session, emit } = createSubscribableSession([]);
	state.childSessions.set("tool-call-1", session);

	const component = childSpawnTool.renderResult(
		{ content: [], details: { depth: 1, model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext(),
	) as any;

	// asToolResult is exercised indirectly through tool_execution_update
	// with null partialResult — the runtime guard should handle it without crashing
	emit({ type: "tool_execution_start", toolCallId: "tc-1", toolName: "bash", args: { command: "ls" } });
	emit({ type: "tool_execution_update", toolCallId: "tc-1", partialResult: null });
	emit({ type: "tool_execution_end", toolCallId: "tc-1", result: null, isError: false });

	// No crash = asToolResult guard works
	const lines = component.render(120);
	assert.ok(Array.isArray(lines));
});

test("truncateText respects line limit before byte limit", async () => {
	const pi = new MockPi();
	pi.setActiveTools(["read", "bash", "spawn"]);
	const state = createState();

	// Generate text with > 2000 lines to trigger line truncation
	const text = Array.from({ length: 2500 }, (_, i) => `Line ${i}`).join("\n");
	const mockFactory = async () => {
		const session = {
			messages: [] as any[],
			prompt: async () => {
				session.messages = [{ role: "assistant", content: [{ type: "text", text }] }];
			},
			abort: async () => {},
			getSessionStats: () => undefined,
		};
		return { session: session as any };
	};

	registerSpawnTool(pi as any, state, mockFactory as any);

	const result = await pi.tools.get("spawn").execute(
		"spawn-1",
		{ prompt: "Generate lots of lines" },
		undefined,
		undefined,
		{ model: { id: "mock-model" }, cwd: "/tmp" },
	);

	assert.equal(result.details.truncated, true);
	const textLines = result.content[0].text.split("\n");
	assert.ok(textLines[0].startsWith("Line 0"), `expected first line, got: ${textLines[0]}`);
	assert.ok(result.content[0].text.includes("[Result truncated"));
});

test("nested spawn setExpanded and setShowImages no-op when value matches", () => {
	const state = createState();
	const childSpawnTool = createChildTools(new MockPi() as any, state, "medium", 0).find(t => t.name === "spawn")!;
	const session = createSession([
		{ role: "assistant", content: [{ type: "text", text: "hello" }] },
	]);
	state.childSessions.set("tool-call-1", session);

	const component = childSpawnTool.renderResult(
		{ content: [], details: { depth: 1, model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext(),
	) as any;

	// Calling setExpanded with same value should not throw or crash
	component.setExpanded(false);
	component.setExpanded(true);
	component.setShowImages(true);
	component.setShowImages(false);

	// Component still renders
	const lines = component.render(120);
	assert.ok(lines.some((l: string) => l.includes("hello")));
});

test("abortAndClearChildSessions deduplicates sessions across both maps", () => {
	const state = createState();
	let abortCalls = 0;
	const mockSession = {
		messages: [],
		abort: async () => { abortCalls++; },
	} as any;

	// Put the same session object in both maps under the same key
	state.childSessions.set("tc-1", mockSession);
	state.liveChildSessions.set("tc-1", mockSession);

	resetState(state);

	// Dedup via the `seen` map ensures abort is called exactly once
	assert.equal(abortCalls, 1);
	assert.equal(state.childSessions.size, 0);
	assert.equal(state.liveChildSessions.size, 0);
});

test("renderSpawnResult handles result with no details field", () => {
	const state = createState();
	const result = renderSpawnResult(
		{ content: [{ type: "text", text: "hello" }] },
		false,
		theme,
		{ toolCallId: "tc-1", invalidate: () => {}, showImages: false },
		state,
	);
	// Should return a Text component that renders without crashing
	assert.ok(result, "renderSpawnResult should return a component");
	const lines = (result as any).render(120);
	assert.ok(Array.isArray(lines), "render should return an array of lines");
	assert.ok(lines.some((l: string) => l.includes("hello")), `expected 'hello' in output, got: ${lines.join("\n")}`);
});

test("registerSpawnTool registers a tool with correct name and metadata", () => {
	const pi = new MockPi();
	const state = createState();
	registerSpawnTool(pi as any, state);

	const tool = pi.tools.get("spawn");
	assert.ok(tool, "spawn tool should be registered");
	assert.equal(tool.name, "spawn");
	assert.equal(tool.label, "Spawn");
	assert.equal(typeof tool.description, "string");
	assert.equal(typeof tool.execute, "function");
	assert.equal(typeof tool.renderCall, "function");
	assert.equal(typeof tool.renderResult, "function");
	// parameters are a TypeBox schema object — just verify it exists
	assert.ok(tool.parameters, "should have parameters");
	assert.equal(tool.executionMode, undefined, "spawn should not be sequential");
});
