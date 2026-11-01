#!/usr/bin/env node
/**
 * SQLite persistence layer for chatbot-webui.
 *
 * Stores conversations, messages and app settings in a real SQLite file on
 * the server instead of the browser (IndexedDB/localStorage). The browser
 * talks to it through a small JSON-RPC endpoint (`/api/db`) that mirrors the
 * client-side DatabaseService surface one-to-one: every DatabaseService
 * method becomes an RPC `method` with positional `args`, so the client proxy
 * in src/lib/services/database.service.ts is a thin pass-through and the
 * whole app keeps working unchanged.
 *
 * Rows are stored as JSON documents (id + indexed scalar columns for the few
 * hot queries). That preserves the evolving document shape of conversations
 * and messages without migrations, while keeping relational integrity where
 * it matters (foreign-key cascade deletes, per-conversation lookups).
 *
 * Used by server.mjs. Requires Node >= 22.5 (built-in `node:sqlite`).
 */
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS conversations (
	id             TEXT PRIMARY KEY,
	data           TEXT NOT NULL,          -- full DatabaseConversation JSON
	lastModified   INTEGER NOT NULL,
	forkedFrom     TEXT,                   -- indexed copy of forkedFromConversationId
	pinned         INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_conversations_last_modified ON conversations(lastModified);
CREATE INDEX IF NOT EXISTS idx_conversations_forked_from   ON conversations(forkedFrom);

CREATE TABLE IF NOT EXISTS messages (
	id      TEXT PRIMARY KEY,
	convId  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
	data    TEXT NOT NULL,                 -- full DatabaseMessage JSON
	timestamp INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_conv_time ON messages(convId, timestamp);

CREATE TABLE IF NOT EXISTS settings (
	key   TEXT PRIMARY KEY,
	value TEXT NOT NULL                    -- JSON-encoded value
);
`;

/** Rows -> objects. */
function rowToConversation(row) {
	return JSON.parse(row.data);
}

function rowToMessage(row) {
	return JSON.parse(row.data);
}

/** Serialize only the columns we index; the document keeps everything else. */
function conversationRow(conv) {
	return [
		conv.id,
		JSON.stringify(conv),
		conv.lastModified ?? 0,
		conv.forkedFromConversationId ?? null,
		conv.pinned ? 1 : 0
	];
}

export class ChatStore {
	bulkDeleteConversations(ids) {
		const cleanIds = ids.filter((id) => typeof id === 'string' && id.length > 0);

		if (cleanIds.length === 0) return;

		this.#tx(() => {
			const idSet = new Set(cleanIds);

			for (const id of cleanIds) {
				this.#reparentDirectChildren(id, idSet);
			}

			// FK cascade removes the messages
			const del = this.db.prepare('DELETE FROM conversations WHERE id = ?');

			for (const id of cleanIds) del.run(id);
		});
	}

	// ---------------------------------------------------------------- helpers

	bulkToggleConversationPins(ids) {
		const result = {};

		for (const id of ids) {
			try {
				result[id] = this.toggleConversationPin(id);
			} catch {
				// missing rows are skipped, matching the Dexie version
			}
		}

		return result;
	}

	constructor(dbPath) {
		this.db = new DatabaseSync(dbPath);
		this.db.exec(SCHEMA);
	}

	createConversation(name, fields = {}) {
		const conversation = {
			currNode: '',
			id: crypto.randomUUID(),
			lastModified: Date.now(),
			name,
			...fields
		};

		this.#put('conversations', conversation.id, conversation);

		return conversation;
	}

	createMessageBranch(message, parentId) {
		return this.#tx(() => {
			if (parentId !== null) {
				const parent = this.#get('messages', parentId);

				if (!parent) throw new Error(`Parent message ${parentId} not found`);
			}

			const newMessage = {
				...message,
				children: [],
				id: crypto.randomUUID(),
				parent: parentId,
				toolCalls: message.toolCalls ?? ''
			};

			this.#put('messages', newMessage.id, newMessage);

			if (parentId !== null) this.#addChildToParent(parentId, newMessage.id);

			this.updateConversation(message.convId, { currNode: newMessage.id });

			return newMessage;
		});
	}

	createRootMessage(convId) {
		const rootMessage = {
			children: [],
			content: '',
			convId,
			id: crypto.randomUUID(),
			parent: null,
			role: 'system',
			timestamp: Date.now(),
			toolCalls: '',
			type: 'root'
		};

		this.#put('messages', rootMessage.id, rootMessage);

		return rootMessage.id;
	}

	// ---------------------------------------------------------- conversations

	createSystemMessage(convId, systemPrompt, parentId) {
		const trimmedPrompt = String(systemPrompt).trim();

		if (!trimmedPrompt) throw new Error('Cannot create system message with empty content');

		return this.#tx(() => {
			const parent = this.#get('messages', parentId);

			if (!parent) throw new Error(`Parent message ${parentId} not found`);

			const systemMessage = {
				children: [],
				content: trimmedPrompt,
				convId,
				id: crypto.randomUUID(),
				parent: parentId,
				role: 'system',
				timestamp: Date.now(),
				type: 'system'
			};

			this.#put('messages', systemMessage.id, systemMessage);
			this.#addChildToParent(parentId, systemMessage.id);

			return systemMessage;
		});
	}

	deleteConversation(id, options) {
		this.#tx(() => {
			if (options?.deleteWithForks) {
				const queue = [id];

				while (queue.length > 0) {
					const parentId = queue.pop();

					for (const child of this.#childrenOf(parentId)) {
						queue.push(child.id);
					}
				}

				// FK cascade removes the messages of every fork
				this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
			} else {
				this.#reparentDirectChildren(id, new Set());
				this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
			}
		});
	}

	deleteMessage(messageId) {
		this.#tx(() => {
			const message = this.#get('messages', messageId);

			if (!message) return;

			this.#removeChildFromParent(messageId);
			this.db.prepare('DELETE FROM messages WHERE id = ?').run(messageId);
		});
	}

	deleteMessageCascading(conversationId, messageId) {
		return this.#tx(() => {
			const all = this.getConversationMessages(conversationId);
			const childrenOf = new Map(all.map((m) => [m.id, m.children ?? []]));
			const toDelete = [messageId];

			for (let i = 0; i < toDelete.length; i++) {
				toDelete.push(...(childrenOf.get(toDelete[i]) ?? []));
			}

			this.#removeChildFromParent(messageId);

			const del = this.db.prepare('DELETE FROM messages WHERE id = ?');

			for (const id of toDelete) del.run(id);

			return toDelete;
		});
	}

	forkConversation(sourceConvId, atMessageId, options) {
		return this.#tx(() => {
			const sourceConv = this.#get('conversations', sourceConvId);

			if (!sourceConv) throw new Error(`Source conversation ${sourceConvId} not found`);

			const allMessages = this.getConversationMessages(sourceConvId);
			const byId = new Map(allMessages.map((m) => [m.id, m]));
			const path = [];

			let node = byId.get(atMessageId);

			if (!node) throw new Error(`Could not resolve message path to ${atMessageId}`);

			while (node) {
				path.unshift(node);
				node = node.parent ? byId.get(node.parent) : undefined;
			}

			const idMap = new Map(path.map((m) => [m.id, crypto.randomUUID()]));
			const newConvId = crypto.randomUUID();
			const cloned = path.map((msg) => {
				const newId = idMap.get(msg.id);
				const newParent = msg.parent ? (idMap.get(msg.parent) ?? null) : null;
				const newChildren = (msg.children ?? [])
					.filter((childId) => idMap.has(childId))
					.map((childId) => idMap.get(childId));

				return {
					...msg,
					children: newChildren,
					convId: newConvId,
					extra: options.includeAttachments ? msg.extra : undefined,
					id: newId,
					parent: newParent
				};
			});
			const last = cloned[cloned.length - 1];
			const newConv = {
				currNode: last.id,
				cwd: sourceConv.cwd,
				forkedFromConversationId: sourceConvId,
				id: newConvId,
				lastModified: Date.now(),
				mcpServerOverrides: sourceConv.mcpServerOverrides?.map((o) => ({
					enabled: o.enabled,
					serverId: o.serverId
				})),
				name: options.name
			};

			this.#put('conversations', newConv.id, newConv);

			for (const msg of cloned) this.#put('messages', msg.id, msg);

			return newConv;
		});
	}

	getAllConversations() {
		return this.db
			.prepare('SELECT data FROM conversations ORDER BY lastModified DESC')
			.all()
			.map(rowToConversation);
	}

	getConversation(id) {
		return this.#get('conversations', id) ?? null;
	}

	getConversationMessages(convId) {
		return this.db
			.prepare('SELECT data FROM messages WHERE convId = ? ORDER BY timestamp ASC')
			.all(convId)
			.map(rowToMessage);
	}

	getConversationsWithMessages(convIds) {
		const cleanIds = convIds.filter((id) => typeof id === 'string' && id.length > 0);
		const result = {};

		if (cleanIds.length === 0) return result;

		const placeholders = cleanIds.map(() => '?').join(',');
		const convs = this.db
			.prepare(`SELECT data FROM conversations WHERE id IN (${placeholders})`)
			.all(...cleanIds);
		const msgs = this.db
			.prepare(`SELECT data FROM messages WHERE convId IN (${placeholders}) ORDER BY timestamp ASC`)
			.all(...cleanIds);

		for (const conv of convs.map(rowToConversation)) result[conv.id] = { conv, messages: [] };
		for (const msg of msgs.map(rowToMessage)) result[msg.convId]?.messages.push(msg);

		return result;
	}

	importConversations(data) {
		const imported = [];
		const skipped = [];

		this.#tx(() => {
			for (const { conv, messages } of data) {
				if (this.#get('conversations', conv.id)) {
					skipped.push(conv);

					continue;
				}

				this.#put('conversations', conv.id, conv);

				for (const msg of messages) this.#put('messages', msg.id, msg);

				imported.push(conv);
			}
		});

		return { imported, skipped };
	}

	settingsClear() {
		this.db.exec('DELETE FROM settings');
	}

	settingsGet() {
		const rows = this.db.prepare('SELECT key, value FROM settings').all();
		const out = {};

		for (const row of rows) out[row.key] = JSON.parse(row.value);

		return out;
	}

	// ---------------------------------------------------------------- messages

	settingsGetKey(key) {
		const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key);

		return row ? JSON.parse(row.value) : null;
	}

	settingsMerge(updates) {
		this.#tx(() => {
			for (const [key, value] of Object.entries(updates)) this.settingsSet(key, value);
		});
	}

	settingsSet(key, value) {
		this.db
			.prepare(
				'INSERT INTO settings(key, value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
			)
			.run(key, JSON.stringify(value));
	}

	stats() {
		return {
			conversations: this.db.prepare('SELECT COUNT(*) AS n FROM conversations').get().n,
			messages: this.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n,
			settingsKeys: this.db.prepare('SELECT COUNT(*) AS n FROM settings').get().n
		};
	}

	toggleConversationPin(id) {
		const conv = this.#get('conversations', id);

		if (!conv) throw new Error(`Conversation ${id} not found`);

		const pinned = !conv.pinned;

		this.updateConversation(id, { pinned });

		return pinned;
	}

	updateConversation(id, updates) {
		this.#update('conversations', id, updates);
	}

	updateCurrentNode(convId, nodeId) {
		this.updateConversation(convId, { currNode: nodeId });
	}

	updateMessage(id, updates) {
		this.#update('messages', id, updates);
	}

	#addChildToParent(parentId, childId) {
		const parent = this.#get('messages', parentId);

		if (!parent) return;

		this.updateMessage(parentId, { children: [...(parent.children ?? []), childId] });
	}

	#childrenOf(convId) {
		return this.db
			.prepare('SELECT data FROM conversations WHERE forkedFrom = ?')
			.all(convId)
			.map((r) => JSON.parse(r.data));
	}

	#get(table, id) {
		const row = this.db.prepare(`SELECT data FROM ${table} WHERE id = ?`).get(id);

		return row ? JSON.parse(row.data) : undefined;
	}

	// -------------------------------------------------------------- settings

	#put(table, id, value) {
		if (table === 'conversations') {
			this.db
				.prepare(
					`INSERT INTO conversations(id, data, lastModified, forkedFrom, pinned)
					 VALUES(?,?,?,?,?)
					 ON CONFLICT(id) DO UPDATE SET data=excluded.data, lastModified=excluded.lastModified, forkedFrom=excluded.forkedFrom, pinned=excluded.pinned`
				)
				.run(...conversationRow(value));
		} else {
			this.db
				.prepare(
					`INSERT INTO messages(id, convId, data, timestamp)
					 VALUES(?,?,?,?)
					 ON CONFLICT(id) DO UPDATE SET convId=excluded.convId, data=excluded.data, timestamp=excluded.timestamp`
				)
				.run(id, value.convId, JSON.stringify(value), value.timestamp ?? 0);
		}
	}

	#removeChildFromParent(messageId) {
		const message = this.#get('messages', messageId);

		if (!message?.parent) return;

		const parent = this.#get('messages', message.parent);

		if (!parent) return;

		this.updateMessage(parent.id, {
			children: (parent.children ?? []).filter((c) => c !== messageId)
		});
	}

	#reparentDirectChildren(parentId, excludeIds) {
		const conv = this.#get('conversations', parentId);

		if (!conv) return;

		let newParent = conv.forkedFromConversationId;

		const visited = new Set([parentId]);

		while (newParent && excludeIds.has(newParent)) {
			if (visited.has(newParent)) {
				newParent = undefined;

				break;
			}

			visited.add(newParent);

			const next = this.#get('conversations', newParent);

			if (!next) {
				newParent = undefined;

				break;
			}

			newParent = next.forkedFromConversationId;
		}

		for (const child of this.#childrenOf(parentId)) {
			if (excludeIds.has(child.id)) continue;

			this.#put('conversations', child.id, { ...child, forkedFromConversationId: newParent });
		}
	}

	/** Run `fn` inside one transaction, mirroring Dexie's db.transaction. */
	#tx(fn) {
		this.db.exec('BEGIN');

		try {
			const result = fn();

			this.db.exec('COMMIT');

			return result;
		} catch (e) {
			this.db.exec('ROLLBACK');

			throw e;
		}
	}

	#update(table, id, updates) {
		const current = this.#get(table, id);

		if (!current) return false;

		const merged = { ...current, ...updates };

		this.#put(table, id, merged);

		return true;
	}
}
