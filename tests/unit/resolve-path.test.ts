import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { resolveRealPath } from "../../resolve-path.js";

test("resolveRealPath: non-existent path inside temp dir preserves full path", () => {
	const tmp = os.tmpdir();
	const nonExistent = `${tmp}/__pi_test_deep/a/b/c`;
	const result = resolveRealPath(nonExistent);
	// Should contain the full path including all intermediate components
	assert.ok(result.includes("__pi_test_deep/a/b/c"), "should preserve all path components");
});

test("resolveRealPath follows symlinks", () => {
	const dir = os.tmpdir();
	const target = path.join(dir, `pi-test-target-${Date.now()}`);
	const link = path.join(dir, `pi-test-link-${Date.now()}`);
	fs.mkdirSync(target);
	try {
		fs.symlinkSync(target, link);
		const resolved = resolveRealPath(link);
		// Use resolveRealPath on target too to handle macOS /var → /private/var
		assert.equal(resolved, resolveRealPath(target));
	} finally {
		fs.rmSync(link, { force: true });
		fs.rmSync(target, { force: true, recursive: true });
	}
});
