import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgenticodingState } from "../state.js";
import { resolveHandoffAutomaticAvailability, type HandoffAutomaticAvailability } from "../settings.js";

function getActiveTools(pi: ExtensionAPI): string[] | null {
	return typeof pi.getActiveTools === "function" ? pi.getActiveTools() : null;
}

function setActiveTools(pi: ExtensionAPI, tools: string[]): boolean {
	if (typeof pi.setActiveTools !== "function") {
		return false;
	}
	pi.setActiveTools(tools);
	return true;
}

export function applyHandoffToolAvailability(
	pi: ExtensionAPI,
	automaticEnabled: boolean,
	manualRequested: boolean,
): void {
	const shouldBeActive = automaticEnabled || manualRequested;
	const active = getActiveTools(pi);
	if (!active) {
		return;
	}
	const hasHandoff = active.includes("handoff");

	if (shouldBeActive && !hasHandoff) {
		setActiveTools(pi, [...active, "handoff"]);
		return;
	}

	if (!shouldBeActive && hasHandoff) {
		setActiveTools(pi, active.filter((tool) => tool !== "handoff"));
	}
}

export async function updateHandoffToolAvailability(
	pi: ExtensionAPI,
	state: AgenticodingState,
	ctx: ExtensionContext,
): Promise<HandoffAutomaticAvailability> {
	const availability = await resolveHandoffAutomaticAvailability(ctx);
	applyHandoffToolAvailability(pi, availability.automaticEnabled, state.pendingRequestedHandoff !== null);
	return availability;
}

export function temporarilyActivateHandoffTool(pi: ExtensionAPI): boolean {
	const active = getActiveTools(pi);
	if (!active) {
		return false;
	}
	if (active.includes("handoff")) {
		return true;
	}
	if (!setActiveTools(pi, [...active, "handoff"])) {
		return false;
	}
	return getActiveTools(pi)?.includes("handoff") ?? false;
}
