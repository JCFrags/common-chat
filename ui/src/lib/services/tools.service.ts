import { rejectLegacyRuntime } from '$lib/services/legacy-runtime';
import type { ServerToolInfo, ToolExecutionResult } from '$lib/types';

export interface ToolStreamEvent { chunk: string | null; done: boolean; error?: string }

/** Browser tool execution is disabled. Common owns isolated native execution and receipts. */
export class ToolsService {
	static async list(): Promise<ServerToolInfo[]> { return []; }
	static async executeTool(_name: string, _params: Record<string, unknown>, _signal?: AbortSignal, _cwd?: string): Promise<ToolExecutionResult> {
		rejectLegacyRuntime(); throw new Error('Unavailable.');
	}
	static async executeToolRaw(_name: string, _params: Record<string, unknown>, _signal?: AbortSignal, _cwd?: string, _responseType?: string): Promise<Record<string, unknown>> {
		rejectLegacyRuntime(); throw new Error('Unavailable.');
	}
	static async *streamTool(_name: string, _params: Record<string, unknown>, _signal?: AbortSignal, _cwd?: string): AsyncGenerator<ToolStreamEvent> {
		rejectLegacyRuntime();
	}
}
