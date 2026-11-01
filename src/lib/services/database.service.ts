/**
 * DatabaseService - conversation/message persistence, backed by server SQLite
 *
 * Thin JSON-RPC client over the `/api/db` endpoint implemented in db.mjs /
 * server.mjs. Every method maps one-to-one onto a ChatStore method with
 * positional arguments, so the app's chat and conversation flows keep working
 * exactly as they did when this layer was Dexie/IndexedDB. Rows come back as
 * plain JSON documents; transactions are executed atomically server-side.
 *
 * When no storage endpoint is reachable (e.g. a dev server without /api/db),
 * the first failed call logs once and switches to an in-memory fallback so
 * the UI stays usable — data then only lives for the page's lifetime.
 */

import { MessageRole } from '$lib/enums';
import type { ExportedConversation } from '$lib/types/database';
import { filterByLeafNodeId, findDescendantMessages, uuid } from '$lib/utils';

const ENDPOINT = 'api/db';

type RpcMethod =
	| 'getAllConversations'
	| 'getConversation'
	| 'createConversation'
	| 'updateConversation'
	| 'updateCurrentNode'
	| 'toggleConversationPin'
	| 'bulkToggleConversationPins'
	| 'deleteConversation'
	| 'bulkDeleteConversations'
	| 'forkConversation'
	| 'getConversationsWithMessages'
	| 'importConversations'
	| 'getConversationMessages'
	| 'createRootMessage'
	| 'createSystemMessage'
	| 'createMessageBranch'
	| 'updateMessage'
	| 'deleteMessage'
	| 'deleteMessageCascading';

let serverAvailable = true;
let fallbackWarned = false;

async function rpc<T>(method: RpcMethod, args: unknown[]): Promise<T> {
	if (serverAvailable) {
		try {
			const response = await fetch(ENDPOINT, {
				body: JSON.stringify({ args, method }),
				headers: { 'Content-Type': 'application/json' },
				method: 'POST'
			});

			if (!response.ok) throw new Error(`storage endpoint responded ${response.status}`);

			const payload = (await response.json()) as { error?: string; result?: T };

			if (payload.error) throw new Error(payload.error);

			return payload.result as T;
		} catch (error) {
			serverAvailable = false;

			if (!fallbackWarned) {
				fallbackWarned = true;
				console.warn(
					'[DatabaseService] server storage (/api/db) unavailable, falling back to in-memory storage:',
					error
				);
			}
		}
	}

	// biome-ignore lint: the map's concrete signatures are checked by construction
	return (MemoryBackend[method] as (...a: unknown[]) => unknown)(...args) as T;
}

/**
 * In-memory stand-in used only when the server has no /api/db endpoint. It
 * implements the same semantics as ChatStore (message tree, fork reparenting,
 * cascading deletes) over plain Maps so the app keeps working without a
 * persistent store. Data is lost on reload — nothing more.
 */
