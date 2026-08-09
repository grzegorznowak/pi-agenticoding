import assert from "node:assert/strict";
import test from "node:test";
import { createState, abortChildSession } from "../../state.js";

function createMockSession(abortImpl: () => Promise<void> | void) {
	return { abort: abortImpl } as any;
}

test("abortChildSession returns the same promise for the same session", async () => {
	const state = createState();
	const session = createMockSession(async () => {});
	
	const promise1 = abortChildSession(state, session);
	const promise2 = abortChildSession(state, session);
	
	assert.strictEqual(promise1, promise2, "same session returns same promise");
	
	await promise1;
	await promise2;
});

test("abortChildSession handles synchronous abort() throw", async () => {
	const state = createState();
	const syncError = new Error("sync abort failure");
	const session = createMockSession(() => { throw syncError; });
	
	const promise = abortChildSession(state, session);
	
	await assert.rejects(promise, (error: unknown) => {
		assert.equal(error, syncError);
		return true;
	});
});

test("abortChildSession returns different promises for different sessions", async () => {
	const state = createState();
	const session1 = createMockSession(async () => {});
	const session2 = createMockSession(async () => {});
	
	const promise1 = abortChildSession(state, session1);
	const promise2 = abortChildSession(state, session2);
	
	assert.notStrictEqual(promise1, promise2, "different sessions return different promises");
	
	await promise1;
	await promise2;
});

test("abortChildSession promise resolves when abort completes", async () => {
	const state = createState();
	let abortCalled = false;
	const session = createMockSession(async () => { abortCalled = true; });
	
	const promise = abortChildSession(state, session);
	await promise;
	
	assert.equal(abortCalled, true, "abort was called");
});

test("abortChildSession promise rejects when abort rejects", async () => {
	const state = createState();
	const abortError = new Error("abort rejected");
	const session = createMockSession(async () => { throw abortError; });
	
	const promise = abortChildSession(state, session);
	
	await assert.rejects(promise, (error: unknown) => {
		assert.equal(error, abortError);
		return true;
	});
});
