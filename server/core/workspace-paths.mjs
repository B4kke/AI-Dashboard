import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, posix, resolve, sep, win32 } from 'node:path';

// Workspace roots are privileged local configuration. These helpers keep a
// deterministic canonical identity across platforms without executing anything
// inside the configured paths. Path semantics follow the requested platform so
// behavior is identical when tested on either operating system.

export function canonicalWorkspacePath(value, { platform = process.platform } = {}) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  if (raw.includes('\0')) return null;
  if (platform === 'win32') return win32.resolve(raw.replaceAll('/', '\\'));
  return posix.isAbsolute(raw) ? posix.normalize(raw) : resolve(raw);
}

export function workspacePathKey(value, options = {}) {
  const canonical = canonicalWorkspacePath(value, options);
  const platform = options.platform || process.platform;
  if (!canonical) return null;
  return platform === 'win32' ? canonical.toLowerCase() : canonical;
}

export async function resolveWorkspaceRoot(value, { platform = process.platform } = {}) {
  const raw = String(value ?? '').trim();
  if (!raw) throw new Error('Workspace root path is required');
  if (raw.includes('\0')) throw new Error('Workspace root path is malformed');
  const canonical = canonicalWorkspacePath(raw, { platform });
  let stats;
  try {
    stats = await lstat(canonical);
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`Workspace root does not exist: ${canonical}`);
    throw new Error(`Workspace root is not accessible: ${canonical}`);
  }
  if (!stats.isDirectory()) throw new Error(`Workspace root must be a directory, not a file: ${canonical}`);
  let identity = canonical;
  try {
    identity = canonicalWorkspacePath(await realpath(canonical), { platform }) || canonical;
  } catch {
    // Keep the lexical canonical path when realpath is unavailable.
  }
  return identity;
}

export function assertSafeRepositoryDirectoryName(name) {
  const value = String(name || '').trim();
  if (!value || value !== value.trim()) throw new Error('Repository directory name is required');
  if (/^[.]+$/.test(value)) throw new Error('Repository directory name is invalid');
  if (/[\\/]/.test(value) || value.includes('..')) {
    throw new Error(`Repository directory name may not contain path separators or traversal: ${name}`);
  }
  if (/[:*?"<>|\0]/.test(value)) throw new Error('Repository directory name contains unsupported characters');
  if (value.startsWith('-')) throw new Error('Repository directory name may not start with a dash');
  if (value.startsWith('.')) throw new Error('Repository directory name may not start with a dot');
  if (value.length > 100) throw new Error('Repository directory name is too long');
  return value;
}
