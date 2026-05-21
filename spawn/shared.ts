export type ThinkingValue = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type SpawnOutcome = "running" | "success" | "aborted" | "error";

export type SpawnResultDetails = {
	model: string;
	thinking: ThinkingValue;
	truncated: boolean;
	outcome: SpawnOutcome;
	stats?: Record<string, number>;
	statsUnavailable?: boolean;
};

type AssistantMessageLike = {
	role: string;
	content?: { type: string; text?: string }[];
};

/**
 * Returns all text blocks from the last assistant message, joined by newlines.
 */
export function getLastAssistantText(messages: AssistantMessageLike[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "assistant") continue;
		const text = (msg.content ?? [])
			.filter((block) => block.type === "text" && typeof block.text === "string")
			.map((block) => block.text ?? "")
			.join("\n")
			.trim();
		if (text) return text;
	}
	return "";
}
