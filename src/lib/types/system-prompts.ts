/**
 * Types for the reusable system-prompt library (systemPromptsStore).
 */

export interface SystemPromptEntry {
	content: string;
	id: string;
	name: string;
}

export interface SystemPromptsSnapshot {
	/** Prompt auto-applied to brand-new chats, or null when selection is explicit. */
	defaultPromptId: string | null;
	prompts: SystemPromptEntry[];
}
