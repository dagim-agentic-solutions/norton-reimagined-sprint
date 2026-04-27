import { ensureAdmin } from '../../_lib/adminAuth.js';
import { scoreLaura } from '../prototypes.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestPost({ request, env }) {
  const guardEnv = { ...env, ALLOW_ANON_UPLOADS: 'false' };
  const denied = ensureAdmin(request, guardEnv);
  if (denied) return denied;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body.' }, 400);
  }

  const id = (body?.id || '').trim();
  if (!id) {
    return json({ error: 'Prototype id is required.' }, 400);
  }

  const kv = env.PROTOTYPES_KV;
  if (!kv) {
    return json({ error: 'Datastore unavailable. Check KV binding.' }, 503);
  }

  let raw;
  try {
    raw = await kv.get(`proto:${id}`);
  } catch {
    return json({ error: 'Failed to read prototype from datastore.' }, 503);
  }
  if (!raw) {
    return json({ error: 'Prototype not found.' }, 404);
  }

  const prototype = JSON.parse(raw);
  let fileContent = prototype.fileContent || null;
  if (!fileContent && prototype.fileStoredSeparately) {
    try { fileContent = await kv.get(`file:${id}`) || null; } catch {}
  }

  const lauraResult = await scoreLaura(prototype, fileContent, env);
  if (!lauraResult) {
    return json({ error: 'Scoring failed (check Anthropic key and prototype accessibility).' }, 502);
  }

  const updated = { ...prototype, ...lauraResult };
  try {
    await kv.put(`proto:${id}`, JSON.stringify(updated));
  } catch {
    return json({ error: 'Failed to persist updated prototype.' }, 503);
  }

  return json({ prototype: updated });
}
