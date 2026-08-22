import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { clampThinkingLevel, type Api, type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { evaluateConstraint, evaluateGroupRequirement, evaluateModelRequirement } from "./constraints/engine.js";
import { productionConstraintRegistry, type ConstraintRegistry } from "./constraints/registry.js";
import { resolveConstraintMembers } from "./constraints/resolution.js";
import { getModalitiesModelFact } from "./constraints/modalities.js";
import type { ConstraintViolation } from "./constraints/types.js";
import { type ModelGroupModality, type ResolvedModelGroup } from "./types.js";

export type SpawnRouteStatus = "inherited" | "routed" | "unknown-fallback";
export interface SpawnModelRoute {
	status: SpawnRouteStatus;
	requestedGroup?: string;
	groupName?: string;
	model: Model<Api>;
	provider: string;
	modelId: string;
	thinking: ModelThinkingLevel;
	/**
	 * For a routed group with an explicit modality override, the group's
	 * effective capability set. Undefined for inherited/unknown-fallback routes
	 * and for groups without an explicit override. Exposed so spawn can orient
	 * the child to the group's declared capability ceiling (Level-1 advisory).
	 */
	modalityCeiling?: readonly ModelGroupModality[];
}
export type SpawnRouteErrorReason = "empty" | "no-usable-models" | "missing-modality" | "constraint-unsatisfied";
export class SpawnRouteError extends Error {
	readonly kind = "unusable-group" as const; readonly group: string; readonly reason: SpawnRouteErrorReason; readonly missingModalities: ModelGroupModality[]; readonly missingFromGroup: ModelGroupModality[]; readonly missingFromModel: ModelGroupModality[]; readonly constraintUnsatisfied?: readonly ConstraintViolation[];
	constructor(group: string, reason: SpawnRouteErrorReason, details: { missingModalities?: ModelGroupModality[]; missingFromGroup?: ModelGroupModality[]; missingFromModel?: ModelGroupModality[]; constraintUnsatisfied?: readonly ConstraintViolation[]; provider?: string; modelId?: string; knownGroup?: boolean } = {}) {
		const missingModalities = details.missingModalities ?? [], missingFromGroup = details.missingFromGroup ?? [], missingFromModel = details.missingFromModel ?? [];
		const message = reason === "empty" ? `Model Group '${group}' has no model entries.` : reason === "no-usable-models" ? `Model Group '${group}' has no configured/authenticated usable models.` : reason === "missing-modality" ? details.knownGroup ? `Model Group '${group}' cannot satisfy required modalities: ${missingModalities.join(", ")}. Effective group modalities missing: ${missingFromGroup.join(", ") || "none"}. Routed model '${details.provider}/${details.modelId}' missing: ${missingFromModel.join(", ") || "none"}.` : `Spawn model '${details.provider}/${details.modelId}' cannot satisfy required modalities: ${missingModalities.join(", ")}.` : `Spawn route '${group}' cannot satisfy constraint requirements.`;
		super(message); this.name = "SpawnRouteError"; this.group = group; this.reason = reason; this.missingModalities = missingModalities; this.missingFromGroup = missingFromGroup; this.missingFromModel = missingFromModel; if (details.constraintUnsatisfied) this.constraintUnsatisfied = details.constraintUnsatisfied;
	}
}
function parentProvider(model: Model<Api>): string { return typeof model.provider === "string" ? model.provider : ""; }
function effectiveGroupMap(groups: ResolvedModelGroup[]): Map<string, ResolvedModelGroup> { const map = new Map<string, ResolvedModelGroup>(); for (const group of groups) { if (group.validation?.shadowedByProject) continue; const current = map.get(group.name); if (!current || group.scope === "project") map.set(group.name, group); } return map; }
export function getEffectiveModelGroups(groups: ResolvedModelGroup[]): ResolvedModelGroup[] { return [...effectiveGroupMap(groups).values()].sort((a, b) => a.name.localeCompare(b.name)); }
export function getEffectiveModelGroupNames(groups: ResolvedModelGroup[]): string[] { return getEffectiveModelGroups(groups).map((group) => group.name); }

/** Route selection remains auth-aware; constraint evaluation receives its explicit member snapshot. */
export function resolveSpawnModelRoute(options: { requestedGroup?: string; constraints?: Readonly<Record<string, unknown>>; groups: ResolvedModelGroup[]; parentModel: Model<Api>; parentThinking: ModelThinkingLevel; modelRegistry: Pick<ModelRegistry, "find" | "hasConfiguredAuth">; constraintRegistry?: ConstraintRegistry; rng?: () => number; routeCursor?: Map<string, number> }): SpawnModelRoute {
	const requestedGroup = options.requestedGroup?.trim(); const requirements = options.constraints ?? {}; const registry = options.constraintRegistry ?? productionConstraintRegistry;
	const inherited = (status: "inherited" | "unknown-fallback"): SpawnModelRoute => ({ status, ...(status === "unknown-fallback" && requestedGroup ? { requestedGroup } : {}), model: options.parentModel, provider: parentProvider(options.parentModel), modelId: options.parentModel.id, thinking: options.parentThinking });
	let route: SpawnModelRoute; let group: ResolvedModelGroup | undefined;
	if (!requestedGroup) route = inherited("inherited"); else { group = effectiveGroupMap(options.groups).get(requestedGroup); if (!group) route = inherited("unknown-fallback"); else { if (group.models.length === 0) throw new SpawnRouteError(group.name, "empty"); const usable = group.models.map((entry) => { const model = options.modelRegistry.find(entry.provider, entry.modelId) as Model<Api> | undefined; return model && options.modelRegistry.hasConfiguredAuth(model) ? { entry, model } : undefined; }).filter((entry): entry is { entry: ResolvedModelGroup["models"][number]; model: Model<Api> } => Boolean(entry)); if (!usable.length) throw new SpawnRouteError(group.name, "no-usable-models"); const rawModal = requirements.modalities; const modalityRequirement = rawModal === undefined ? [] : Array.isArray(rawModal) ? rawModal as ModelGroupModality[] : (() => { const d = registry.get("modalities"); if (!d) return []; const dec = d.requirement.decode(rawModal, "constraints.modalities"); return dec.ok ? dec.value as ModelGroupModality[] : []; })(); const capable = modalityRequirement.length ? usable.filter(({ model }) => modalityRequirement.every((m) => getModalitiesModelFact(model).includes(m))) : usable; const pool = capable.length ? capable : usable; let selected; if (options.routeCursor && modalityRequirement.length && capable.length) { const index = options.routeCursor.get(group.name) ?? 0; options.routeCursor.set(group.name, (index + 1) % pool.length); selected = pool[index % pool.length]; } else { selected = pool[Math.min(pool.length - 1, Math.max(0, Math.floor((options.rng ?? Math.random)() * pool.length)))]; } route = { status: "routed", requestedGroup, groupName: group.name, model: selected.model, provider: selected.entry.provider, modelId: selected.entry.modelId, thinking: clampThinkingLevel(selected.model, selected.entry.thinkingLevel ?? options.parentThinking) };
				// Level-1 capability orientation: an explicit modality override is the
				// group's declared capability ceiling. Carry it on the route regardless
				// of whether the caller declared a requirement, so spawn can orient the
				// child to the group's allowed scope.
				if (group.constraints?.modalities !== undefined) {
					route = { ...route, modalityCeiling: [...(group.modalities?.effective ?? [])] };
				}
			 } }
	if (!Object.keys(requirements).length) return route;
	const resolution = group ? resolveConstraintMembers(group.models, options.modelRegistry) : { members: [] };
	const violations: ConstraintViolation[] = [];
	for (const [key, rawRequirement] of Object.entries(requirements)) {
		const descriptor = registry.get(key);
		if (!descriptor) throw new Error(`Unknown spawn constraint requirement '${key}'.`);
		const decoded = Array.isArray(rawRequirement) ? { ok: true as const, value: rawRequirement } : descriptor.requirement.decode(rawRequirement, `constraints.${key}`);
		if (!decoded.ok) throw new Error(decoded.message);
		const requirement = decoded.value;
		if (group) {
			const override = group.constraints?.[key];
			const evaluation = evaluateConstraint(descriptor, resolution, override);
			const violation = evaluateGroupRequirement(descriptor, evaluation, requirement);
			if (violation) violations.push(violation);
		}
		const violation = evaluateModelRequirement(descriptor, route.model, requirement);
		if (violation) violations.push(violation);
	}
	const modalityViolations = violations.filter((violation) => violation.key === "modalities");
	if (modalityViolations.length) {
		const missingFromGroup = modalityViolations.filter((violation) => violation.scope === "group").flatMap((violation) => violation.satisfaction.missing as ModelGroupModality[] ?? []);
		const missingFromModel = modalityViolations.filter((violation) => violation.scope === "model").flatMap((violation) => violation.satisfaction.missing as ModelGroupModality[] ?? []);
		const codec = registry.get("modalities")!.requirement;
		const ordered = (values: readonly ModelGroupModality[]) => {
			const decoded = codec.decode({ required: values }, "modalities");
			return decoded.ok ? decoded.value as ModelGroupModality[] : [...values];
		};
		throw new SpawnRouteError(group?.name ?? (requestedGroup || "<inherited>"), "missing-modality", { missingModalities: ordered([...missingFromGroup, ...missingFromModel]), missingFromGroup: ordered(missingFromGroup), missingFromModel: ordered(missingFromModel), provider: route.provider, modelId: route.modelId, knownGroup: Boolean(group) });
	}
	if (violations.length) throw new SpawnRouteError(group?.name ?? (requestedGroup || "<inherited>"), "constraint-unsatisfied", { constraintUnsatisfied: violations, provider: route.provider, modelId: route.modelId, knownGroup: Boolean(group) });
	return route;
}
