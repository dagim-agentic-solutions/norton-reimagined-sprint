/**
 * /api/comments — Per-prototype forum-style notes
 * Norton Reimagined Sprint — scoped to this project only
 *
 * GET  /api/comments?protoId=<id>          → { comments: [...] }
 * POST /api/comments                       → { comment: {...} }
 *      body: { protoId, author, text }
 * DELETE /api/comments/<commentId>         → { ok: true }
 *      body: { protoId }
 */

const CORS_HEADERS = {
  // TODO: lock this down to the sprint Pages domain after deploy
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

function err(msg, status = 400) {
  return json({ error: msg }, status);
}

function kvKey(protoId) {
  return `comments::${protoId}`;
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const kv = env.PROTOTYPES_KV;
  if (!kv) return err('KV binding not available', 500);

  // ── GET /api/comments?protoId=xxx ─────────────────────────────────────────
  if (request.method === 'GET') {
    const protoId = url.searchParams.get('protoId');
    if (!protoId) return err('protoId is required');
    const raw = await kv.get(kvKey(protoId));
    const comments = raw ? JSON.parse(raw) : [];
    return json({ comments });
  }

  // ── POST /api/comments ────────────────────────────────────────────────────
  if (request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch { return err('Invalid JSON'); }

    const { protoId, author, text } = body || {};
    if (!protoId) return err('protoId is required');
    if (!author || !author.trim()) return err('author (your name) is required');
    if (!text || !text.trim()) return err('text is required');
    if (author.trim().length > 80) return err('Name too long (max 80 chars)');
    if (text.trim().length > 1000) return err('Comment too long (max 1000 chars)');

    const raw = await kv.get(kvKey(protoId));
    const comments = raw ? JSON.parse(raw) : [];

    const comment = {
      id: crypto.randomUUID(),
      protoId,
      author: author.trim(),
      text: text.trim(),
      createdAt: Date.now(),
    };

    comments.push(comment);
    await kv.put(kvKey(protoId), JSON.stringify(comments));
    return json({ comment }, 201);
  }

  // ── DELETE /api/comments/<commentId> ─────────────────────────────────────
  const pathParts = url.pathname.replace(/^\/api\/comments\/?/, '').split('/').filter(Boolean);
  if (request.method === 'DELETE' && pathParts.length === 1) {
    const commentId = pathParts[0];
    let body;
    try { body = await request.json(); } catch { return err('Invalid JSON'); }

    const { protoId } = body || {};
    if (!protoId) return err('protoId is required in body');

    const raw = await kv.get(kvKey(protoId));
    if (!raw) return err('No comments found for this prototype', 404);

    const comments = JSON.parse(raw);
    const idx = comments.findIndex(c => c.id === commentId);
    if (idx === -1) return err('Comment not found', 404);

    comments.splice(idx, 1);
    await kv.put(kvKey(protoId), JSON.stringify(comments));
    return json({ ok: true });
  }

  return err('Method not allowed', 405);
}
