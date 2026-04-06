/**
 * /api/votes — Prototype voting
 * Norton Reimagined Sprint — scoped to this project only
 *
 * GET    /api/votes              → { votes: { [protoId]: count } }
 * POST   /api/votes              → { ok: true, votes: { [protoId]: count } }
 *        body: { protoId }
 * DELETE /api/votes              → { ok: true }  (global reset — wipes all votes)
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const VOTES_KEY = 'global::votes';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}
function err(msg, status = 400) { return json({ error: msg }, status); }

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });

  const kv = env.PROTOTYPES_KV;
  if (!kv) return err('KV binding not available', 500);

  // GET — return all vote counts
  if (request.method === 'GET') {
    const raw = await kv.get(VOTES_KEY);
    const votes = raw ? JSON.parse(raw) : {};
    return json({ votes });
  }

  // POST — increment vote for a protoId
  if (request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch { return err('Invalid JSON'); }
    const { protoId } = body || {};
    if (!protoId) return err('protoId is required');

    const raw = await kv.get(VOTES_KEY);
    const votes = raw ? JSON.parse(raw) : {};
    votes[protoId] = (votes[protoId] || 0) + 1;
    await kv.put(VOTES_KEY, JSON.stringify(votes));
    return json({ ok: true, votes });
  }

  // DELETE — global reset
  if (request.method === 'DELETE') {
    await kv.put(VOTES_KEY, JSON.stringify({}));
    return json({ ok: true });
  }

  return err('Method not allowed', 405);
}
