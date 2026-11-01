/**
 * Installs a window.fetch wrapper that rebases backend API requests onto the
 * configured API origin (runtime `window.DSH_API_ORIGIN` or build-time
 * `VITE_PUBLIC_API_ORIGIN`). Services that call fetch() directly — chat
 * completions, resumable streams, slots, tools SSE, props probes from the
 * layout and error splash — go through this instead of the apiFetch helpers.
 *
 * Only paths matching a known backend segment (`/v1/...`, `/props`, `/models`,
 * `/slots`, `/tools`, `/cors-proxy`) are rewritten; app assets (build.json,
 * _app/version.json, static files) stay on the web server that serves the UI.
 *
 * Idempotent: calling it twice is a no-op. Must run once before the first API
 * request — the root layout calls it during store init.
 */

import { rewriteApiFetchInput } from './api-origin';

const PATCH_FLAG = '__dshApiOriginPatch';

export function installApiOriginFetchPatch(): void {
	if (typeof window === 'undefined') return;

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const target = window as any;

	if (target[PATCH_FLAG]) return;

	target[PATCH_FLAG] = true;

	const originalFetch = window.fetch.bind(window);

	window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		return originalFetch(rewriteApiFetchInput(input), init);
	};
}
