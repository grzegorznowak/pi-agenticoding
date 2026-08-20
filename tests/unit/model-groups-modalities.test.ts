import test from "node:test";
import assert from "node:assert/strict";
import { assertModalityOverrideSupported, deriveModelGroupModalities, getMissingModelModalities } from "../../model-groups/modalities.js";
import type { ModelGroupDef } from "../../model-groups/types.js";

function registry(models: any[]): { find(provider: string, id: string): any } {
	return { find: (provider, id) => models.find((model) => model.provider === provider && model.id === id) };
}

test("derives ordered common, supported, and override-effective modalities from the live registry", () => {
	const models = [
		{ provider: "p", id: "rich", input: ["image", "text"], reasoning: true },
		{ provider: "p", id: "text", input: ["text"], reasoning: false },
	];
	const group = { models: [{ provider: "p", modelId: "rich" }, { provider: "p", modelId: "text" }] };
	assert.deepEqual(deriveModelGroupModalities(group, registry(models)), {
		common: ["text"], supported: ["text", "image", "reasoning"], effective: ["text"],
	});
	assert.deepEqual(deriveModelGroupModalities({ ...group, modalityOverride: ["reasoning", "image"] }, registry(models)).effective, ["image", "reasoning"]);
	assert.deepEqual(deriveModelGroupModalities({ models: [...group.models, { provider: "p", modelId: "gone" }] }, registry(models)).common, []);
	models[1].input = ["text", "image"];
	assert.deepEqual(deriveModelGroupModalities(group, registry(models)).common, ["text", "image"], "each call reads the live registry");
});

test("caps stale overrides without mutation and restores them when catalog support returns", () => {
	const def: ModelGroupDef = { models: [{ provider: "p", modelId: "m" }], modalityOverride: ["text", "image"] };
	const models: any[] = [{ provider: "p", id: "m", input: ["text"], reasoning: false }];
	const first = deriveModelGroupModalities(def, registry(models));
	assert.deepEqual(first.effective, ["text"]);
	assert.deepEqual(def.modalityOverride, ["text", "image"]);
	models[0].input.push("image");
	assert.deepEqual(deriveModelGroupModalities(def, registry(models)).effective, ["text", "image"]);
	assert.throws(() => assertModalityOverrideSupported(def, registry([{ provider: "p", id: "m", input: ["text"], reasoning: false }])), /unsupported modalities: image/);
	assert.deepEqual(getMissingModelModalities(models[0], ["text", "reasoning"]), ["reasoning"]);
});
