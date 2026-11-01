/**
 * API origin resolution for provider-agnostic deployments.
 *
 * The UI talks to the backend through relative paths so it can be served from
 * any static host while pointing at any OpenAI-compatible server (llama.cpp,
 * vLLM, Ollama, an LLM gateway, ...). Two layers decide where requests go:
 *
 * 1. Build time — `VITE_PUBLIC_API_ORIGIN` bakes a default API origin into the
 *    bundle (empty string keeps same-origin relative requests).
 * 2. Runtime — `window.DSH_API_ORIGIN`, set from `static/config.js` before the
 *    app boots, overrides the baked default without rebuilding. It may be an
 *    origin (`http://host:port`) or a full base URL ending in `/v1`; both forms
 *    work because the UI requests paths like `/v1/chat/completions`, `/props`
 *    and `/models`.
 *
 * Every backend call goes through `apiFetch`/`apiPost`/`apiDelete`/
 * `apiFetchWithParams` or resolves one of the endpoint constants, so rewriting
 * here covers chat completions, streaming, models, props, slots and tools.
 */

const API_PATH_SEGMENTS = ['/v1/', '/props', '/models', '/slots', '/tools', '/cors-proxy'];

/**
 * Normalize a configured origin: trim whitespace and slashes, accept a base
 * URL that already ends in `/v1`, reject anything that is not http(s).
 * Returns '' for unset/invalid values (same-origin relative requests).
 */
export function normalizeApiOrigin(raw: unknown): string {
	if (typeof raw !== 'string') return '';

	let origin = raw.trim();

	if (!origin) return '';

	// accept the OpenAI SDK style base URL ("http://host:8080/v1")
	const v1Suffix = '/v1';

	if (origin.toLowerCase().endsWith(v1Suffix)) {
		origin = origin.slice(0, -v1Suffix.length);
	}

	origin = origin.replace(/\/+$/, '');

	if (!/^https?:\/\//i.test(origin)) return '';

	return origin;
}

// Highest-priority override: the user's "API URL" setting, registered by the
// settings store at init. Kept as a callback so this module stays dependency
// free — stores and services both import it without circular imports.
let settingsOriginGetter: (() => string | undefined) | null = null;

/** Register the settings-backed origin override (called once by settingsStore). */
export function registerApiOriginSetting(getter: () => string | undefined): void {
	settingsOriginGetter = getter;
}

/**
 * The effective API origin for this app instance: the user's API URL setting
 * wins, then the runtime `window.DSH_API_ORIGIN`, then the build-time default;
 * '' means same-origin.
 */
export function getApiOrigin(): string {
	const fromSettings = normalizeApiOrigin(settingsOriginGetter?.());

	if (fromSettings) return fromSettings;

	const runtime = normalizeApiOrigin(globalThis.window?.DSH_API_ORIGIN);

	if (runtime) return runtime;

	return normalizeApiOrigin(import.meta.env.VITE_PUBLIC_API_ORIGIN ?? '');
}

/**
 * Prefix a backend path with the effective API origin. Relative paths stay
 * relative (same-origin) when no origin is configured, so behavior is
 * unchanged for deployments that proxy the API through the web server.
 */
export function apiUrl(path: string): string {
	const origin = getApiOrigin();

	if (!origin) return path;

	return `${origin}${path.startsWith('/') ? '' : '/'}${path}`;
}

/**
 * True when a fetch input (string or Request/URL) targets the backend API, so
 * callers can rewrite it to the configured origin. Only paths that match a
 * known API segment are rewritten — app assets like `build.json` stay local.
 * Relative inputs (`./v1/chat/completions`, and `${base}/props` which with the
 * SPA's relative base becomes `./props`) resolve against the document URL; the
 * hash router keeps that document at the deployment root, so the resolved
 * pathname is the backend path.
 */
export function isBackendApiPath(input: unknown): boolean {
	let path = '';

	if (typeof input === 'string') {
		path = resolveInputPath(input);
	} else if (input instanceof URL) {
		path = input.pathname;
	} else if (typeof Request !== 'undefined' && input instanceof Request) {
		path = new URL(input.url, globalThis.window?.location?.href ?? 'http://localhost').pathname;
	}

	if (!path.startsWith('/')) return false;

	return API_PATH_SEGMENTS.some((segment) => path.startsWith(segment));
}

/** Resolve a fetch input string to its path, anchoring relative inputs on the document. */
function resolveInputPath(input: string): string {
	if (/^https?:\/\//i.test(input)) {
		try {
			return new URL(input).pathname;
		} catch {
			return input;
		}
	}

	const docBase = globalThis.window?.location?.href ?? 'http://localhost/';

	try {
		return new URL(input, docBase).pathname;
	} catch {
		return input.startsWith('/') ? input : `/${input}`;
	}
}

/**
 * Rewrite a backend-relative fetch input to the configured API origin.
 * Returns the input unchanged when no origin is set or it is not an API path.
 * The rewritten URL carries the resolved pathname, so `./v1/chat/completions`
 * and `${base}/props` both land on `<origin>/v1/...` and `<origin>/props`.
 */
export function rewriteApiFetchInput(input: RequestInfo | URL): RequestInfo | URL {
	const origin = getApiOrigin();

	if (!origin || !isBackendApiPath(input)) return input;

	if (typeof input === 'string') {
		return apiUrl(resolveInputPath(input));
	}

	if (input instanceof URL) {
		return apiUrl(input.pathname + input.search + input.hash);
	}

	// Request objects: rebuild with the absolute URL, preserving method/headers/body
	const requestUrl = new URL(input.url, globalThis.window?.location?.href ?? 'http://localhost');

	return new Request(apiUrl(requestUrl.pathname + requestUrl.search + requestUrl.hash), input);
}
