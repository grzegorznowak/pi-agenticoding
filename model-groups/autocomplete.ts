import type { ExtensionContext, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { AgenticodingState } from "../state.js";
import { getEffectiveModelGroups } from "./router.js";
import { MODALITY_FG, modalityLetterRun } from "./modality.js";
import type { ModelGroupModel, ResolvedModelGroup } from "./types.js";

const registeredUis = new WeakSet<object>();

function isUnavailable(group: ResolvedModelGroup, entry: ModelGroupModel): boolean {
	return group.validation.unavailableRefs.some((ref) => ref.provider === entry.provider && ref.modelId === entry.modelId);
}

function formatModelGroupRouteDetails(group: ResolvedModelGroup): string {
	if (group.models.length === 0) return "No models configured";
	return group.models
		.map((entry) => {
			const thinking = entry.thinkingLevel ?? "inherit";
			const unavailable = isUnavailable(group, entry) ? " (unavailable)" : "";
			return `${entry.provider}/${entry.modelId} • ${thinking}${unavailable}`;
		})
		.join("; ");
}

export type DescriptionColorizer = (color: ThemeColor, text: string) => string;

/**
 * Build the `#`-mention tooltip description. With a colorizer, prefix the
 * per-model route details with the group's colored effective modality letters
 * (media only; reasoning excluded), re-asserting the muted wrapper after each
 * colored span so the description stays legible on one line. Without one, the
 * plain per-model route details are returned unchanged.
 */
function formatModelGroupSuggestionDetails(group: ResolvedModelGroup, colorize?: DescriptionColorizer): string {
	const routeDetails = formatModelGroupRouteDetails(group);
	if (!colorize) return routeDetails;
	const letters = modalityLetterRun(group.modalities?.effective, {
		render: (modality, letter) => colorize(MODALITY_FG[modality], letter),
		separator: colorize("muted", " "),
	});
	if (!letters) return routeDetails;
	const sep = colorize("muted", "  ");
	return `${letters}${sep}${colorize("muted", routeDetails)}`;
}

export function createModelGroupAutocompleteProvider(state: AgenticodingState, colorize?: DescriptionColorizer) {
	return (current: any) => ({
		async getSuggestions(lines: string[], cursorLine: number, cursorCol: number, options: unknown) {
			const line = lines[cursorLine] ?? "";
			const beforeCursor = line.slice(0, cursorCol);
			const match = beforeCursor.match(/(?:^|[\t ])#([^\s#]*)$/);
			if (!match) {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}

			const partial = (match[1] ?? "").toLowerCase();
			const groups = getEffectiveModelGroups(state.modelGroups.groups);
			const items = groups
				.filter((group) => group.name.toLowerCase().startsWith(partial))
				.map((group) => ({
					value: `#${group.name}`,
					label: `#${group.name}`,
					description: formatModelGroupSuggestionDetails(group, colorize),
				}));
			return { prefix: `#${match[1] ?? ""}`, items };
		},

		applyCompletion(lines: string[], cursorLine: number, cursorCol: number, item: unknown, prefix: string) {
			return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		},

		shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number) {
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
		},
	});
}

export function registerModelGroupAutocomplete(ctx: ExtensionContext, state: AgenticodingState): void {
	if (!ctx.hasUI) return;
	const ui = ctx.ui as unknown as {
		addAutocompleteProvider?: (factory: ReturnType<typeof createModelGroupAutocompleteProvider>) => void;
		theme?: { fg: (color: ThemeColor, text: string) => string };
	};
	if (typeof ui.addAutocompleteProvider !== "function") return;
	const key = ui as object;
	if (registeredUis.has(key)) return;
	registeredUis.add(key);
	// Lazy adapter so the colorizer reflects the live theme (not a snapshot).
	const colorize: DescriptionColorizer | undefined = ui.theme
		? (color, text) => ui.theme!.fg(color, text)
		: undefined;
	ui.addAutocompleteProvider(createModelGroupAutocompleteProvider(state, colorize));
}
