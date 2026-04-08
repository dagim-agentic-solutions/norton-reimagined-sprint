// Cloudflare Pages Function: /api/idea-grouping
// REST API for the Idea Grouping board

const KV_KEY = 'idea-grouping::board';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
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

// Constant-time string comparison to prevent timing attacks
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) {
    // Still iterate to prevent length-based timing leak
    let acc = 1;
    for (let i = 0; i < b.length; i++) acc |= 0;
    return false;
  }
  let acc = 0;
  for (let i = 0; i < a.length; i++) {
    acc |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return acc === 0;
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

async function getBoard(env) {
  const raw = await env.PROTOTYPES_KV.get(KV_KEY);
  if (!raw) return defaultBoard();
  try {
    return JSON.parse(raw);
  } catch {
    return defaultBoard();
  }
}

async function saveBoard(env, board) {
  board.version = (board.version || 1) + 1;
  await env.PROTOTYPES_KV.put(KV_KEY, JSON.stringify(board));
}

function broadcastEvent(env, type, payload) {
  if (!env.IDEA_GROUPING_WS_URL) return;
  const url = env.IDEA_GROUPING_WS_URL + '/broadcast';
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, payload }),
  }).catch(() => {});
}

function nanoid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname; // e.g. /api/idea-grouping or /api/idea-grouping/idea/xxx

  // Handle CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // Parse path segments — context.params.path is the catch-all after /api/idea-grouping/
  // e.g. 'idea', 'idea/abc-123', 'column/col-1', 'lock', 'unlock'
  const catchAll = (context.params && context.params.path) || '';
  const parts = (typeof catchAll === 'string' ? catchAll.split('/') : catchAll).filter(Boolean);

  // GET /api/idea-grouping
  if (request.method === 'GET' && parts.length === 0) {
    const board = await getBoard(env);
    return json(board);
  }

  // POST /api/idea-grouping/idea
  if (request.method === 'POST' && parts[0] === 'idea' && parts.length === 1) {
    const board = await getBoard(env);
    if (board.locked) return err('Board is locked', 403);

    let body;
    try { body = await request.json(); } catch { return err('Invalid JSON'); }
    const { title, description, visionAlignment, lauraProblem } = body;
    if (!title || typeof title !== 'string' || !title.trim()) {
      return err('title is required');
    }
    const idea = {
      id: nanoid(),
      title: title.trim(),
      description: description?.trim() || '',
      visionAlignment: visionAlignment?.trim() || '',
      lauraProblem: lauraProblem?.trim() || '',
      columnId: board.columns[0]?.id || 'col-1',
      createdAt: new Date().toISOString(),
    };
    board.ideas.push(idea);
    await saveBoard(env, board);
    broadcastEvent(env, 'idea:created', idea);
    return json(idea, 201);
  }

  // PATCH /api/idea-grouping/idea/IDEA_ID
  if (request.method === 'PATCH' && parts[0] === 'idea' && parts.length === 2) {
    const ideaId = parts[1];
    const board = await getBoard(env);
    if (board.locked) return err('Board is locked', 403);
    const idx = board.ideas.findIndex(i => i.id === ideaId);
    if (idx === -1) return err('Idea not found', 404);
    let body;
    try { body = await request.json(); } catch { return err('Invalid JSON'); }
    const { columnId } = body;
    if (!columnId || !board.columns.find(c => c.id === columnId)) {
      return err('Invalid columnId');
    }
    board.ideas[idx].columnId = columnId;
    await saveBoard(env, board);
    broadcastEvent(env, 'idea:updated', board.ideas[idx]);
    return json(board.ideas[idx]);
  }

  // DELETE /api/idea-grouping/idea/IDEA_ID
  if (request.method === 'DELETE' && parts[0] === 'idea' && parts.length === 2) {
    const ideaId = parts[1];
    const board = await getBoard(env);
    if (board.locked) return err('Board is locked', 403);
    let body;
    try { body = await request.json(); } catch { return err('Invalid JSON'); }
    if (!safeEqual(body.password || '', 'norton')) {
      return err('Unauthorized', 403);
    }
    const idx = board.ideas.findIndex(i => i.id === ideaId);
    if (idx === -1) return err('Idea not found', 404);
    board.ideas.splice(idx, 1);
    await saveBoard(env, board);
    broadcastEvent(env, 'idea:deleted', { id: ideaId });
    return json({ deleted: true });
  }

  // PATCH /api/idea-grouping/column/COL_ID
  if (request.method === 'PATCH' && parts[0] === 'column' && parts.length === 2) {
    const colId = parts[1];
    const board = await getBoard(env);
    if (board.locked) return err('Board is locked', 403);
    const col = board.columns.find(c => c.id === colId);
    if (!col) return err('Column not found', 404);
    let body;
    try { body = await request.json(); } catch { return err('Invalid JSON'); }
    const { title } = body;
    if (!title || typeof title !== 'string' || !title.trim()) {
      return err('title is required');
    }
    col.title = title.trim();
    await saveBoard(env, board);
    broadcastEvent(env, 'column:updated', { id: colId, title: col.title });
    return json(col);
  }

  // POST /api/idea-grouping/lock
  if (request.method === 'POST' && parts[0] === 'lock' && parts.length === 1) {
    let body;
    try { body = await request.json(); } catch { return err('Invalid JSON'); }
    if (!safeEqual(body.password || '', 'dagim')) {
      return err('Unauthorized', 403);
    }
    const board = await getBoard(env);
    board.locked = true;
    board.lockTimestamp = new Date().toISOString();
    await saveBoard(env, board);
    broadcastEvent(env, 'board:lock', { locked: true, lockTimestamp: board.lockTimestamp });
    return json({ locked: true, lockTimestamp: board.lockTimestamp });
  }

  // POST /api/idea-grouping/unlock
  if (request.method === 'POST' && parts[0] === 'unlock' && parts.length === 1) {
    let body;
    try { body = await request.json(); } catch { return err('Invalid JSON'); }
    if (!safeEqual(body.password || '', 'dagim')) {
      return err('Unauthorized', 403);
    }
    const board = await getBoard(env);
    board.locked = false;
    board.lockTimestamp = null;
    await saveBoard(env, board);
    broadcastEvent(env, 'board:unlock', { locked: false });
    return json({ locked: false });
  }

  return err('Not found', 404);
}
