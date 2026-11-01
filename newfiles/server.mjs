#!/usr/bin/env node
/**
 * Static preview server for the built chatbot-webui, with an API proxy.
 *
 * Serves dist/ and proxies backend paths (/v1/*, /props, /models, /slots,
 * /tools, /cors-proxy) to the same origin, so the browser never makes
 * cross-origin calls. This makes the UI work against backends that send no
 * CORS headers (plain python/shell servers, embedded devices, ...). When your
 * API provider does support CORS you can skip this and serve dist/ from any
 * static host with DSH_API_ORIGIN pointing at the backend.
 *
 * Usage:
 *   node server.mjs [distDir]
 *
 * Configuration (environment):
 *   PORT          port to listen on                (default 5173)
 *   HOST          bind address                     (default 0.0.0.0)
 *   API_TARGET    backend origin or /v1 base URL   (default http://localhost:8080)
 *   DB_PATH       SQLite file for conversations/settings
 *                 (default <distDir>/../chatbot-webui.db; ':memory:' for ephemeral)
 *
 * The backend target can also be set at runtime in the UI settings ("API URL"
 * field); the proxy only matters for same-origin mode, i.e. when the browser
 * talks to this server directly.
 *
 * SQLite storage: conversations, messages and settings live in a real SQLite
 * database on this server (built-in node:sqlite), exposed to the UI through a
 * JSON-RPC endpoint at POST /api/db. The client DatabaseService proxies its
 * calls there instead of IndexedDB. GET /api/db/stats returns row counts.
 */
import { ChatStore } from './db.mjs';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { extname, join, normalize, resolve } from 'node:path';

const DIST = resolve(process.argv[2] ?? 'dist');
const PORT = Number(process.env.PORT ?? 5173);
const HOST = process.env.HOST ?? '0.0.0.0';
const DB_PATH = process.env.DB_PATH ?? resolve(DIST, '..', 'chatbot-webui.db');
const store = new ChatStore(DB_PATH);
// Methods exposed over /api/db (mirrors the client DatabaseService surface).
const RPC_METHODS = new Set([
	'getAllConversations',
	'getConversation',
	'createConversation',
	'updateConversation',
	'updateCurrentNode',
	'toggleConversationPin',
	'bulkToggleConversationPins',
	'deleteConversation',
	'bulkDeleteConversations',
	'forkConversation',
	'getConversationsWithMessages',
	'importConversations',
	'getConversationMessages',
	'createRootMessage',
	'createSystemMessage',
	'createMessageBranch',
	'updateMessage',
	'deleteMessage',
	'deleteMessageCascading',
	'settingsGet',
	'settingsGetKey',
	'settingsSet',
	'settingsMerge',
	'settingsClear'
]);

function handleDbRpc(req, res) {
	const url = new URL(req.url, 'http://localhost');

	if (req.method === 'GET' && url.pathname === '/api/db/stats') {
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify(store.stats()));

		return;
	}

	if (req.method !== 'POST') {
		res.writeHead(405).end();

		return;
	}

	let body = '';

	req.on('data', (chunk) => {
		body += chunk;

		// 64 MB cap: message rows carry base64 attachments
		if (body.length > 64 * 1024 * 1024) {
			res.writeHead(413).end();
			req.destroy();
		}
	});

	req.on('end', () => {
		let parsed;

		try {
			parsed = JSON.parse(body);
		} catch {
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'invalid JSON' }));

			return;
		}

		const { args = [], method } = parsed ?? {};

		if (typeof method !== 'string' || !RPC_METHODS.has(method) || !Array.isArray(args)) {
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: `unknown method: ${String(method)}` }));

			return;
		}

		try {
			const result = store[method](...args);

			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ result: result ?? null }));
		} catch (e) {
			res.writeHead(500, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: String(e?.message ?? e) }));
		}
	});
}

function normalizeTarget(raw) {
	let t = (raw || 'http://localhost:8080').trim();

	if (!t) return null;

	if (t.toLowerCase().endsWith('/v1')) t = t.slice(0, -3);

	t = t.replace(/\/+$/, '');

	if (!/^https?:\/\//i.test(t)) {
		console.error(`API_TARGET is not an http(s) URL: ${raw}`);

		return null;
	}

	return new URL(t);
}

