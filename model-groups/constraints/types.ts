import type { Api, Model } from "@earendil-works/pi-ai";
import type { TSchema } from "typebox";
import type { ModelGroupModel } from "../types.js";

export type DecodeResult<T> = { ok: true; value: T } | { ok: false; message: string };

export interface ConstraintMemberResolution {
	members: readonly { ref: ModelGroupModel; model?: Model<Api> }[];
}

export interface ConstraintCodec<T> {
	decode(value: unknown, path: string): DecodeResult<T>;
	encode(value: T): unknown;
	equals(left: T, right: T): boolean;
	schema: TSchema;
}

export interface ConstraintDiagnostic {
	key: string;
	code: string;
	details?: unknown;
}

export interface ConstraintSatisfaction {
	satisfied: boolean;
	missing?: unknown;
	unsatisfied?: unknown;
}

export interface ConstraintViolation {
	key: string;
	scope: "group" | "model";
	satisfaction: ConstraintSatisfaction;
}

export type ConstraintEditorSpec<Override, Aggregate, Effective> =
	| { kind: "multi-select"; label: string; choices(evaluation: ConstraintEvaluation<Aggregate, Effective>): readonly string[]; automatic(evaluation: ConstraintEvaluation<Aggregate, Effective>): string; format(value: readonly string[]): string; allowAutomatic: true }
	| { kind: "number"; label: string; unit: string; min: number; step: number; automatic(evaluation: ConstraintEvaluation<Aggregate, Effective>): string; value(evaluation: ConstraintEvaluation<Aggregate, Effective>): number | null; allowAutomatic: true };

export interface ConstraintEvaluation<Aggregate, Effective> {
	key: string;
	aggregate: Aggregate;
	effective: Effective;
	diagnostics: readonly ConstraintDiagnostic[];
}

export interface ConstraintDescriptor<K extends string, Fact, Aggregate, Override, Requirement, Effective> {
	readonly key: K;
	readonly order: number;
	modelFact(model: Model<Api>): Fact;
	aggregate(input: { members: readonly { ref: ModelGroupModel; fact?: Fact }[] }): Aggregate;
	reconcile(input: { aggregate: Aggregate; override: Override | undefined }): { effective: Effective; diagnostics: ConstraintDiagnostic[] };
	groupSatisfies(input: { aggregate: Aggregate; effective: Effective; requirement: Requirement }): ConstraintSatisfaction;
	modelSatisfies(input: { fact: Fact; requirement: Requirement }): ConstraintSatisfaction;
	persistence: { override: ConstraintCodec<Override>; clone(value: Override): Override };
	requirement: ConstraintCodec<Requirement>;
	editor: ConstraintEditorSpec<Override, Aggregate, Effective>;
	present: {
		group(evaluation: ConstraintEvaluation<Aggregate, Effective>): string;
		prompt(evaluation: ConstraintEvaluation<Aggregate, Effective>): string;
		diagnostic(diagnostic: ConstraintDiagnostic): string;
		violation(violation: ConstraintViolation): string;
	};
}

export type AnyConstraintDescriptor = ConstraintDescriptor<string, unknown, unknown, unknown, unknown, unknown>;
export type ErasedConstraintEvaluation = ConstraintEvaluation<unknown, unknown>;
