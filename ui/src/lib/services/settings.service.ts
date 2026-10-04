import { browser } from '$app/environment';
import { CONFIG_LOCALSTORAGE_KEY, USER_OVERRIDES_LOCALSTORAGE_KEY, SETTING_CONFIG_DEFAULT } from '$lib/constants';

const forbidden = new Set(['apiKey', 'mcpServers']);
const customFields = new Set(['systemPrompt', 'systemMessage', 'temperature', 'topP', 'top_p', 'maxTokens', 'max_tokens',
	'thinking', 'thinking_budget_tokens', 'toolCalls', 'toolRounds', 'dynatemp_range', 'dynatemp_exponent', 'top_k', 'min_p',
	'xtc_probability', 'xtc_threshold', 'typ_p', 'repeat_last_n', 'repeat_penalty', 'presence_penalty', 'frequency_penalty',
	'dry_multiplier', 'dry_base', 'dry_allowed_length', 'dry_penalty_last_n', 'samplers', 'backend_sampling', 'seed']);

/** Device display/generation preferences only. Credentials and browser MCP endpoints stay out. */
export function sanitizeDeviceConfig(input: Record<string, unknown>): Record<string, string | number | boolean | undefined> {
	const result: Record<string, string | number | boolean | undefined> = {};
	for (const [key, value] of Object.entries(input)) {
		if (forbidden.has(key) || !Object.hasOwn(SETTING_CONFIG_DEFAULT, key)) continue;
		if (!['string', 'number', 'boolean', 'undefined'].includes(typeof value)) continue;
		if (typeof value === 'number' && !Number.isFinite(value)) continue;
		if (key === 'customJson' && typeof value === 'string' && value.trim()) {
			try {
				const custom = JSON.parse(value);
				if (!custom || typeof custom !== 'object' || Array.isArray(custom) || Object.keys(custom).some((field) => !customFields.has(field))) continue;
			} catch { continue; }
		}
		result[key] = value as string | number | boolean | undefined;
	}
	return result;
}

/**
 * SettingsService - localStorage persistence layer for settings
 *
 * Stateless read/write of the settings config and user-override keys. Business
 * logic (default merging, mobile defaults, theme migration) stays in the store.
 *
 * **Architecture & Relationships:**
 * - **settingsStore**: Primary consumer - loads config on init and persists on change
 *
 * @see settingsStore in stores/settings/index.svelte.ts - reactive state + business logic
 */
export class SettingsService {
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

			return { config: sanitizeDeviceConfig(config), isFirstVisit,
				userOverrides: userOverrides.filter((key) => typeof key === 'string' && !forbidden.has(key)) };
		} catch (error) {
			console.warn('Failed to parse config from localStorage, using defaults:', error);

			return { config: {}, isFirstVisit: false, userOverrides: [] };
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
	 * Persist the config and user overrides to localStorage.
	 */
	static saveConfig(config: Record<string, unknown>, userOverrides: string[]): void {
		if (!browser) return;

		try {
			localStorage.setItem(CONFIG_LOCALSTORAGE_KEY, JSON.stringify(sanitizeDeviceConfig(config)));
			localStorage.setItem(USER_OVERRIDES_LOCALSTORAGE_KEY, JSON.stringify(userOverrides));
		} catch (error) {
			console.error('Failed to save config to localStorage:', error);
		}
	}
}