const conversations = new Map<string, DatabaseConversation>();
const messages = new Map<string, DatabaseMessage>();
// Loose map on purpose: rpc() is the only caller and casts at the boundary.
/* eslint-disable @typescript-eslint/no-explicit-any */
const MemoryBackend: Record<RpcMethod, (...args: any[]) => any> = {
	bulkDeleteConversations: (ids: string[]) => {
		const cleanIds = ids.filter((id) => typeof id === 'string' && id.length > 0);
		const idSet = new Set(cleanIds);

		for (const id of cleanIds) reparentDirectChildren(id, idSet);

		for (const id of cleanIds) {
			conversations.delete(id);

			for (const [msgId, msg] of messages) if (msg.convId === id) messages.delete(msgId);
		}
	},

	bulkToggleConversationPins: (ids: string[]) => {
		const result: Record<string, boolean> = {};

		for (const id of ids) {
			try {
				result[id] = MemoryBackend.toggleConversationPin(id) as boolean;
			} catch {
				// missing rows are skipped
			}
		}

		return result;
	},

	createConversation: (name: string, fields: Record<string, unknown> = {}) => {
		const conversation: DatabaseConversation = {
			currNode: '',
			id: uuid(),
			lastModified: Date.now(),
			name,
			...fields
		};

		conversations.set(conversation.id, conversation);

		return conversation;
	},

	createMessageBranch: (message: Omit<DatabaseMessage, 'id'>, parentId: string | null) => {
		if (parentId !== null && !messages.get(parentId)) {
			throw new Error(`Parent message ${parentId} not found`);
		}

		const newMessage: DatabaseMessage = {
			...message,
			children: [],
			id: uuid(),
			parent: parentId,
			toolCalls: message.toolCalls ?? ''
		};

		messages.set(newMessage.id, newMessage);

		if (parentId !== null) {
			const parent = messages.get(parentId)!;

			parent.children = [...(parent.children ?? []), newMessage.id];
		}

		MemoryBackend.updateCurrentNode(message.convId, newMessage.id);

		return newMessage;
	},

	createRootMessage: (convId: string) => {
		const rootMessage: DatabaseMessage = {
			children: [],
			content: '',
			convId,
			id: uuid(),
			parent: null,
			role: MessageRole.SYSTEM,
			timestamp: Date.now(),
			toolCalls: '',
			type: 'root'
		};

		messages.set(rootMessage.id, rootMessage);

		return rootMessage.id;
	},

	createSystemMessage: (convId: string, systemPrompt: string, parentId: string) => {
		const trimmedPrompt = systemPrompt.trim();

		if (!trimmedPrompt) throw new Error('Cannot create system message with empty content');

		const parent = messages.get(parentId);

		if (!parent) throw new Error(`Parent message ${parentId} not found`);

		const systemMessage: DatabaseMessage = {
			children: [],
			content: trimmedPrompt,
			convId,
			id: uuid(),
			parent: parentId,
			role: MessageRole.SYSTEM,
			timestamp: Date.now(),
			type: MessageRole.SYSTEM
		};

		messages.set(systemMessage.id, systemMessage);
		parent.children = [...(parent.children ?? []), systemMessage.id];

		return systemMessage;
	},

	deleteConversation: (id: string, options?: { deleteWithForks?: boolean }) => {
		if (options?.deleteWithForks) {
			const queue = [id];

			while (queue.length > 0) {
				const parentId = queue.pop()!;

				for (const child of [...conversations.values()].filter(
					(c) => c.forkedFromConversationId === parentId
				)) {
					queue.push(child.id);
				}
			}
		} else {
			reparentDirectChildren(id, new Set());
		}

		conversations.delete(id);

		for (const [msgId, msg] of messages) if (msg.convId === id) messages.delete(msgId);
	},

	deleteMessage: (messageId: string) => {
		const message = messages.get(messageId);

		if (!message) return;

		const parent = message.parent ? messages.get(message.parent) : undefined;

		if (parent) parent.children = (parent.children ?? []).filter((c: string) => c !== messageId);

		messages.delete(messageId);
	},

	deleteMessageCascading: (conversationId: string, messageId: string) => {
		const allMessages: DatabaseMessage[] = MemoryBackend.getConversationMessages(conversationId);
		const descendants = findDescendantMessages(allMessages, messageId);
		const allToDelete = [messageId, ...descendants];

		MemoryBackend.deleteMessage(messageId);

		for (const id of allToDelete) messages.delete(id);

		return allToDelete;
	},

	forkConversation: (
		sourceConvId: string,
		atMessageId: string,
		options: { name: string; includeAttachments: boolean }
	) => {
		const sourceConv = conversations.get(sourceConvId);

		if (!sourceConv) throw new Error(`Source conversation ${sourceConvId} not found`);

		const allMessages: DatabaseMessage[] = MemoryBackend.getConversationMessages(sourceConvId);
		const pathMessages = filterByLeafNodeId(allMessages, atMessageId, true) as DatabaseMessage[];

		if (pathMessages.length === 0)
			throw new Error(`Could not resolve message path to ${atMessageId}`);

		const idMap = new Map(pathMessages.map((m) => [m.id, uuid()]));
		const newConvId = uuid();
		const cloned: DatabaseMessage[] = pathMessages.map((msg) => ({
			...msg,
			children: (msg.children ?? [])
				.filter((c: string) => idMap.has(c))
				.map((c: string) => idMap.get(c)!),
			convId: newConvId,
			extra: options.includeAttachments ? msg.extra : undefined,
			id: idMap.get(msg.id)!,
			parent: msg.parent ? (idMap.get(msg.parent) ?? null) : null
		}));

		for (const msg of cloned) messages.set(msg.id, msg);

		const newConv: DatabaseConversation = {
			currNode: cloned[cloned.length - 1].id,
			cwd: sourceConv.cwd,
			forkedFromConversationId: sourceConvId,
			id: newConvId,
			lastModified: Date.now(),
			mcpServerOverrides: sourceConv.mcpServerOverrides?.map(
				(o: { enabled: boolean; serverId: string }) => ({
					enabled: o.enabled,
					serverId: o.serverId
				})
			),
			name: options.name
		};

		conversations.set(newConv.id, newConv);

		return newConv;
	},

	getAllConversations: () =>
		[...conversations.values()].sort((a, b) => b.lastModified - a.lastModified),

	getConversation: (id: string) => conversations.get(id) ?? null,

	getConversationMessages: (convId: string) =>
		[...messages.values()]
			.filter((m) => m.convId === convId)
			.sort((a, b) => a.timestamp - b.timestamp),

	getConversationsWithMessages: (convIds: string[]) => {
		const result: Record<string, ExportedConversation> = {};

		for (const id of convIds) {
			const conv = conversations.get(id);

			if (conv) result[id] = { conv, messages: MemoryBackend.getConversationMessages(id) };
		}

		return result;
	},

	importConversations: (data: { conv: DatabaseConversation; messages: DatabaseMessage[] }[]) => {
		const imported: DatabaseConversation[] = [];
		const skipped: DatabaseConversation[] = [];

		for (const item of data) {
			if (conversations.has(item.conv.id)) {
				skipped.push(item.conv);

				continue;
			}

			conversations.set(item.conv.id, item.conv);

			for (const msg of item.messages) messages.set(msg.id, msg);

			imported.push(item.conv);
		}

		return { imported, skipped };
	},

	toggleConversationPin: (id: string) => {
		const conv = conversations.get(id);

		if (!conv) throw new Error(`Conversation ${id} not found`);

		conv.pinned = !conv.pinned;

		return conv.pinned;
	},

	updateConversation: (id: string, updates: Partial<DatabaseConversation>) => {
		const conv = conversations.get(id);

		if (conv) conversations.set(id, { ...conv, ...updates });
	},

	updateCurrentNode: (convId: string, nodeId: string) => {
		const conv = conversations.get(convId);

		if (conv) conversations.set(convId, { ...conv, currNode: nodeId });
	},

	updateMessage: (id: string, updates: Partial<DatabaseMessage>) => {
		const msg = messages.get(id);

		if (msg) messages.set(id, { ...msg, ...updates });
	}
};