const API_TARGET = normalizeTarget(process.env.API_TARGET);
const MIME = {
	'.css': 'text/css',
	'.gif': 'image/gif',
	'.html': 'text/html; charset=utf-8',
	'.ico': 'image/x-icon',
	'.jpg': 'image/jpeg',
	'.js': 'text/javascript',
	'.json': 'application/json',
	'.map': 'application/json',
	'.md': 'text/markdown',
	'.png': 'image/png',
	'.svg': 'image/svg+xml',
	'.ttf': 'font/ttf',
	'.webmanifest': 'application/manifest+json',
	'.webp': 'image/webp',
	'.woff': 'font/woff',
	'.woff2': 'font/woff2'
};
const API_PATH_SEGMENTS = ['/v1/', '/props', '/models', '/slots', '/tools', '/cors-proxy'];

function isApiPath(pathname) {
	return API_PATH_SEGMENTS.some((s) => pathname === s.replace(/\/$/, '') || pathname.startsWith(s));
}

function proxy(req, res) {
	if (!API_TARGET) {
		res.writeHead(502, { 'Content-Type': 'text/plain' });
		res.end('API_TARGET not set; start with API_TARGET=http://host:port node server.mjs');

		return;
	}

	const targetUrl = new URL(req.url, API_TARGET.origin);
	const transport = API_TARGET.protocol === 'https:' ? httpsRequest : httpRequest;
	const headers = { ...req.headers };

	headers.host = API_TARGET.host;
	// drop hop-by-hop and browser context headers that would confuse the backend
	delete headers.connection;
	delete headers['keep-alive'];
	delete headers.origin;
	delete headers.referer;
	delete headers.cookie;

	const upstream = transport(
		targetUrl,
		{
			headers,
			method: req.method,
			// long-running streams and slow model loads must not be cut short
			timeout: 0
		},
		(upstreamRes) => {
			res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
			upstreamRes.pipe(res);
		}
	);

	upstream.on('error', (err) => {
		if (!res.headersSent) {
			res.writeHead(502, { 'Content-Type': 'application/json' });
		}

		res.end(JSON.stringify({ error: { message: `Upstream request failed: ${err.message}` } }));
	});

	req.pipe(upstream);
}

async function serveStatic(req, res) {
	const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);

	let filePath = normalize(join(DIST, urlPath));

	if (!filePath.startsWith(DIST)) {
		res.writeHead(403).end('Forbidden');

		return;
	}

	try {
		let info = await stat(filePath);

		if (info.isDirectory()) {
			filePath = join(filePath, 'index.html');
			info = await stat(filePath);
		}

		const ext = extname(filePath).toLowerCase();
		// hashed build assets and the manifest can cache hard; config.js never
		const cacheControl =
			filePath.includes(`${join('', '_app')}`) || filePath.endsWith('manifest.webmanifest')
				? 'public, max-age=31536000, immutable'
				: 'no-cache';

		res.writeHead(200, {
			'Cache-Control': cacheControl,
			'Content-Length': info.size,
			'Content-Type': MIME[ext] ?? 'application/octet-stream'
		});

		await readFile(filePath).then((buf) => res.end(buf));
	} catch {
		// SPA fallback: the app is a hash-router single page app
		try {
			const index = await readFile(join(DIST, 'index.html'));

			res.writeHead(200, { 'Cache-Control': 'no-cache', 'Content-Type': MIME['.html'] });
			res.end(index);
		} catch {
			res.writeHead(404).end('Not found');
		}
	}
}

createServer((req, res) => {
	const pathname = new URL(req.url, 'http://localhost').pathname;

	if (pathname === '/api/db' || pathname.startsWith('/api/db/')) {
		handleDbRpc(req, res);

		return;
	}

	if (API_TARGET && isApiPath(pathname)) {
		proxy(req, res);

		return;
	}

	serveStatic(req, res).catch((e) => {
		res.writeHead(500).end(String(e));
	});
}).listen(PORT, HOST, () => {
	console.log(`chatbot-webui: http://${HOST}:${PORT}`);
	console.log(`dist dir:    ${DIST}`);
	console.log(`sqlite db:   ${DB_PATH}`);
	console.log(`api proxy:   ${API_TARGET ? `${API_TARGET.origin} -> same origin` : 'disabled'}`);
});
