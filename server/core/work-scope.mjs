export function normalizeWorkScope(value) {
  const raw = String(value || '').trim().normalize('NFKC');
  if (/^[\\/]/.test(raw) || /^[a-z]:/i.test(raw)) throw new Error(`Work scope must be project-relative: ${value}`);
  let scope = raw.replaceAll('\\', '/');
  if (!scope) return null;
  if (scope === '*') return '*';
  while (scope.startsWith('./')) scope = scope.slice(2);
  scope = scope.replace(/\/+$/g, '').replace(/\/{2,}/g, '/');
  if (!scope || scope === '.') return null;
  const parts = scope.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) throw new Error(`Invalid work scope: ${value}`);
  if (scope.includes('*') || scope.includes('?') || scope.includes(':') || scope.includes('\0')) throw new Error(`Work scope must be a concrete project-relative path prefix: ${value}`);
  if (parts.some((part) => /[. ]$/.test(part))) throw new Error(`Work scope contains a cross-platform ambiguous path segment: ${value}`);
  return scope.toLowerCase();
}

export function normalizeWorkScopes(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map(normalizeWorkScope).filter(Boolean))].sort();
}

export function scopesOverlap(left, right) {
  const a = normalizeWorkScope(left);
  const b = normalizeWorkScope(right);
  if (!a || !b) return false;
  return a === '*' || b === '*' || a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

export function scopeSetsOverlap(left = [], right = []) {
  const a = normalizeWorkScopes(left);
  const b = normalizeWorkScopes(right);
  return a.some((one) => b.some((two) => scopesOverlap(one, two)));
}

export function taskWorkScopes(task, agent = null) {
  const taskScopes = normalizeWorkScopes(task?.workScopes || []);
  if (taskScopes.length) return taskScopes;
  const agentScopes = normalizeWorkScopes(agent?.workScopes || []);
  if (agentScopes.length) return agentScopes;
  // Unknown mutating scope is project-wide ownership. This is intentionally
  // conservative: an unscoped Task must serialize instead of being treated as
  // conflict-free parallel work.
  return ['*'];
}

export function scopeSubset(scopes = [], allowedScopes = []) {
  const requested = normalizeWorkScopes(scopes);
  const allowed = normalizeWorkScopes(allowedScopes);
  if (!requested.length || !allowed.length) return true;
  return requested.every((scope) => allowed.some((parent) => parent === '*' || scope === parent || scope.startsWith(`${parent}/`)));
}
