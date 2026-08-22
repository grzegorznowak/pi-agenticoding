import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { MODEL_GROUP_MODALITIES, type ModelGroupModality } from "./types.js";

/**
 * Single-letter color/letter lexicon for a group's modality capabilities.
 * Shared by the model-groups TUI list and the `#`-mention autocomplete so both
 * render the same colored letters (T=text blue, I=image green, R=reasoning purple).
 */
export const MODALITY_FG: Record<ModelGroupModality, ThemeColor> = {
	text: "syntaxKeyword",
	image: "success",
	reasoning: "thinkingHigh",
};

export const MODALITY_LETTER: Record<ModelGroupModality, string> = {
	text: "T",
	image: "I",
	reasoning: "R",
};

export interface ModalityLetterRunOptions {
	/** Include the reasoning letter. Default false, matching model list rows which surface R per-model. */
	includeReasoning?: boolean;
	/** Render one colored/letter token (e.g. a theme colorizer). Defaults to identity. */
	render?(modality: ModelGroupModality, letter: string): string;
	/** Separator between colored letters. Default " ". */
	separator?: string;
}

/**
 * Build a compact single-letter capability run for an effective modality set,
 * ordered per MODEL_GROUP_MODALITIES (text first). Reasoning is omitted unless
 * includeReasoning is set. Returns "" for an empty/absent set.
 */
export function modalityLetterRun(
	effective: readonly ModelGroupModality[] | null | undefined,
	options: ModalityLetterRunOptions = {},
): string {
	if (!effective || effective.length === 0) return "";
	const includeReasoning = options.includeReasoning ?? false;
	const render = options.render ?? ((_modality: ModelGroupModality, letter: string) => letter);
	const separator = options.separator ?? " ";
	const seen = new Set(effective);
	const letters: string[] = [];
	for (const modality of MODEL_GROUP_MODALITIES) {
		if (!seen.has(modality)) continue;
		if (!includeReasoning && modality === "reasoning") continue;
		letters.push(render(modality, MODALITY_LETTER[modality]));
	}
	if (letters.length === 0) return "";
	return letters.join(separator);
}