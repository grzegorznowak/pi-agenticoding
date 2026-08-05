/**
 * Handoff modules must not eagerly evaluate notebook/store: it changes SDK
 * evaluation order before spawn can create a child session. Use import() in
 * execution callbacks instead.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

function findStaticImports(source: string, fromPattern: RegExp): string[] {
	const results: string[] = [];
	const fromImportRe = /^\s*import\s+(?!type\s)([\s\S]*?)\s+from\s+["']([^"']+)["']\s*;?/gm;
	const sideEffectImportRe = /^\s*import\s+["']([^"']+)["']\s*;?/gm;
	let match: RegExpExecArray | null;

	while ((match = fromImportRe.exec(source)) !== null) {
		if (fromPattern.test(match[2])) results.push(`import ${match[1]} from "${match[2]}"`);
	}
	while ((match = sideEffectImportRe.exec(source)) !== null) {
		if (fromPattern.test(match[1])) results.push(`import "${match[1]}"`);
	}
	return results;
}

describe("handoff module import graph", () => {
	const handoffDir = fileURLToPath(new URL("../../handoff/", import.meta.url));
	const storePattern = /notebook\/store(\.(js|ts))?$/;

	const filenames = ["tool.ts", "format.ts", "eligibility.ts", "compact.ts", "command.ts", "copy.ts"];
	for (const filename of filenames) {
		it(`${filename} must not top-level import from notebook/store`, () => {
			const source = readFileSync(`${handoffDir}${filename}`, "utf8");
			const violations = findStaticImports(source, storePattern);
			assert.equal(
				violations.length,
				0,
				`${filename} has top-level value import(s) from notebook/store:\n` +
					violations.map((v) => `  ${v}`).join("\n") +
					"\nUse lazy dynamic import() inside the execute callback instead.",
			);
		});
	}

	it("loads notebook/store lazily only from the handoff execution path", () => {
		const source = readFileSync(`${handoffDir}tool.ts`, "utf8");
		assert.match(source, /await import\(["']\.\.\/notebook\/store\.js["']\)/);
	});
});
