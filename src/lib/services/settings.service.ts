import { browser } from '$app/environment';
import { CONFIG_LOCALSTORAGE_KEY, USER_OVERRIDES_LOCALSTORAGE_KEY } from '$lib/constants';

/**
 * SettingsService - persistence layer for settings config and user-override keys
 *
 * Stateless read/write of the settings config. The primary backend is the
 * server SQLite store reached through the `/api/db` RPC (see db.mjs /
 * server.mjs); localStorage stays as a local mirror: it seeds startup (so the
 * stored API key/URL are available before any network call) and takes over
 * when the endpoint is unreachable. Server keys are namespaced (`config`,
 * `userOverrides`) to share the settings table with other app state.
 * Business logic (default merging, mobile defaults, theme migration) stays in
 * the store.
 *
 * **Architecture & Relationships:**
 * - **settingsStore**: Primary consumer - loads config on init and persists on change
 *
 * @see settingsStore in stores/settings/index.svelte.ts - reactive state + business logic
 */

const DB_ENDPOINT = 'api/db';

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

export class SettingsService {
	/**
	 * Drop the server-side settings snapshot (used when the UI resets to
	 * defaults, so a stale server copy is not re-adopted on next startup).
	 */
	static clearServerConfig(): void {
		if (!browser || !serverAvailable) return;

		dbRpc('settingsClear', []).catch(() => {
			// best-effort: the reset still lives in localStorage
		});
	}

	/**
	 * Read the raw config and user overrides from localStorage.
	 * @returns Parsed values, or empty defaults when nothing is stored or parsing fails.
	 */
	static loadConfig(): {
		config: Record<string, unknown>;
		userOverrides: string[];
		isFirstVisit: boolean;
	} {
		if (!browser) {
			return { config: {}, isFirstVisit: false, userOverrides: [] };
		}

		try {
			const storedConfigRaw = localStorage.getItem(CONFIG_LOCALSTORAGE_KEY);
			const isFirstVisit = storedConfigRaw === null;
			const config = JSON.parse(storedConfigRaw || '{}') as Record<string, unknown>;
			const userOverrides = JSON.parse(
				localStorage.getItem(USER_OVERRIDES_LOCALSTORAGE_KEY) || '[]'
			) as string[];

			return { config, isFirstVisit, userOverrides };
		} catch (error) {
			console.warn('Failed to parse config from localStorage, using defaults:', error);

			return { config: {}, isFirstVisit: false, userOverrides: [] };
		}
	}

	/**
	 * Pull the server-side settings snapshot (SQLite). Called once at startup
	 * after the synchronous localStorage load; when the server has rows they
	 * win, so the same account state follows the browser to any device that
	 * loads this deployment. Returns null when the endpoint is unavailable or
	 * holds nothing yet.
	 */
	static async loadServerConfig(): Promise<{
		config: Record<string, unknown>;
		userOverrides: string[];
	} | null> {
		if (!browser || !serverAvailable) return null;

		try {
			const snapshot = (await dbRpc('settingsGet', [])) as {
				config?: Record<string, unknown>;
				userOverrides?: string[];
			} | null;

			if (!snapshot || typeof snapshot.config !== 'object' || snapshot.config === null) {
				return null;
			}

			return {
				config: snapshot.config,
				userOverrides: Array.isArray(snapshot.userOverrides) ? snapshot.userOverrides : []
			};
		} catch (error) {
			serverAvailable = false;
			console.warn('[SettingsService] server settings unavailable, using localStorage:', error);

			return null;
		}
	}

	/**
	 * Migrate the legacy un-namespaced "theme" localStorage key.
	 * Returns the legacy theme value (and removes the key) when present, else null.
	 */
	static migrateLegacyTheme(): string | null {
		if (!browser) return null;

		const legacyTheme = localStorage.getItem('theme');

		if (legacyTheme) {
			localStorage.removeItem('theme');

			return legacyTheme;
		}

		return null;
	}

	/**
	 * Persist the config and user overrides: always to localStorage (startup
	 * seed + offline fallback), best-effort to the server SQLite store.
	 */
	static saveConfig(config: Record<string, unknown>, userOverrides: string[]): void {
		if (!browser) return;

		try {
			localStorage.setItem(CONFIG_LOCALSTORAGE_KEY, JSON.stringify(config));
			localStorage.setItem(USER_OVERRIDES_LOCALSTORAGE_KEY, JSON.stringify(userOverrides));
		} catch (error) {
			console.error('Failed to save config to localStorage:', error);
		}

		if (!serverAvailable) return;

		dbRpc('settingsMerge', [{ config, userOverrides }]).catch((error) => {
			serverAvailable = false;
			console.warn(
				'[SettingsService] server settings unavailable, saved to localStorage only:',
				error
			);
		});
	}
}
