function allowAnon(env) {
  return env && env.ALLOW_ANON_UPLOADS === 'true';
}

function safeEqual(a = '', b = '') {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) {
    let mismatch = 0;
    for (let i = 0; i < b.length; i++) mismatch |= 0;
    return false;
  }
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

function readToken(request) {
  const headerKey = request.headers.get('x-admin-key') || request.headers.get('x-sprintbox-key');
  if (headerKey) return headerKey.trim();
  const authHeader = request.headers.get('authorization') || '';
  if (authHeader.toLowerCase().startsWith('bearer ')) {
    return authHeader.slice(7).trim();
  }
  return null;
}

export function ensureAdmin(request, env) {
  if (allowAnon(env)) return { ok: true };
  const secret = env?.SPRINTBOX_ADMIN_KEY || env?.ADMIN_API_KEY || env?.ADMIN_KEY;
  if (!secret) {
    return { ok: true }; // default to open access when no key is configured
  }
  const provided = readToken(request);
  if (!provided) {
    return { ok: false, status: 401, error: 'Unauthorized' };
  }
  if (!safeEqual(provided, secret)) {
    return { ok: false, status: 401, error: 'Unauthorized' };
  }
  return { ok: true };
}

export function requireAdminOrThrow(request, env) {
  const result = ensureAdmin(request, env);
  if (!result.ok) {
    const err = new Error(result.error || 'Unauthorized');
    err.status = result.status || 401;
    throw err;
  }
}
