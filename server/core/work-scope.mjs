function scopeText(value) {
  return String(value || '').trim().replaceAll('\\', '/');
}

export function normalizeWorkScope(value) {
  let scope = scopeText(value);
  if (!scope) return null;
  if (scope === '*') return '*';
  while (scope.startsWith('./')) scope = scope.slice(2);
  scope = scope.replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/');
  if (!scope || scope === '.') return null;
  const parts = scope.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) throw new Error(`Invalid work scope: ${value}`);
  if (scope.includes('*') || scope.includes('?') || scope.includes('\0')) throw new Error(`Work scope must be a concrete project-relative path prefix: ${value}`);
  return scope;
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
  return normalizeWorkScopes(agent?.workScopes || []);
}

export function scopeSubset(scopes = [], allowedScopes = []) {
  const requested = normalizeWorkScopes(scopes);
  const allowed = normalizeWorkScopes(allowedScopes);
  if (!requested.length || !allowed.length) return true;
  return requested.every((scope) => allowed.some((parent) => parent === '*' || scope === parent || scope.startsWith(`${parent}/`)));
}
