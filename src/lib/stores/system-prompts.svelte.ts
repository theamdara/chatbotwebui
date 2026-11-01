/**
 * systemPromptsStore - library of reusable system prompts (server-stored)
 *
 * The app used to have exactly one global system prompt (`systemMessage`
 * setting), which each new chat baked into its history. This store keeps a
 * named list of prompts in the server SQLite `settings` table (namespaced key
 * `LlamaUi.systemPrompts`) plus a `defaultPromptId` marker, so several
 * personas can coexist and one is picked per new chat from the chat bar.
 * localStorage mirrors the data to seed startup before the RPC round-trip.
 *
 * **Architecture & Relationships:**
 * - **ChatFormActionSystemPrompt**: renders the picker in the chat form
 * - **chatStore.sendMessage**: applies the default prompt when a brand-new
 *   conversation starts (only when one is marked as default)
 */

import { browser } from '$app/environment';
import type { SystemPromptEntry, SystemPromptsSnapshot } from '$lib/types/system-prompts';

const DB_ENDPOINT = 'api/db';
const SETTINGS_KEY = 'LlamaUi.systemPrompts';
const LOCALSTORAGE_KEY = 'LlamaUi.systemPrompts';

let serverAvailable = true;

async function dbRpc(method: string, args: unknown[]): Promise<unknown> {
	const response = await fetch(DB_ENDPOINT, {
		body: JSON.stringify({ args, method }),
		headers: { 'Content-Type': 'application/json' },
		method: 'POST'
	});

	if (!response.ok) throw new Error(`storage endpoint responded ${response.status}`);

	const payload = (await response.json()) as { error?: string; result?: unknown };

	if (payload.error) throw new Error(payload.error);

	return payload.result;
}

function uid(): string {
	return crypto.randomUUID?.() ?? `sp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

class SystemPromptsStore {
	defaultPromptId = $state<string | null>(null);
	prompts = $state<SystemPromptEntry[]>([]);

	/** The prompt applied when the "+" (system message) button is used, if any. */
	get activePrompt(): SystemPromptEntry | null {
		return this.defaultPrompt;
	}

	/** The prompt auto-applied to brand-new chats, or null when none is default. */
	get defaultPrompt(): SystemPromptEntry | null {
		return this.prompts.find((p) => p.id === this.defaultPromptId) ?? null;
	}

	add(name: string, content: string): SystemPromptEntry {
		const entry: SystemPromptEntry = { content: content.trim(), id: uid(), name: name.trim() };

		this.prompts = [...this.prompts, entry];
		this.save();

		return entry;
	}

	/**
	 * Import a prompt only when no existing entry has identical content.
	 * @returns the existing duplicate or the newly created entry
	 */
	addIfNew(name: string, content: string): SystemPromptEntry {
		const trimmed = content.trim();
		const existing = this.prompts.find((p) => p.content === trimmed);

		if (existing) return existing;

		return this.add(name, trimmed);
	}

	/** Synchronous seed from the localStorage mirror; runs at store init. */
	initialize(): void {
		if (!browser) return;

		try {
			const raw = localStorage.getItem(LOCALSTORAGE_KEY);

			if (raw) {
				const parsed = JSON.parse(raw) as SystemPromptsSnapshot;

				this.applySnapshot(parsed);
			}
		} catch {
			// mirror missing or corrupt; the server snapshot will replace it
		}

		void this.loadFromServer();
	}

	remove(id: string): void {
		this.prompts = this.prompts.filter((p) => p.id !== id);

		if (this.defaultPromptId === id) this.defaultPromptId = null;

		this.save();
	}

	/** Mark a prompt as the one new chats start with; pass null to disable. */
	setDefault(id: string | null): void {
		this.defaultPromptId = id && this.prompts.some((p) => p.id === id) ? id : null;
		this.save();
	}

	update(id: string, updates: Partial<Pick<SystemPromptEntry, 'content' | 'name'>>): void {
		this.prompts = this.prompts.map((p) => (p.id === id ? { ...p, ...updates } : p));
		this.save();
	}

	private applySnapshot(snapshot: Partial<SystemPromptsSnapshot>): void {
		if (Array.isArray(snapshot.prompts)) {
			this.prompts = snapshot.prompts.filter(
				(p): p is SystemPromptEntry =>
					!!p && typeof p.id === 'string' && typeof p.content === 'string'
			);
		}

		if (typeof snapshot.defaultPromptId === 'string' || snapshot.defaultPromptId === null) {
			this.defaultPromptId = snapshot.defaultPromptId;
		}
	}

	private async loadFromServer(): Promise<void> {
		if (!serverAvailable) return;

		try {
			const snapshot = (await dbRpc('settingsGetKey', [
				SETTINGS_KEY
			])) as SystemPromptsSnapshot | null;

			if (snapshot && typeof snapshot === 'object') this.applySnapshot(snapshot);
		} catch {
			serverAvailable = false;
		}
	}

	private save(): void {
		if (!browser) return;

		const snapshot: SystemPromptsSnapshot = {
			defaultPromptId: this.defaultPromptId,
			prompts: this.prompts
		};

		try {
			localStorage.setItem(LOCALSTORAGE_KEY, JSON.stringify(snapshot));
		} catch {
			// mirror is best-effort
		}

		if (!serverAvailable) return;

		dbRpc('settingsMerge', [{ [SETTINGS_KEY]: snapshot }]).catch(() => {
			serverAvailable = false;
		});
	}
}

export const systemPromptsStore = new SystemPromptsStore();
