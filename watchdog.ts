/**
 * Watchdog: advisory primacy-zone reminder.
 *
 * Exposes nudge text generation and records the latest context usage at
 * `agent_end` for UI/state purposes. Actual reminder injection happens in the
 * `context` hook so it can appear before every LLM call in the same agent run.
 *
 * Never force-disengages — the watchdog is advisory only.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgenticodingState } from "./state.js";

/** Build a nudge string with the exact percent interpolated. */
export function buildNudge(percent: number): string {
	const pct = Math.round(percent);

	if (pct >= 70) {
		return `Context at ${pct}% — deep in the degraded zone. Compaction may trigger soon
(emergency summarization at ~90%). Prefer a deliberate handoff now: save
reusable state to the ledger, draft a clear next-task brief, and call handoff.`;
	}

	if (pct >= 50) {
		return `Context at ${pct}% — well past the primacy-zone heuristic. If the current job is
done or the context is noisy, consider a handoff soon. Save reusable state to
the ledger and draft a concise but sufficiently detailed brief for what comes
next.`;
	}

	// 30-50%
	return `Context at ${pct}% — past the primacy-zone heuristic. One context, one job.
If you're mid-job and still clear, continue. If the current phase is complete
or the context is noisy, consider a handoff and draft a clear brief for what
comes next.`;
}

/**
 * Register the watchdog's `agent_end` handler.
 *
 * Must be called from the extension factory in index.ts after state creation.
 */
export function registerWatchdog(pi: ExtensionAPI, state: AgenticodingState): void {
	pi.on("agent_end", async (_event: unknown, ctx: ExtensionContext) => {
		const requestedHandoff = state.pendingRequestedHandoff;
		if (requestedHandoff) {
			requestedHandoff.enforcementAttempts += 1;
			if (!requestedHandoff.toolCalled) {
				state.pendingRequestedHandoff = null;
			}
		}

		// ── Primacy-zone nudge ──────────────────────────────────────
		const usage = ctx.getContextUsage();

		// Null usage / null percent — right after compaction, before next LLM response.
		if (!usage || usage.percent === null) {
			state.lastContextPercent = null;
			return;
		}

		state.lastContextPercent = usage.percent;

	});
}