function reparentDirectChildren(parentId: string, excludeIds: ReadonlySet<string>): void {
	const conv = conversations.get(parentId);

	if (!conv) return;

	let newParent = conv.forkedFromConversationId;

	const visited = new Set([parentId]);

	while (newParent && excludeIds.has(newParent)) {
		if (visited.has(newParent)) {
			newParent = undefined;

			break;
		}

		visited.add(newParent);

		const next = conversations.get(newParent);

		if (!next) {
			newParent = undefined;

			break;
		}

		newParent = next.forkedFromConversationId;
	}

	for (const child of conversations.values()) {
		if (child.forkedFromConversationId !== parentId) continue;

		if (excludeIds.has(child.id)) continue;

		conversations.set(child.id, { ...child, forkedFromConversationId: newParent });
	}
}

export class DatabaseService {
	static async bulkDeleteConversations(ids: string[]): Promise<void> {
		await rpc('bulkDeleteConversations', [ids]);
	}

	static async bulkToggleConversationPins(ids: string[]): Promise<Map<string, boolean>> {
		const record = await rpc<Record<string, boolean>>('bulkToggleConversationPins', [ids]);

		return new Map(Object.entries(record ?? {}));
	}

	static async createConversation(
		name: string,
		fields?: Partial<Omit<DatabaseConversation, 'id' | 'name' | 'lastModified'>>
	): Promise<DatabaseConversation> {
		return await rpc('createConversation', [name, fields]);
	}

