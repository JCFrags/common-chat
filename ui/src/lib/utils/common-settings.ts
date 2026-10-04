import type { CommonProvider, CommonSettings, CommonThinking } from '$lib/types/common-api';

const aliases: Record<string, string> = {
	systemMessage: 'systemPrompt', top_p: 'topP', max_tokens: 'maxTokens'
};
const numbers: Record<string, [number, number, boolean?]> = {
	temperature: [0, 2], topP: [0, 1], maxTokens: [-1, 1000000, true],
	toolCalls: [1, 1000000, true], toolRounds: [1, 1000000, true],
	dynatemp_range: [0, 100], dynatemp_exponent: [0, 100], top_k: [0, 1000000, true],
	min_p: [0, 1], xtc_probability: [0, 1], xtc_threshold: [0, 1], typ_p: [0, 1],
	repeat_last_n: [-1, 1000000, true], repeat_penalty: [0, 100],
	presence_penalty: [-2, 2], frequency_penalty: [-2, 2],
	dry_multiplier: [0, 100], dry_base: [0, 100], dry_allowed_length: [0, 1000000, true],
	dry_penalty_last_n: [-1, 1000000, true], seed: [-1, 4294967295, true],
	thinking_budget_tokens: [-1, 1000000, true]
};
const generic = new Set(['systemPrompt', 'temperature', 'topP', 'maxTokens', 'thinking', 'toolCalls', 'toolRounds']);
const nativeCapability: Record<string, string> = {
	presence_penalty: 'presencePenalty', frequency_penalty: 'frequencyPenalty', seed: 'seed'
};
const samplerNames = new Set(['dry', 'top_k', 'typ_p', 'top_p', 'min_p', 'xtc', 'temperature', 'penalties', 'infill']);
const present = (value: unknown) => value !== undefined && value !== null && value !== '';

/** Custom JSON is a settings subset. It cannot change request authority or the endpoint. */
export function validateCommonSettings(
	input: Record<string, unknown>, provider: CommonProvider, thinking: CommonThinking
): CommonSettings {
	const result: CommonSettings = {};
	for (const [source, value] of Object.entries(input)) {
		const key = aliases[source] ?? source;
		if (!(key in numbers) && !['systemPrompt', 'thinking', 'samplers', 'backend_sampling'].includes(key)) {
			throw new Error(`Unsupported generation field "${source}". Custom JSON accepts typed sampling settings only, not model, messages, tools, credentials or URL overrides.`);
		}
		if (!present(value)) continue;
		if (!generic.has(key)) {
			if (key === 'thinking_budget_tokens') {
				if (provider.capabilities.llamaCppThinkingBudget !== true || thinking.protocol !== 'llama_cpp') {
					throw new Error('Thinking token budgets require the llama_cpp protocol and llamaCppThinkingBudget capability. Remote reasoning effort is separate.');
				}
			} else if (provider.capabilities.llamaCppSampling !== true && provider.capabilities[nativeCapability[key]] !== true) {
				throw new Error(`"${key}" is not supported by this connection. Enable its declared sampling capability or remove this override.`);
			}
		}
		if (key in numbers) {
			const [min, max, integer] = numbers[key];
			if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value)) || (key === 'maxTokens' && value !== -1 && value < 1)) {
				throw new Error(`"${key}" must be ${integer ? 'an integer' : 'a finite number'} from ${min} to ${max}${key === 'maxTokens' ? ', excluding zero' : ''}.`);
			}
			result[key] = value;
		} else if (key === 'systemPrompt') {
			if (typeof value !== 'string') throw new Error('systemPrompt must be text.');
			result[key] = value;
		} else if (key === 'thinking') {
			if (typeof value !== 'string' || thinking.protocol === 'none' || !(thinking.protocol === 'llama_cpp' ? ['on', 'off'] : thinking.levels).includes(value)) {
				throw new Error('This thinking value is not declared for the selected model and connection. Choose Default or a supported value.');
			}
			result[key] = value;
		} else if (key === 'backend_sampling') {
			if (typeof value !== 'boolean') throw new Error('backend_sampling must be a boolean.');
			result[key] = value;
		} else {
			if (!Array.isArray(value) || value.length > 32 || value.some((item) => typeof item !== 'string' || !samplerNames.has(item))) {
				throw new Error('samplers must be an array of supported sampler names.');
			}
			result[key] = value;
		}
	}
	return result;
}

export function generationSettings(
	config: Record<string, unknown>, saved: CommonSettings, provider: CommonProvider,
	thinking: CommonThinking, effort = 'default'
): CommonSettings {
	const fields: Record<string, unknown> = { ...saved };
	for (const key of [...Object.keys(numbers), 'systemMessage', 'top_p', 'max_tokens']) {
		const value = config[key];
		if (present(value)) fields[aliases[key] ?? key] = value;
	}
	if (config.backend_sampling === true || (provider.capabilities.llamaCppSampling && config.backend_sampling === false)) {
		fields.backend_sampling = config.backend_sampling;
	}
	if (present(config.samplers)) {
		fields.samplers = typeof config.samplers === 'string'
			? config.samplers.split(/[;,]/).map((item) => item.trim()).filter(Boolean) : config.samplers;
	}
	delete fields.thinking;
	if (present(config.customJson)) {
		let custom: unknown;
		try { custom = JSON.parse(String(config.customJson)); } catch { throw new Error('Custom generation JSON is invalid.'); }
		if (!custom || typeof custom !== 'object' || Array.isArray(custom)) throw new Error('Custom generation JSON must be an object of typed settings.');
		Object.assign(fields, validateCommonSettings(custom as Record<string, unknown>, provider, thinking));
	}
	if (effort !== 'default') {
		if (thinking.protocol === 'llama_cpp' && !['on', 'off'].includes(effort)) {
			throw new Error('llama_cpp thinking accepts On or Off, not remote effort levels. Choose Default or a supported value.');
		}
		fields.thinking = effort;
	}
	return validateCommonSettings(fields, provider, thinking);
}
