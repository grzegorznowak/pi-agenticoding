/**
 * Readonly cache for skill/prompt-template frontmatter.
 *
 * Populated lazily in `before_agent_start` from:
 *   1. Loaded skills (via `systemPromptOptions.skills`).
 *   2. Resolved prompt commands from `pi.getCommands()`.
 *   3. Standard prompt directories as a partial fallback:
 *      `~/.pi/agent/prompts/` and trusted `cwd/.pi/prompts/`.
 *
 * All production prompt-resolution happens through
 * `populatePromptCacheFromResolvedCommandsAndDirs`. The narrower
 * `populateFromPromptDirs`, `populateFromPromptCommands`, and
 * `populateFromPromptTemplates` have been removed as dead code —
 * they duplicated the logic of the production path. Any test that
 * needs to exercise prompt caching should go through the production
 * function with an empty command list.
 */

import { readFileSync, statSync, readdirSync } from "node:fs";
import { join, extname, basename } from "node:path";
import { homedir } from "node:os";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { Skill, SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

export interface ReadonlyCacheEntry {
	readonly: boolean | null;
	modelGroup: string | null;
	explicitModel: string | null;
	explicitThinking: ModelThinkingLevel | null;
	mtimeMs: number;
	filePath: string;
}

export interface ReadonlyCacheIssue {
	kind: "invalid-readonly-value" | "invalid-model-group-value" | "invalid-explicit-model-value" | "invalid-thinking-value" | "malformed-frontmatter" | "unreadable-file";
	filePath: string;
}

export interface ReadonlyCacheStore {
	readonlySkillCache: Map<string, ReadonlyCacheEntry>;
	readonlyPromptCache: Map<string, ReadonlyCacheEntry>;
	readonlySkillIssues: Map<string, ReadonlyCacheIssue>;
	readonlyPromptIssues: Map<string, ReadonlyCacheIssue>;
}

interface CacheReadResult {
	entry: ReadonlyCacheEntry | null;
	issue: ReadonlyCacheIssue | null;
}

const THINKING_LEVELS: ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function parseExplicitModel(raw: unknown): string | null {
	if (typeof raw !== "string" || raw.trim().length === 0) return null;
	const trimmed = raw.trim();
	// Must match provider/model-id — exactly one slash, non-empty parts
	const slashIdx = trimmed.indexOf("/");
	if (slashIdx === -1 || slashIdx === 0 || slashIdx === trimmed.length - 1 || trimmed.lastIndexOf("/") !== slashIdx) return null;
	return trimmed;
}

function parseExplicitThinking(raw: unknown): ModelThinkingLevel | null {
	if (typeof raw !== "string") return null;
	const trimmed = raw.trim().toLowerCase() as ModelThinkingLevel;
	return THINKING_LEVELS.includes(trimmed) ? trimmed : null;
}

function readCacheEntry(
	filePath: string,
	previous?: ReadonlyCacheEntry,
	previousIssue?: ReadonlyCacheIssue,
): CacheReadResult {
	let st;
	try {
		st = statSync(filePath);
	} catch (error: any) {
		return error?.code === "ENOENT" || error?.code === "ENOTDIR"
			? { entry: null, issue: null }
			: { entry: null, issue: { kind: "unreadable-file", filePath } };
	}

	if (previous && previous.filePath === filePath && st.mtimeMs === previous.mtimeMs) {
		return { entry: previous, issue: previousIssue ?? null };
	}

	let content: string;
	try {
		content = readFileSync(filePath, "utf-8");
	} catch {
		return { entry: null, issue: { kind: "unreadable-file", filePath } };
	}

	try {
		const { frontmatter } = parseFrontmatter<Record<string, unknown>>(content);
		const readonly = frontmatter["readonly"];
		const modelGroupRaw = frontmatter["model-group"];
		const modelRaw = frontmatter["model"];
		const thinkingRaw = frontmatter["thinking"];

		// Validate readonly first - fail-fast on first invalid field.
		// Fields are semantically ordered so fixing this typically reveals the next.
		if (readonly !== undefined && typeof readonly !== "boolean") {
			return {
				entry: { readonly: null, modelGroup: null, explicitModel: null, explicitThinking: null, mtimeMs: st.mtimeMs, filePath },
				issue: { kind: "invalid-readonly-value", filePath },
			};
		}

		// Validate model-group next - fail-fast pattern continues.
		if (modelGroupRaw !== undefined && (typeof modelGroupRaw !== "string" || modelGroupRaw.trim().length === 0)) {
			return {
				entry: { readonly: readonly ?? null, modelGroup: null, explicitModel: null, explicitThinking: null, mtimeMs: st.mtimeMs, filePath },
				issue: { kind: "invalid-model-group-value", filePath },
			};
		}

		// Validate explicit model - fail-fast pattern continues.
		const explicitModel = modelRaw !== undefined ? parseExplicitModel(modelRaw) : null;
		if (modelRaw !== undefined && explicitModel === null) {
			return {
				entry: { readonly: readonly ?? null, modelGroup: null, explicitModel: null, explicitThinking: null, mtimeMs: st.mtimeMs, filePath },
				issue: { kind: "invalid-explicit-model-value", filePath },
			};
		}

		// Validate explicit thinking last - fail-fast pattern completes.
		const explicitThinking = thinkingRaw !== undefined ? parseExplicitThinking(thinkingRaw) : null;
		if (thinkingRaw !== undefined && explicitThinking === null) {
			return {
				entry: { readonly: readonly ?? null, modelGroup: null, explicitModel, explicitThinking: null, mtimeMs: st.mtimeMs, filePath },
				issue: { kind: "invalid-thinking-value", filePath },
			};
		}

		return {
			entry: {
				readonly: readonly ?? null,
				modelGroup: (typeof modelGroupRaw === "string" ? modelGroupRaw.trim() : null) ?? null,
				explicitModel,
				explicitThinking,
				mtimeMs: st.mtimeMs,
				filePath,
			},
			issue: null,
		};
	} catch {
		return {
			entry: null,
			issue: { kind: "malformed-frontmatter", filePath },
		};
	}
}

function replaceCache(target: Map<string, ReadonlyCacheEntry>, next: Map<string, ReadonlyCacheEntry>): void {
	target.clear();
	for (const [name, entry] of next) target.set(name, entry);
}

function replaceIssues(target: Map<string, ReadonlyCacheIssue>, next: Map<string, ReadonlyCacheIssue>): void {
	target.clear();
	for (const [name, issue] of next) target.set(name, issue);
}

function setEntry(
	nextCache: Map<string, ReadonlyCacheEntry>,
	nextIssues: Map<string, ReadonlyCacheIssue>,
	name: string,
	result: CacheReadResult,
): void {
	if (result.entry) nextCache.set(name, result.entry);
	if (result.issue) nextIssues.set(name, result.issue);
}

export function cacheLookupSkill(store: ReadonlyCacheStore, name: string): boolean | null {
	return store.readonlySkillCache.get(name)?.readonly ?? null;
}

export function cacheLookupPrompt(store: ReadonlyCacheStore, name: string): boolean | null {
	return store.readonlyPromptCache.get(name)?.readonly ?? null;
}

export function cacheLookupCommand(store: ReadonlyCacheStore, name: string): boolean | null {
	return cacheLookupPrompt(store, name);
}

export function cacheLookupSkillModelGroup(store: ReadonlyCacheStore, name: string): string | null {
	return store.readonlySkillCache.get(name)?.modelGroup ?? null;
}

export function cacheLookupCommandModelGroup(store: ReadonlyCacheStore, name: string): string | null {
	return store.readonlyPromptCache.get(name)?.modelGroup ?? null;
}

export function cacheLookupSkillExplicitModel(store: ReadonlyCacheStore, name: string): string | null {
	return store.readonlySkillCache.get(name)?.explicitModel ?? null;
}

export function cacheLookupCommandExplicitModel(store: ReadonlyCacheStore, name: string): string | null {
	return store.readonlyPromptCache.get(name)?.explicitModel ?? null;
}

export function cacheLookupSkillExplicitThinking(store: ReadonlyCacheStore, name: string): ModelThinkingLevel | null {
	return store.readonlySkillCache.get(name)?.explicitThinking ?? null;
}

export function cacheLookupCommandExplicitThinking(store: ReadonlyCacheStore, name: string): ModelThinkingLevel | null {
	return store.readonlyPromptCache.get(name)?.explicitThinking ?? null;
}

export function cacheLookupSkillIssue(store: ReadonlyCacheStore, name: string): ReadonlyCacheIssue | null {
	return store.readonlySkillIssues.get(name) ?? null;
}

export function cacheLookupCommandIssue(store: ReadonlyCacheStore, name: string): ReadonlyCacheIssue | null {
	return store.readonlyPromptIssues.get(name) ?? null;
}

/**
 * Format a user-facing warning message for a frontmatter issue.
 * Covers invalid `readonly`, `model-group`, `model`, `thinking`,
 * malformed YAML, and unreadable source files. Missing fields are normal no-ops.
 */
export function formatFrontmatterIssue(commandRef: string, issue: ReadonlyCacheIssue): string {
	const detail = issue.kind === "invalid-readonly-value"
		? "`readonly` frontmatter must be `true` or `false`"
		: issue.kind === "invalid-model-group-value"
			? "`model-group` frontmatter must be a non-empty string"
		: issue.kind === "invalid-explicit-model-value"
			? "`model` frontmatter must be in `<provider>/<model-id>` format"
		: issue.kind === "invalid-thinking-value"
			? "`thinking` frontmatter must be one of: off, minimal, low, medium, high, xhigh, max"
		: issue.kind === "malformed-frontmatter"
			? "frontmatter could not be parsed"
			: "prompt/skill file could not be read";
	return `Frontmatter ignored for \`${commandRef}\`: ${detail} at \`${issue.filePath}\`.`;
}

export function populateFromSkills(store: ReadonlyCacheStore, skills: Skill[]): void {
	const nextCache = new Map<string, ReadonlyCacheEntry>();
	const nextIssues = new Map<string, ReadonlyCacheIssue>();
	for (const skill of skills) {
		const result = readCacheEntry(
			skill.filePath,
			store.readonlySkillCache.get(skill.name),
			store.readonlySkillIssues.get(skill.name),
		);
		setEntry(nextCache, nextIssues, skill.name, result);
	}
	replaceCache(store.readonlySkillCache, nextCache);
	replaceIssues(store.readonlySkillIssues, nextIssues);
}

function collectPromptFilesFromDir(
	store: ReadonlyCacheStore,
	dir: string,
	nextCache: Map<string, ReadonlyCacheEntry>,
	nextIssues: Map<string, ReadonlyCacheIssue>,
	blockedNames: Set<string>,
): void {
	let files: string[];
	try {
		files = readdirSync(dir);
	} catch {
		return;
	}
	for (const file of files) {
		if (extname(file) !== ".md") continue;
		const name = basename(file, ".md");
		if (!name || blockedNames.has(name) || nextCache.has(name) || nextIssues.has(name)) continue;
		const result = readCacheEntry(
			join(dir, file),
			store.readonlyPromptCache.get(name),
			store.readonlyPromptIssues.get(name),
		);
		setEntry(nextCache, nextIssues, name, result);
	}
}

/**
 * Populate the prompt cache from resolved prompt commands plus the standard
 * prompt directories that Pi also uses on disk.
 *
 * Priority for duplicate names:
 *   1. Resolved prompt commands from `pi.getCommands()`.
 *   2. Trusted project prompts in `cwd/.pi/prompts/`.
 *   3. Global prompts in `~/.pi/agent/prompts/`.
 *
 * This is intentionally not a full prompt-source resolver. Anything outside
 * those standard dirs must already be surfaced by `pi.getCommands()`.
 */
export function populatePromptCacheFromResolvedCommandsAndDirs(
	store: ReadonlyCacheStore,
	commands: SlashCommandInfo[],
	cwd: string,
	projectTrusted: boolean,
): void {
	const nextCache = new Map<string, ReadonlyCacheEntry>();
	const nextIssues = new Map<string, ReadonlyCacheIssue>();
	const blockedNames = new Set<string>();

	for (const command of commands) {
		if (!command.name) continue;
		if (command.source !== "prompt") {
			blockedNames.add(command.name);
			continue;
		}
		if (nextCache.has(command.name) || nextIssues.has(command.name)) continue;
		const result = readCacheEntry(
			command.sourceInfo.path,
			store.readonlyPromptCache.get(command.name),
			store.readonlyPromptIssues.get(command.name),
		);
		setEntry(nextCache, nextIssues, command.name, result);
	}

	if (projectTrusted) {
		collectPromptFilesFromDir(store, join(cwd, ".pi", "prompts"), nextCache, nextIssues, blockedNames);
	}
	collectPromptFilesFromDir(store, join(homedir(), ".pi", "agent", "prompts"), nextCache, nextIssues, blockedNames);

	replaceCache(store.readonlyPromptCache, nextCache);
	replaceIssues(store.readonlyPromptIssues, nextIssues);
}
