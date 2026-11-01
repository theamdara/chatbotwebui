/**
 * StorageMigrationService - one-time browser -> server SQLite migration
 *
 * The conversation store used to live in IndexedDB (Dexie). It now lives in a
 * real SQLite database on the server (`/api/db`). On the first launch against
 * an empty server store, this service uploads whatever the current browser's
 * IndexedDB still holds, so existing conversations survive the switch. The
 * IndexedDB copy is left untouched for downgrade safety. State is tracked in
 * localStorage so the migration runs exactly once per browser.
 */

import { IDXDB_STORES, IDXDB_TABLES, STORAGE_APP_NAME } from '$lib/constants';
import type { DatabaseConversation, DatabaseMessage } from '$lib/types/database';
import Dexie from 'dexie';

const MIGRATION_STATE_KEY = 'LlamaUi.storage-migration-state';
const CONVERSATIONS_TO_SQLITE_ID = 'conversations-to-sqlite-v1';
const ENDPOINT = 'api/db';

async function dbRpc(method: string, args: unknown[]): Promise<unknown> {
	const response = await fetch(ENDPOINT, {
		body: JSON.stringify({ args, method }),
		headers: { 'Content-Type': 'application/json' },
		method: 'POST'
	});

	if (!response.ok) throw new Error(`storage endpoint responded ${response.status}`);

	const payload = (await response.json()) as { error?: string; result?: unknown };

	if (payload.error) throw new Error(payload.error);

	return payload.result;
}

function isCompleted(): boolean {
	try {
		const raw = localStorage.getItem(MIGRATION_STATE_KEY);

		return raw ? (JSON.parse(raw).completed ?? []).includes(CONVERSATIONS_TO_SQLITE_ID) : false;
	} catch {
		return false;
	}
}

function markCompleted(): void {
	try {
		const raw = localStorage.getItem(MIGRATION_STATE_KEY);
		const state = raw ? JSON.parse(raw) : { completed: [] };

		state.completed = [...new Set([...(state.completed ?? []), CONVERSATIONS_TO_SQLITE_ID])];
		localStorage.setItem(MIGRATION_STATE_KEY, JSON.stringify(state));
	} catch {
		// best-effort: worst case the (idempotent) upload runs again
	}
}

export class StorageMigrationService {
	/**
	 * Upload browser-held conversations to the server SQLite store when that
	 * store is still empty. Never deletes the IndexedDB copy, and skips
	 * silently when there is no endpoint, no local data, or the migration
	 * already ran in this browser.
	 */
	static async migrateConversationsToSqlite(): Promise<void> {
		if (isCompleted()) return;

		let serverCount: number;

		try {
			const response = await fetch(`${ENDPOINT}/stats`);

			if (!response.ok) return;

			serverCount = ((await response.json()) as { conversations?: number }).conversations ?? 0;
		} catch {
			// no storage endpoint on this deployment: nothing to do
			return;
		}

		if (serverCount > 0) {
			markCompleted();

			return;
		}

		const local = await StorageMigrationService.readIndexedDb();

		if (local.length === 0) {
			markCompleted();

			return;
		}

		try {
			await dbRpc('importConversations', [local]);
			markCompleted();
			console.info(
				`[StorageMigration] uploaded ${local.length} conversation(s) from IndexedDB to SQLite`
			);
		} catch (error) {
			console.error('[StorageMigration] failed to upload conversations:', error);
		}
	}

	/** Read every conversation with its messages straight out of Dexie. */
	private static async readIndexedDb(): Promise<
		{ conv: DatabaseConversation; messages: DatabaseMessage[] }[]
	> {
		const legacy = new Dexie(STORAGE_APP_NAME);

		legacy.version(1).stores(IDXDB_STORES);

		try {
			const conversations = (await legacy
				.table(IDXDB_TABLES.conversations)
				.toArray()) as DatabaseConversation[];

			if (conversations.length === 0) return [];

			const out: { conv: DatabaseConversation; messages: DatabaseMessage[] }[] = [];

			for (const conv of conversations) {
				const messages = (await legacy
					.table(IDXDB_TABLES.messages)
					.where('convId')
					.equals(conv.id)
					.toArray()) as DatabaseMessage[];

				out.push({ conv, messages });
			}

			return out;
		} catch {
			// the legacy database may not exist at all on a fresh browser
			return [];
		} finally {
			legacy.close();
		}
	}
}
