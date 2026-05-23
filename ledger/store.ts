/**
 * Shared ledger storage helpers.
 *
 * Keeps parent and spawned-child ledger writes on the same persistence path.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { AsyncLocalStorage } from "node:async_hooks";
import type { AgenticodingState } from "../state.js";

/**
 * Module-level write lock state.
 *
 * Concurrent callers serialize by chaining on the prior promise. Reentrancy is
 * tracked per async call chain so a nested saveLedgerEntry fails explicitly
 * without rejecting unrelated concurrent writers that happen to overlap.
 */
let writeLock: Promise<void> = Promise.resolve();
const writeContext = new AsyncLocalStorage<true>();

/** Reset write lock state. Only for test cleanup after concurrent runs. */
export function resetLedgerWriteLock(): void {
	writeLock = Promise.resolve();
}

async function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
	if (writeContext.getStore()) {
		throw new Error(
			"Ledger write lock is not reentrant — saveLedgerEntry called from within its own critical section.",
		);
	}
	let release: () => void;
	const prev = writeLock;
	writeLock = new Promise<void>((resolve) => {
		release = resolve;
	});
	await prev;
	try {
		return await writeContext.run(true, fn);
	} finally {
		release!();
	}
}

export function getEntryNames(state: AgenticodingState): string[] {
	return Array.from(state.ledger.keys()).sort();
}

export const PREVIEW_MAX_CHARS = 80;
const ELLIPSIS_LENGTH = 3;

export function formatEntryPreview(content: string): string {
	const firstLine = content.split("\n")[0] ?? "";
	return firstLine.length > PREVIEW_MAX_CHARS
		? firstLine.slice(0, PREVIEW_MAX_CHARS - ELLIPSIS_LENGTH) + "..."
		: firstLine;
}

export function formatEntryList(state: AgenticodingState): string {
	const names = getEntryNames(state);
	if (names.length === 0) return "";

	return names
		.map((name) => {
			const content = state.ledger.get(name)!;
			return `  ${name}: ${formatEntryPreview(content)}`;
		})
		.join("\n");
}

export async function saveLedgerEntry(
	pi: ExtensionAPI,
	state: AgenticodingState,
	name: string,
	content: string,
	assertWritable?: () => void | Promise<void>,
): Promise<{ entries: string[]; preview: string }> {
	return withWriteLock(async () => {
		await assertWritable?.();
		const truncated = truncateHead(content, {
			maxLines: DEFAULT_MAX_LINES,
			maxBytes: DEFAULT_MAX_BYTES,
		});

		if (state.epoch === 0) {
			state.epoch = Date.now();
		}

		state.ledger.set(name, truncated.content);
		pi.appendEntry("ledger-entry", {
			version: 1,
			epoch: state.epoch,
			name,
			content: truncated.content,
		});

		return {
			entries: getEntryNames(state),
			preview: formatEntryPreview(truncated.content),
		};
	});
}
