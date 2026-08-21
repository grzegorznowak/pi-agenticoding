import test from "node:test";
import assert from "node:assert/strict";
import { getEffectiveModelGroupNames, resolveSpawnModelRoute, SpawnRouteError } from "../../model-groups/router.js";
import type { ResolvedModelGroup } from "../../model-groups/types.js";
import { group } from "./model-groups-helpers.js";

function model(provider: string, id: string, overrides: Record<string, unknown> = {}): any {
	return { provider, id, reasoning: true, input: ["text"], ...overrides };
}

function registry(models: any[], authenticated = new Set(models.map((m) => `${m.provider}:${m.id}`))): any {
	return {
		find: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id),
		hasConfiguredAuth: (m: any) => authenticated.has(`${m.provider}:${m.id}`),
	};
}

test("effective model group names use project-over-global names", () => {
	const groups = [group("review", { scope: "global", shadowedByProject: true }), group("review", { scope: "project" }), group("research", { scope: "global" })];
	assert.deepEqual(getEffectiveModelGroupNames(groups), ["research", "review"]);
});

test("omitted and unknown groups inherit parent route with fallback metadata", () => {
	const parent = model("openai", "gpt-parent");
	const reg = registry([parent]);
	assert.deepEqual(resolveSpawnModelRoute({ groups: [], parentModel: parent, parentThinking: "medium", modelRegistry: reg }).status, "inherited");
	const route = resolveSpawnModelRoute({ requestedGroup: "typo", groups: [], parentModel: parent, parentThinking: "medium", modelRegistry: reg });
	assert.equal(route.status, "unknown-fallback"); assert.equal(route.requestedGroup, "typo"); assert.equal(route.model, parent); assert.equal(route.thinking, "medium");
});

test("known empty and all-unusable groups fail clearly", () => {
	const parent = model("openai", "parent");
	assert.throws(() => resolveSpawnModelRoute({ requestedGroup: "empty", requiredModalities: ["image"], groups: [group("empty", { scope: "project" })], parentModel: parent, parentThinking: "low", modelRegistry: registry([parent]) }), (error: unknown) => error instanceof SpawnRouteError && error.reason === "empty");
	assert.throws(() => resolveSpawnModelRoute({ requestedGroup: "bad", requiredModalities: ["image"], groups: [group("bad", { scope: "project", models: [{ provider: "openai", modelId: "missing" }] })], parentModel: parent, parentThinking: "low", modelRegistry: registry([parent]) }), (error: unknown) => error instanceof SpawnRouteError && error.reason === "no-usable-models");
});

test("required modalities check the effective group and actual RNG-selected model", () => {
	const parent = model("p", "parent");
	const text = model("p", "text");
	const image = model("p", "image", { input: ["text", "image"] });
	const routed = group("mixed", { models: [{ provider: "p", modelId: "text" }, { provider: "p", modelId: "image" }], modalityOverride: ["text", "image"] });
	routed.modalities = { common: ["text"], supported: ["text", "image"], effective: ["text", "image"] };
	const reg = registry([parent, text, image]);
	assert.throws(() => resolveSpawnModelRoute({ requestedGroup: "mixed", requiredModalities: ["image"], groups: [routed], parentModel: parent, parentThinking: "low", modelRegistry: reg, rng: () => 0 }), (error: unknown) => error instanceof SpawnRouteError && error.reason === "missing-modality" && error.missingFromGroup.length === 0 && error.missingFromModel[0] === "image" && /Routed model/.test(error.message));
	assert.equal(resolveSpawnModelRoute({ requestedGroup: "mixed", requiredModalities: ["image"], groups: [routed], parentModel: parent, parentThinking: "low", modelRegistry: reg, rng: () => .99 }).status, "routed");
});

test("known group missing effective modality and inherited fallback reject requirements", () => {
	const parent = model("p", "parent"); const text = model("p", "text"); const g = group("text", { models: [{ provider: "p", modelId: "text" }] });
	assert.throws(() => resolveSpawnModelRoute({ requestedGroup: "text", requiredModalities: ["image"], groups: [g], parentModel: parent, parentThinking: "low", modelRegistry: registry([parent, text]) }), (error: unknown) => error instanceof SpawnRouteError && error.missingFromGroup[0] === "image");
	assert.throws(() => resolveSpawnModelRoute({ requestedGroup: "unknown", requiredModalities: ["image"], groups: [], parentModel: parent, parentThinking: "low", modelRegistry: registry([parent]) }), (error: unknown) => error instanceof SpawnRouteError && error.group === "unknown" && /Spawn model/.test(error.message));
});

test("plain inherited route honors requiredModalities with empty-array no-op", () => {
	const rich = model("p", "rich-parent", { input: ["text", "image"] });
	const text = model("p", "text-parent", { input: ["text"] });
	// Empty array is a no-op: route returns unchanged, no requirement check.
	assert.deepEqual(resolveSpawnModelRoute({ requiredModalities: [], groups: [], parentModel: text, parentThinking: "medium", modelRegistry: registry([text]) }).status, "inherited");
	// Parent satisfies all requirements → inherited route succeeds.
	assert.deepEqual(resolveSpawnModelRoute({ requiredModalities: ["text", "image"], groups: [], parentModel: rich, parentThinking: "medium", modelRegistry: registry([rich]) }).status, "inherited");
	// Parent lacks a required modality → missing-modality with the parent model details.
	assert.throws(() => resolveSpawnModelRoute({ requiredModalities: ["image"], groups: [], parentModel: text, parentThinking: "medium", modelRegistry: registry([text]) }), (error: unknown) => error instanceof SpawnRouteError && error.reason === "missing-modality" && error.group === "<inherited>" && error.missingFromModel[0] === "image" && error.missingFromGroup.length === 0 && /Spawn model/.test(error.message));
});
