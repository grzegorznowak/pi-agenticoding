import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { MODEL_GROUP_MODALITIES, type ModelGroupDef, type ModelGroupModalities, type ModelGroupModality } from "./types.js";

function ordered(values: Iterable<ModelGroupModality>): ModelGroupModality[] {
	const set = new Set(values);
	return MODEL_GROUP_MODALITIES.filter((value) => set.has(value));
}

export function getModelModalities(model: Model<Api>): ModelGroupModality[] {
	return ordered([...(Array.isArray(model.input) ? model.input as ModelGroupModality[] : []), ...(model.reasoning === true ? ["reasoning" as const] : [])]);
}

export function deriveModelGroupModalities(
	group: Pick<ModelGroupDef, "models" | "modalityOverride">,
	modelRegistry: Pick<ModelRegistry, "find">,
): ModelGroupModalities {
	const found = group.models.map((entry) => modelRegistry.find(entry.provider, entry.modelId) as Model<Api> | undefined);
	const sets = found.map((model) => new Set(model ? getModelModalities(model) : []));
	const supported = ordered(sets.flatMap((set) => [...set]));
	const common = found.length === 0 || found.some((model) => !model)
		? []
		: ordered(MODEL_GROUP_MODALITIES.filter((modality) => sets.every((set) => set.has(modality))));
	const effective = group.modalityOverride === undefined
		? common
		: ordered(group.modalityOverride.filter((modality) => supported.includes(modality)));
	return { common, supported, effective };
}

export function assertModalityOverrideSupported(
	group: Pick<ModelGroupDef, "models" | "modalityOverride">,
	modelRegistry: Pick<ModelRegistry, "find">,
): void {
	if (group.modalityOverride === undefined) return;
	const supported = new Set(deriveModelGroupModalities(group, modelRegistry).supported);
	const missing = ordered(group.modalityOverride.filter((modality) => !supported.has(modality)));
	if (missing.length) throw new Error(`Model group modality override includes unsupported modalities: ${missing.join(", ")}.`);
}

export function getMissingModelModalities(model: Model<Api>, required: readonly ModelGroupModality[]): ModelGroupModality[] {
	const modalities = new Set(getModelModalities(model));
	return ordered(required.filter((modality) => !modalities.has(modality)));
}
