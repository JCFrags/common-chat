/** Package-manager console is bounded and has no credentials, URLs, or absolute paths. */
export function packageConsole(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/(?:authorization\s*[:=]\s*(?:Bearer\s+|Basic\s+)?|(?:token|password|secret|cookie|api[-_]?key)\s*[:=]\s*)[^\s,;]+/gi, '[redacted]')
    .replace(/https?:\/\/[^\s<>"']+/gi, '[registry]')
    .replace(/(?:[A-Za-z]:\\|\/)[A-Za-z0-9._~!$&()+,;=:@%{}\\/-]+/g, '[path]')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').slice(-8000);
}

/** Public runner diagnostics never include engine logs, stacks, or host paths. */
export function runnerFailure(value) {
  const message = String(value?.message ?? value ?? '');
  if (/^(?:Additional dependencies|Dependency (?:file count|size|transfer|budget)).*(?:limit|budget|exceed)/i.test(message)) return 'Additional dependencies exceed the 32 MiB or 4096-file transfer budget. Use bundled libraries, fewer packages, or smaller wheel versions.';
  if (/pip could not|npm could not|^Package installation failed\./i.test(message)) {
    const console = `${message}\n${value?.diagnostics?.stderr ?? value?.stderr ?? ''}`;
    const lines = console.split(/\r?\n/).filter(line => /ERROR:|npm (?:error|ERR!)/i.test(line)).slice(-6).join('\n');
    const detail = packageConsole(lines).slice(0, 1200);
    return `Package installation failed. Only approved registry wheels and npm packages without lifecycle scripts are supported. Bundled Python versions constrain dependency resolution.${detail ? `\n${detail}` : ' Check package names, wheel availability, version compatibility, and the dependency budget.'}`;
  }
  if (/registry|upstream|DNS|redirect/i.test(message)) return 'Approved registry access failed or exceeded its download budget. Check the package name and registry availability. General network access remains disabled.';
  if (/cleanup|Container cleanup/i.test(message)) return 'Container cleanup could not be confirmed. The runner is unavailable until the administrator checks its owned containers.';
  if (/isolation|cgroup|rootless|seccomp|image/i.test(message)) return 'The runner image or required rootless isolation checks failed. The administrator must verify the installed worker image and cgroup/seccomp configuration.';
  if (/timed out|deadline/i.test(message)) return 'The isolated runner exceeded its operation deadline. Reduce the code or package workload before retrying.';
  if (/symlink|link|special|traversal|file.*(?:size|limit|budget)|output.*(?:limit|budget)/i.test(message)) return 'The runner rejected an unsafe or oversized output. Use regular files within the displayed file and byte limits.';
  if (/busy/i.test(message)) return 'The isolated runner is busy. Wait for its current operation to finish.';
  if (/cancelled|canceled/i.test(message)) return 'The operation was cancelled. No new workspace outputs were imported.';
  return 'The isolated runner could not complete the operation. Inspect its saved status and operation ID before retrying. The administrator can use that ID to check runner logs.';
}
