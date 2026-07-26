/**
 * Module evaluation order regression guard.
 *
 * Each assertion runs in a fresh Node process: the test runner itself imports
 * the extension graph, so in-process imports cannot prove loader order.
 */

import { spawnSync } from "node:child_process";
import { strict as assert } from "node:assert";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));
const loader = fileURLToPath(new URL("../../register-loader.mjs", import.meta.url));

function evaluate(code: string): void {
	const result = spawnSync(process.execPath, ["--import", loader, "--input-type=module", "--eval", code], {
		cwd: root,
		encoding: "utf8",
	});
	assert.equal(result.status, 0, [result.stdout, result.stderr].filter(Boolean).join("\n"));
}

describe("module evaluation order", () => {
	it("loads handoff before spawn in a fresh extension process", () => {
		evaluate(`
			await import('./handoff/tool.ts');
			await import('./spawn/index.ts');
			const sdk = await import('@earendil-works/pi-coding-agent');
			if (typeof sdk.createAgentSession !== 'function') throw new Error('createAgentSession missing');
			if (typeof sdk.SessionManager?.inMemory !== 'function') throw new Error('SessionManager.inMemory missing');
			if (typeof sdk.SettingsManager !== 'function') throw new Error('SettingsManager missing');
			if (typeof sdk.ModelRuntime?.create !== 'function') throw new Error('ModelRuntime.create missing');
		`);
	});
});
