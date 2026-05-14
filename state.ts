/**
 * Shared mutable state for the agenticoding extension.
 *
 * Single source of truth that all modules read/write through.
 * Mutable by design — this is session-scoped imperative state.
 */

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
}

/** Create a fresh state instance. Call reset() on /new. */
export function createState(): AgenticodingState {
	return {
		ledger: new Map(),
		epoch: 0,
		lastContextPercent: null,
		pendingHandoff: null,
		pendingRequestedHandoff: null,
	};
}

/** Reset all state. Used on /new or session reset. */
export function resetState(state: AgenticodingState): void {
	state.ledger.clear();
	state.epoch = 0;
	state.lastContextPercent = null;
	state.pendingHandoff = null;
	state.pendingRequestedHandoff = null;
}
