import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { clampThinkingLevel, type Api, type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { deriveModelGroupModalities, getMissingModelModalities } from "./modalities.js";
import { MODEL_GROUP_MODALITIES, type ModelGroupModality, type ResolvedModelGroup } from "./types.js";
export type SpawnRouteStatus = "inherited" | "routed" | "unknown-fallback";
export interface SpawnModelRoute { status: SpawnRouteStatus; requestedGroup?: string; groupName?: string; model: Model<Api>; provider: string; modelId: string; thinking: ModelThinkingLevel }
export type SpawnRouteErrorReason = "empty" | "no-usable-models" | "missing-modality";
export class SpawnRouteError extends Error {
	readonly kind = "unusable-group" as const; readonly group: string; readonly reason: SpawnRouteErrorReason; readonly missingModalities: ModelGroupModality[]; readonly missingFromGroup: ModelGroupModality[]; readonly missingFromModel: ModelGroupModality[];
	constructor(group: string, reason: SpawnRouteErrorReason, details: { missingModalities?: ModelGroupModality[]; missingFromGroup?: ModelGroupModality[]; missingFromModel?: ModelGroupModality[]; provider?: string; modelId?: string; knownGroup?: boolean } = {}) {
		const missingModalities = details.missingModalities ?? [], missingFromGroup = details.missingFromGroup ?? [], missingFromModel = details.missingFromModel ?? [];
		const message = reason === "empty" ? `Model Group '${group}' has no model entries.` : reason === "no-usable-models" ? `Model Group '${group}' has no configured/authenticated usable models.` : details.knownGroup ? `Model Group '${group}' cannot satisfy required modalities: ${missingModalities.join(", ")}. Effective group modalities missing: ${missingFromGroup.join(", ") || "none"}. Routed model '${details.provider}/${details.modelId}' missing: ${missingFromModel.join(", ") || "none"}.` : `Spawn model '${details.provider}/${details.modelId}' cannot satisfy required modalities: ${missingModalities.join(", ")}.`;
		super(message); this.name = "SpawnRouteError"; this.group = group; this.reason = reason; this.missingModalities = missingModalities; this.missingFromGroup = missingFromGroup; this.missingFromModel = missingFromModel;
	}
}
function parentProvider(model: Model<Api>): string { return typeof model.provider === "string" ? model.provider : ""; }
function effectiveGroupMap(groups: ResolvedModelGroup[]): Map<string, ResolvedModelGroup> { const map = new Map<string, ResolvedModelGroup>(); for (const group of groups) { if (group.validation?.shadowedByProject) continue; const current = map.get(group.name); if (!current || group.scope === "project") map.set(group.name, group); } return map; }
export function getEffectiveModelGroups(groups: ResolvedModelGroup[]): ResolvedModelGroup[] { return [...effectiveGroupMap(groups).values()].sort((a, b) => a.name.localeCompare(b.name)); }
export function getEffectiveModelGroupNames(groups: ResolvedModelGroup[]): string[] { return getEffectiveModelGroups(groups).map((group) => group.name); }
/** Absence and an empty list are equivalent: neither constrains routing. */
function required(values: readonly ModelGroupModality[] | undefined): ModelGroupModality[] { const set = new Set(values); return MODEL_GROUP_MODALITIES.filter((m) => set.has(m)); }
export function resolveSpawnModelRoute(options: { requestedGroup?: string; requiredModalities?: readonly ModelGroupModality[]; groups: ResolvedModelGroup[]; parentModel: Model<Api>; parentThinking: ModelThinkingLevel; modelRegistry: Pick<ModelRegistry, "find" | "hasConfiguredAuth">; rng?: () => number }): SpawnModelRoute {
	const requestedGroup = options.requestedGroup?.trim(); const req = required(options.requiredModalities);
	const inherited = (status: "inherited" | "unknown-fallback"): SpawnModelRoute => ({ status, ...(status === "unknown-fallback" && requestedGroup ? { requestedGroup } : {}), model: options.parentModel, provider: parentProvider(options.parentModel), modelId: options.parentModel.id, thinking: options.parentThinking });
	let route: SpawnModelRoute; let group: ResolvedModelGroup | undefined;
	if (!requestedGroup) route = inherited("inherited"); else { group = effectiveGroupMap(options.groups).get(requestedGroup); if (!group) route = inherited("unknown-fallback"); else { if (group.models.length === 0) throw new SpawnRouteError(group.name, "empty"); const usable = group.models.map((entry) => { const model = options.modelRegistry.find(entry.provider, entry.modelId) as Model<Api> | undefined; return model && options.modelRegistry.hasConfiguredAuth(model) ? { entry, model } : undefined; }).filter((entry): entry is { entry: ResolvedModelGroup["models"][number]; model: Model<Api> } => Boolean(entry)); if (!usable.length) throw new SpawnRouteError(group.name, "no-usable-models"); const selected = usable[Math.min(usable.length - 1, Math.max(0, Math.floor((options.rng ?? Math.random)() * usable.length)))]; route = { status: "routed", requestedGroup, groupName: group.name, model: selected.model, provider: selected.entry.provider, modelId: selected.entry.modelId, thinking: clampThinkingLevel(selected.model, selected.entry.thinkingLevel ?? options.parentThinking) }; } }
	if (!req.length) return route;
	const selectedGroup = group;
	const missingFromGroup = selectedGroup ? required(req.filter((m) => !deriveModelGroupModalities(selectedGroup, options.modelRegistry).effective.includes(m))) : [];
	const missingFromModel = getMissingModelModalities(route.model, req); const missingModalities = required([...missingFromGroup, ...missingFromModel]);
	if (missingModalities.length) throw new SpawnRouteError(group?.name ?? (requestedGroup || "<inherited>"), "missing-modality", { missingModalities, missingFromGroup, missingFromModel, provider: route.provider, modelId: route.modelId, knownGroup: Boolean(group) });
	return route;
}