	static async createMessageBranch(
		message: Omit<DatabaseMessage, 'id'>,
		parentId: string | null
	): Promise<DatabaseMessage> {
		return await rpc('createMessageBranch', [message, parentId]);
	}

	static async createRootMessage(convId: string): Promise<string> {
		return await rpc('createRootMessage', [convId]);
	}

	static async createSystemMessage(
		convId: string,
		systemPrompt: string,
		parentId: string
	): Promise<DatabaseMessage> {
		return await rpc('createSystemMessage', [convId, systemPrompt, parentId]);
	}

	static async deleteConversation(
		id: string,
		options?: { deleteWithForks?: boolean }
	): Promise<void> {
		await rpc('deleteConversation', [id, options]);
	}

	static async deleteMessage(messageId: string): Promise<void> {
		await rpc('deleteMessage', [messageId]);
	}

	static async deleteMessageCascading(
		conversationId: string,
		messageId: string
	): Promise<string[]> {
		return (await rpc<string[]>('deleteMessageCascading', [conversationId, messageId])) ?? [];
	}

	static async forkConversation(
		sourceConvId: string,
		atMessageId: string,
		options: { name: string; includeAttachments: boolean }
	): Promise<DatabaseConversation> {
		return await rpc('forkConversation', [sourceConvId, atMessageId, options]);
	}

	static async getAllConversations(): Promise<DatabaseConversation[]> {
		return (await rpc<DatabaseConversation[]>('getAllConversations', [])) ?? [];
	}

	static async getConversation(id: string): Promise<DatabaseConversation | undefined> {
		return (await rpc<DatabaseConversation | null>('getConversation', [id])) ?? undefined;
	}

	static async getConversationMessages(convId: string): Promise<DatabaseMessage[]> {
		return (await rpc<DatabaseMessage[]>('getConversationMessages', [convId])) ?? [];
	}

	static async getConversationsWithMessages(
		convIds: string[]
	): Promise<Map<string, ExportedConversation>> {
		const record = await rpc<Record<string, ExportedConversation> | null>(
			'getConversationsWithMessages',
			[convIds]
		);

		return new Map(Object.entries(record ?? {}));
	}

	static async importConversations(
		data: { conv: DatabaseConversation; messages: DatabaseMessage[] }[]
	): Promise<{
		imported: DatabaseConversation[];
		skipped: DatabaseConversation[];
	}> {
		return (await rpc('importConversations', [data])) ?? { imported: [], skipped: [] };
	}

	static async toggleConversationPin(id: string): Promise<boolean> {
		return await rpc('toggleConversationPin', [id]);
	}

	static async updateConversation(
		id: string,
		updates: Partial<Omit<DatabaseConversation, 'id'>>
	): Promise<void> {
		await rpc('updateConversation', [id, updates]);
	}

	static async updateCurrentNode(convId: string, nodeId: string): Promise<void> {
		await rpc('updateCurrentNode', [convId, nodeId]);
	}

	static async updateMessage(
		id: string,
		updates: Partial<Omit<DatabaseMessage, 'id'>>
	): Promise<void> {
		await rpc('updateMessage', [id, updates]);
	}
}
