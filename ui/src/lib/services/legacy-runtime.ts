/** Common owns jobs and rootless execution. Raw upstream browser APIs cannot bypass it. */
export function rejectLegacyRuntime(): void {
	throw new Error('Raw llama.cpp, host-directory and browser MCP operations are disabled in Common. Use Connections, Files and isolated Run. Model services stay independent.');
}
