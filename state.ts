/**
 * Shared mutable state for the agenticoding extension.
 *
 * Single source of truth that all modules read/write through.
 * Mutable by design — this is session-scoped imperative state.
 */

import type { AgentSession } from "@earendil-works/pi-coding-agent";

export interface AgenticodingState {
	/** Compact ledger entries keyed by kebab-case name */
	ledger: Map<string, string>;

	/** Monotonically increasing epoch, set on first ledger_add */
	epoch: number;

	/** Last context usage percent from getContextUsage() */
	lastContextPercent: number | null;

	/** Handoff task queued by the tool until the compaction hook consumes it. */
	pendingHandoff: { task: string; source: "tool" } | null;

	/** User-requested handoff that must result in a real tool-driven compaction. */
	pendingRequestedHandoff: {
		direction: string;
		enforcementAttempts: number;
		toolCalled: boolean;
	} | null;

	/**
	 * Published child agent sessions keyed by toolCallId.
	 * Lifecycle: executeSpawn publishes → renderSpawnResult claims via get+delete.
	 * This is only the render handoff queue, not the full live-session registry.
	 */
	childSessions: Map<string, AgentSession>;

	/**
	 * All live child agent sessions keyed by toolCallId, including claimed ones.
	 * Reset/teardown aborts this registry so claimed children cannot outlive /new or UI disposal.
	 *
	 * INVARIANT: This Map is never replaced — only cleared via .clear().
	 * NestedAgentSessionComponent holds a direct reference and depends on it
	 * staying valid. If you change this, update attachSession in spawn/renderer.ts.
	 */
	liveChildSessions: Map<string, AgentSession>;

	/**
	 * Generation counter for child-session ownership.
	 * Increment on /new so stale child updates/results cannot touch fresh state.
	 */
	childSessionEpoch: number;
}

/** Create a fresh state instance. Call reset() on /new. */
export function createState(): AgenticodingState {
	const childSessions = new Map<string, AgentSession>();
	const liveChildSessions = new Map<string, AgentSession>();
	const state: AgenticodingState = {
		ledger: new Map(),
		epoch: 0,
		lastContextPercent: null,
		pendingHandoff: null,
		pendingRequestedHandoff: null,
		childSessions,
		liveChildSessions,
		childSessionEpoch: 0,
	};
	// Prevent replacement — NestedAgentSessionComponent holds direct references
	// to both maps and depends on reference stability. Only .clear() and .delete()
	// are valid — assigning a new Map would silently break session lifecycle.
	Object.defineProperty(state, 'childSessions', {
		get: () => childSessions,
		set: () => { throw new Error('childSessions cannot be replaced — use .clear() instead'); },
		enumerable: true,
		configurable: false,
	});
	Object.defineProperty(state, 'liveChildSessions', {
		get: () => liveChildSessions,
		set: () => { throw new Error('liveChildSessions cannot be replaced — use .clear() instead'); },
		enumerable: true,
		configurable: false,
	});
	return state;
}

/** Reset all state. Used on /new or session reset. */
export function resetState(state: AgenticodingState): void {
	state.childSessionEpoch++;
	state.ledger.clear();
	state.epoch = 0;
	state.lastContextPercent = null;
	state.pendingHandoff = null;
	state.pendingRequestedHandoff = null;
	abortAndClearChildSessions(state);
}

/** Abort all active child sessions and clear both registries. Called on /new (session reset). */
export function abortAndClearChildSessions(state: AgenticodingState): void {
	const seen = new Map<any, string>(); // session → first id (for logging)
	for (const [id, session] of [...state.childSessions.entries(), ...state.liveChildSessions.entries()]) {
		if (!seen.has(session)) seen.set(session, id);
	}
	state.childSessions.clear();
	state.liveChildSessions.clear();
	for (const [session, id] of seen) {
		session.abort().catch(e => console.warn("[spawn] abort failed:", id, e));
	}
}
