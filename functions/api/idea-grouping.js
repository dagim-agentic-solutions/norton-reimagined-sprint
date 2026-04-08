// /api/idea-grouping — root handler (GET board state only)
// All subpath routes are handled by functions/api/idea-grouping/[[path]].js

const KV_KEY = 'idea-grouping::board';
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

function defaultBoard() {
  return {
    version: 1,
    locked: false,
    lockTimestamp: null,
    columns: [
      { id: 'col-1', title: 'Column 1' },
      { id: 'col-2', title: 'Column 2' },
      { id: 'col-3', title: 'Column 3' },
      { id: 'col-4', title: 'Column 4' },
    ],
    ideas: [],
  };
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function onRequestGet({ env }) {
  const kv = env.PROTOTYPES_KV;
  if (!kv) return json({ error: 'KV unavailable' }, 503);
  const raw = await kv.get(KV_KEY);
  if (!raw) return json(defaultBoard());
  try {
    return json(JSON.parse(raw));
  } catch {
    return json(defaultBoard());
  }
}
