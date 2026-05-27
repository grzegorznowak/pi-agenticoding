import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgenticodingState } from "../state.js";
import { resolveHandoffAutomaticAvailability, type HandoffAutomaticAvailability } from "../settings.js";

function getActiveTools(pi: ExtensionAPI): string[] {
	return typeof pi.getActiveTools === "function" ? pi.getActiveTools() : [];
}

function setActiveTools(pi: ExtensionAPI, tools: string[]): void {
	if (typeof pi.setActiveTools === "function") {
		pi.setActiveTools(tools);
	}
}

export function applyHandoffToolAvailability(
	pi: ExtensionAPI,
	automaticEnabled: boolean,
	manualRequested: boolean,
): void {
	const shouldBeActive = automaticEnabled || manualRequested;
	const active = getActiveTools(pi);
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

export function temporarilyActivateHandoffTool(pi: ExtensionAPI): void {
	const active = getActiveTools(pi);
	if (!active.includes("handoff")) {
		setActiveTools(pi, [...active, "handoff"]);
	}
}
