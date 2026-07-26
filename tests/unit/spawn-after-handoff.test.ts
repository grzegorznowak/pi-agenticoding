/**
 * End-to-end test: spawn tool works correctly after handoff tool has been
 * loaded and initialized. This validates that the lazy import fix in handoff
 * doesn't prevent subsequent spawn operations.
 *
 * The root cause: handoff/tool.ts had a top-level static import from
 * notebook/store.ts, which altered pi's module evaluation ordering and
 * caused SDK classes to be undefined when createAgentSession ran.
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
	createAgentSession,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { createState } from "../../state.js";

describe("spawn after handoff initialization", () => {
	it("creates a child session after loading handoff tool module", async () => {
		// Step 1: Load the handoff module first (this triggered the bug)
		await import("../../handoff/tool.js");

		// Step 2: Now call createAgentSession as the spawn tool does
		const result = await createAgentSession({
			sessionManager: SessionManager.inMemory("/tmp"),
			model: {
				id: "test-model",
				provider: "test-provider",
				name: "Test Model",
				api: "test",
				baseUrl: "http://localhost",
				reasoning: false,
				input: [],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 100000,
				maxTokens: 4096,
			},
			thinkingLevel: "low",
			cwd: "/tmp",
			tools: ["read"],
		});

		assert.ok(result.session, "createAgentSession should return a session object");
		assert.ok(typeof result.session.prompt === "function", "session should have a prompt method");
		assert.ok(typeof result.session.abort === "function", "session should have an abort method");
	});

	it("spawn tool execute succeeds after handoff module initialization", async () => {
		// Step 1: Load handoff module
		await import("../../handoff/tool.js");

		// Step 2: Register spawn tool with a test context
		const { registerSpawnTool, executeSpawn } = await import("../../spawn/index.js");

		const state = createState();
		const pi = {
			getThinkingLevel: () => "low" as const,
			getActiveTools: () => ["read", "bash", "notebook_write", "notebook_read", "notebook_index"],
			getAllTools: () => [],
			registerTool: () => {},
		};

		// registerSpawnTool should not throw
		registerSpawnTool(pi as any, state);

		// executeSpawn should throw "No model configured" (no ctx.model in test),
		// not "Cannot read properties of undefined (reading 'create')"
		try {
			await executeSpawn(
				"test-call",
				pi as any,
				{ model: undefined, cwd: "/tmp" } as any,
				state as any,
				{ prompt: "test task" },
				undefined,
				undefined,
				"low",
			);
			assert.fail("Expected executeSpawn to throw about missing model");
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : String(error);
			assert.ok(
				message.includes("No model configured"),
				`Expected model-config error, got: ${message}`,
			);
			assert.ok(
				!message.includes("Cannot read properties of undefined"),
				`Should not see SDK undefined error, got: ${message}`,
			);
		}
	});
});
