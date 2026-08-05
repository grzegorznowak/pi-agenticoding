/** Build the task text used as the handoff compaction summary. */

import {
	READONLY_BYPASS_CLEARED,
	READONLY_NEXT_CONTEXT_RESUMES,
	READONLY_NON_TEMP_MUTATION_SCOPE,
} from "../notifications.js";

/**
 * Build the enriched task that becomes the compaction summary.
 *
 * Shape: handoff prompt + original task.
 */
export function buildEnrichedTask(task: string, options?: { resumeReadonlyAfterHandoff?: boolean }): string {
	const parts: string[] = [
		"## Handoff — Continue Previous Work",
		"",
		"You are continuing a previous agent's work in a clean context. Use the available knowledge correctly:",
		"- Notebook pages are a cache for this stream: code facts are re-derivable, while user guidance, decisions, and design live in pages — fetch them with `notebook_read`",
		"- This handoff prompt holds the distilled next task and immediate situational context",
		"- Use `notebook_index` to scan available pages when needed",
		"- Use `spawn` to delegate isolated subtasks to child agents",
		"- Build on notebook memory and this prompt rather than reconstructing old context",
	];

	if (options?.resumeReadonlyAfterHandoff) {
		parts.push(
			"",
			"## Execution Constraints",
			"",
			`- ${READONLY_NEXT_CONTEXT_RESUMES}`,
			`- ${READONLY_BYPASS_CLEARED}`,
			`- ${READONLY_NON_TEMP_MUTATION_SCOPE} unless the user changes readonly mode.`,
		);
	}

	parts.push("", "## Task", "", task);
	return parts.join("\n");
}
