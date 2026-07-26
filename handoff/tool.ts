/**
 * Handoff tool for the agenticoding extension.
 *
 * Tools can trigger compaction directly, so handoff is implemented as a
 * deliberate compaction that replaces noisy context with a clean restart prompt.
 *
 * The prompt should complete the picture: preserve the important situational
 * context that is still only present in the current turn, while notebook pages
 * remain durable grounding fetched on demand in the next context.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { clearActiveNotebookTopic } from "../notebook/topic.js";
import {
	HANDOFF_IN_PROGRESS_STATUS,
	HANDOFF_REQUESTED_STATUS,
	HANDOFF_REQUIRED_STATUS,
} from "./copy.js";
import { buildEnrichedTask } from "./format.js";
import {
	MIN_HANDOFF_TOKENS,
	estimateHandoffContextTokens,
	formatHandoffContextUsage,
	isHandoffEligible,
	normalizeContextPercent,
} from "./eligibility.js";
import type { AgenticodingState } from "../state.js";
import { STATUS_KEY_HANDOFF } from "../tui.js";

function validateHandoffTask(task: string, ctx: ExtensionContext): void {
	const trimmed = task.trim();
	if (!trimmed) {
		const pct = normalizeContextPercent(ctx.getContextUsage()?.percent);
		throw new Error(
			`Context at ${pct === null ? "?" : Math.round(pct) + "%"}. Empty handoff rejected. Save findings to notebook, then draft a substantive prompt.`,
		);
	}

	const usage = ctx.getContextUsage();
	const approximateTokens = estimateHandoffContextTokens(usage);
	if (approximateTokens === null) {
		throw new Error(
			"Context usage unavailable; handoff rejected. Continue working and retry.",
		);
	}
	if (approximateTokens < MIN_HANDOFF_TOKENS) {
		const tokenLabel = formatHandoffContextUsage(usage);
		const percent = normalizeContextPercent(usage?.percent);
		const pctLabel = percent === null ? "?" : `~${Math.round(percent)}%`;
		throw new Error(
			`Context at ${pctLabel} (${tokenLabel}); handoff unavailable yet. Continue working and retry.`,
		);
	}
}

function completeHandoff(
	pi: ExtensionAPI,
	state: AgenticodingState,
	ctx: ExtensionContext,
	discardWarning?: string,
): void {
	// Finalize the two-phase clear: pendingHandoff was already cleared by compact.ts;
	// this is the sole path that clears pendingRequestedHandoff after successful compaction.
	state.pendingHandoff = null;
	clearActiveNotebookTopic(state);
	state.pendingRequestedHandoff = null;
	if (ctx.hasUI) {
		ctx.ui.setStatus(STATUS_KEY_HANDOFF, undefined);
		ctx.ui.notify(
			discardWarning ?? "Handoff complete. Fresh context will resume with the queued prompt.",
			discardWarning ? "warning" : "info",
		);
	}
	pi.sendUserMessage(discardWarning ? `Proceed. ${discardWarning}` : "Proceed.");
}

function notifyHandoffFailure(ctx: ExtensionContext, error: Error, pendingRequest: AgenticodingState["pendingRequestedHandoff"]): void {
	if (!ctx.hasUI) return;
	if (pendingRequest && ctx.ui.theme) {
		const status = isHandoffEligible(ctx.getContextUsage())
			? HANDOFF_REQUIRED_STATUS
			: HANDOFF_REQUESTED_STATUS;
		ctx.ui.setStatus(STATUS_KEY_HANDOFF, ctx.ui.theme.fg("accent", status));
	} else {
		ctx.ui.setStatus(STATUS_KEY_HANDOFF, undefined);
	}
	ctx.ui.notify(`Handoff compaction failed: ${error.message}. The handoff can be retried.`, "error");
}

function sendHandoffFailure(pi: ExtensionAPI, error: Error, pendingRequest: AgenticodingState["pendingRequestedHandoff"]): void {
	const nextStep = pendingRequest
		? "The required handoff remains pending; retry when context usage is eligible. "
		: "No required handoff remains pending; retry when ready. ";
	pi.sendUserMessage(`Handoff failed — ${error.message}. ${nextStep.trim()}`);
}

function failHandoff(
	pi: ExtensionAPI,
	state: AgenticodingState,
	ctx: ExtensionContext,
	rawError: unknown,
): void {
	const error = rawError instanceof Error ? rawError : new Error(String(rawError));
	state.pendingHandoff = null;
	state.pendingNotebookDiscard = null;
	// An interrupted discard left staged survivors + a stray generation marker in
	// the branch; rehydration ignores them, so the orphaned entries are harmless.
	const pendingRequest = state.pendingRequestedHandoff;
	if (pendingRequest) pendingRequest.toolCalled = false;
	notifyHandoffFailure(ctx, error, pendingRequest);
	sendHandoffFailure(pi, error, pendingRequest);
}

function createHandoffCallbacks(
	pi: ExtensionAPI,
	state: AgenticodingState,
	ctx: ExtensionContext,
	generation: number,
	commitDiscard: (() => void) | undefined,
): { onComplete: () => void; onError: (error: unknown) => void } {
	let settled = false;
	const clearInFlight = () => {
		// Pair generation with handoffCompactionGeneration: only clear this
		// reservation if it is still the active one. A newer handoff will have
		// bumped handoffGeneration and set its own reservation.
		if (state.handoffCompactionGeneration !== generation) return;
		state.handoffCompactionGeneration = null;
		if (state.pendingHandoff?.generation === generation) state.pendingHandoff = null;
	};
	const isCurrent = () => state.handoffGeneration === generation;
	return {
		onComplete: () => {
			if (settled) return;
			settled = true;
			if (!isCurrent()) return;
			try {
				// Pi does not await compact callbacks. The next epoch becomes visible
				// only after compaction has succeeded.
				commitDiscard?.();
				clearInFlight();
				if (isCurrent()) completeHandoff(pi, state, ctx);
			} catch (error) {
				clearInFlight();
				if (!isCurrent()) return;
				// Compaction already succeeded. Retain the current generation rather
				// than describing this as a failed handoff when its final marker cannot
				// be persisted.
				state.pendingNotebookDiscard = null;
				const message = error instanceof Error ? error.message : String(error);
				completeHandoff(
					pi,
					state,
					ctx,
					`Handoff completed, but notebook discard was not persisted (${message}); retained all notebook pages.`,
				);
			}
		},
		onError: (error) => {
			if (settled) return;
			settled = true;
			clearInFlight();
			if (isCurrent()) failHandoff(pi, state, ctx, error);
		},
	};
}

export function registerHandoffTool(
	pi: ExtensionAPI,
	state: AgenticodingState,
): void {
	pi.registerTool({
		name: "handoff",
		label: "Handoff",
		description:
			"Clears the current context while keeping the notebook and clearing its topic.\n\n" +
			"WHEN TO USE:\n" +
			"  1. Context past ~30% and the current job is no longer cleanly represented.\n" +
			"  2. Context is filled with mechanics irrelevant to what comes " +
			"next (research traces, planning deliberation, dead ends).\n" +
			"  3. The current job is complete and a new distinct task starts.\n\n" +
			"Rule: one context, one job. When the job changes, call handoff.\n\n" +
			"AFTER HANDOFF the agent sees: the handoff prompt and the current notebook with optional pages discarded\n",
		promptSnippet: "Pivot to a new job via deliberate handoff compaction",
		promptGuidelines: [
			"Before handoff, promote any missing knowledge that the next context will need to the notebook. " +
				"Then draft a concise but sufficiently detailed prompt for the next clean context. The active notebook topic will reset after handoff, so the next context should assign a fresh topic from the prompt or user direction.",
			"Use discardPages to remove notebook pages that are stale or no longer relevant to the next context. " +
				"This keeps the notebook fresh and prevents outdated information from persisting.",
		],

		executionMode: "sequential",

		parameters: Type.Object({
			task: Type.String({
				description:
					"What to do next. A concise but sufficiently detailed handoff prompt.\n" +
					"This becomes the FIRST thing the agent sees after handoff. Capture anything the next context " +
					"will need that's not included in the notebook.\n" +
					"The notebook is the long-term knowledge store; this prompt should carry only the remaining situational information.",
			}),
			discardPages: Type.Optional(Type.Array(Type.String({
				description: "A notebook page name to discard.",
			}), {
				description:
					"Notebook page names to permanently remove during this handoff. " +
					"Use to prune stale pages that are no longer relevant to the next context.",
			})),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (state.handoffCompactionGeneration !== null) {
				throw new Error("Handoff compaction already in progress; retry after it completes.");
			}
			// validateHandoffTask throws with a user-facing reason. Before the throw
			// reaches Pi (which will render a generic tool-error), send the richer
			// sendHandoffFailure message so the LLM gets actionable guidance. The
			// throw after this ensures Pi's tool-call lifecycle sees the rejection.
			try {
				validateHandoffTask(params.task, ctx);
			} catch (error) {
				sendHandoffFailure(pi, error instanceof Error ? error : new Error(String(error)), state.pendingRequestedHandoff);
				throw error;
			}
			const discardPages = [...new Set(params.discardPages ?? [])];
			const requestedHandoff = state.pendingRequestedHandoff;
			const generation = ++state.handoffGeneration;
			state.pendingHandoff = { task: params.task, source: "tool", generation };
			state.handoffCompactionGeneration = generation;
			if (requestedHandoff) requestedHandoff.toolCalled = true;

			let commitDiscard: (() => void) | undefined;
			try {
				if (discardPages.length) {
					const store = await import("../notebook/store.js");
					await store.prepareNotebookDiscard(pi, state, generation, discardPages);
					commitDiscard = () => store.commitNotebookDiscard(pi, state, generation);
				}
				if (ctx.hasUI && ctx.ui.theme) {
					ctx.ui.setStatus(STATUS_KEY_HANDOFF, ctx.ui.theme.fg("accent", HANDOFF_IN_PROGRESS_STATUS));
				}
				const callbacks = createHandoffCallbacks(pi, state, ctx, generation, commitDiscard);
				ctx.compact(callbacks);
			} catch (error) {
				const callbacks = createHandoffCallbacks(pi, state, ctx, generation, undefined);
				callbacks.onError(error);
				throw error;
			}

			return {
				content: [{ type: "text", text: "Handoff started." }],
				details: {},
				terminate: true,
			};
		},

	});
}
