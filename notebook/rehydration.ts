/**
 * Notebook rehydration for the agenticoding extension.
 *
 * A session_start handler that scans the current branch newest-to-oldest for
 * persisted notebook-entry (and legacy ledger-entry) custom entries, rebuilds
 * the in-memory state.notebookPages Map (newest wins per name), and ensures
 * notebook_read / notebook_index are active.
 */

import type { CustomEntry, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgenticodingState } from "../state.js";

// ── Types ─────────────────────────────────────────────────────────────

interface NotebookEntryData {
	version: number;
	epoch: number;
	name: string;
	content: string;
}

interface NotebookGenerationData {
	version: number;
	epoch: number;
}

interface NotebookCandidate {
	epoch: number;
	content: string;
}

// ── Rehydration entry types ───────────────────────────────────────────

const PAGE_ENTRY_TYPES = new Set(["notebook-entry", "ledger-entry"]);
const GENERATION_ENTRY_TYPE = "notebook-generation";

function isNotebookEpoch(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

// ── Registration ──────────────────────────────────────────────────────

export function registerNotebookRehydration(
	pi: ExtensionAPI,
	state: AgenticodingState,
): void {
	pi.on("session_start", async (_event, ctx) => {
		const branch = ctx.sessionManager.getBranch();

		// A generation is visible only after its marker is appended. Staged
		// survivor entries from an interrupted discard therefore cannot eclipse
		// the last durable notebook generation.
		let committedEpoch: number | null = null;
		let legacyEpoch = 0;
		for (const entry of branch) {
			if (entry?.type !== "custom") continue;
			const customEntry = entry as CustomEntry;
			if (customEntry.customType === GENERATION_ENTRY_TYPE) {
				const data = customEntry.data as NotebookGenerationData;
				if (isNotebookEpoch(data?.epoch)) committedEpoch = Math.max(committedEpoch ?? 0, data.epoch);
				continue;
			}
			if (!PAGE_ENTRY_TYPES.has(customEntry.customType)) continue;
			const data = customEntry.data as NotebookEntryData;
			if (data?.name && typeof data.content === "string") {
				legacyEpoch = Math.max(legacyEpoch, isNotebookEpoch(data.epoch) ? data.epoch : 0);
			}
		}
		const currentEpoch = committedEpoch ?? legacyEpoch;
		state.epoch = currentEpoch;

		// Scan newest-to-oldest, retaining only the committed generation. This
		// order intentionally ignores newer staged entries for the same page.
		const candidates = new Map<string, NotebookCandidate>();
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];
			if (entry?.type !== "custom") continue;
			const customEntry = entry as CustomEntry;
			if (!PAGE_ENTRY_TYPES.has(customEntry.customType)) continue;
			const data = customEntry.data as NotebookEntryData;
			const epoch = isNotebookEpoch(data?.epoch) ? data.epoch : 0;
			if (!data?.name || typeof data.content !== "string" || epoch !== currentEpoch || candidates.has(data.name)) continue;
			candidates.set(data.name, { epoch, content: data.content });
		}

		state.notebookPages.clear();
		for (const [name, candidate] of candidates) state.notebookPages.set(name, candidate.content);

		// Ensure notebook_read and notebook_index are active so the LLM can fetch pages
		const active = pi.getActiveTools();
		let changed = false;
		if (!active.includes("notebook_read")) {
			active.push("notebook_read");
			changed = true;
		}
		if (!active.includes("notebook_index")) {
			active.push("notebook_index");
			changed = true;
		}
		if (changed) pi.setActiveTools(active);
	});
}
