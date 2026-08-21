import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { assertModalitiesOverrideSupported, deriveModalitiesEvaluation, getMissingModalitiesFromModel, getModalitiesModelFact } from "./constraints/modalities.js";
import { resolveConstraintMembers } from "./constraints/resolution.js";
import type { ModelGroupDef, ModelGroupModalities, ModelGroupModality } from "./types.js";

/** Compatibility façade for the production modalities descriptor. */
export function getModelModalities(model: Model<Api>): ModelGroupModality[] {
	return getModalitiesModelFact(model);
}

export function deriveModelGroupModalities(
	group: Pick<ModelGroupDef, "models" | "modalityOverride">,
	modelRegistry: Pick<ModelRegistry, "find">,
): ModelGroupModalities {
	const evaluation = deriveModalitiesEvaluation(resolveConstraintMembers(group.models, modelRegistry).members, group.modalityOverride);
	return { common: evaluation.aggregate.common, supported: evaluation.aggregate.supported, effective: evaluation.effective };
}

export function assertModalityOverrideSupported(
	group: Pick<ModelGroupDef, "models" | "modalityOverride">,
	modelRegistry: Pick<ModelRegistry, "find">,
): void {
	const evaluation = deriveModalitiesEvaluation(resolveConstraintMembers(group.models, modelRegistry).members, group.modalityOverride);
	assertModalitiesOverrideSupported(evaluation, group.modalityOverride);
}

export function getMissingModelModalities(model: Model<Api>, required: readonly ModelGroupModality[]): ModelGroupModality[] {
	return getMissingModalitiesFromModel(model, required);
}
