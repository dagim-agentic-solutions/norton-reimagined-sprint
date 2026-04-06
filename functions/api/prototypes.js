/**
 * /api/prototypes
 * Scope: norton-reimagined-sprint only.
 *
 * GET  → returns all submitted prototypes, newest first
 * POST → submits a new prototype (open to anyone with the link)
 *
 * KV binding: PROTOTYPES_KV
 * Index key:  "index" → JSON array of prototype IDs in insertion order
 * Data keys:  "proto:<id>" → JSON prototype object
 *
 * No npm dependencies — built-in fetch only.
 */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

// ─── Preflight ────────────────────────────────────────────────────────────────
export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

// ─── GET: list all prototypes ─────────────────────────────────────────────────
export async function onRequestGet({ env }) {
  const kv = env.PROTOTYPES_KV;
  if (!kv) {
    return json({ error: "Datastore unavailable. Check KV binding." }, 503);
  }

  let ids;
  try {
    const raw = await kv.get("index");
    ids = raw ? JSON.parse(raw) : [];
  } catch {
    return json({ error: "Failed to read prototype index." }, 503);
  }

  // Fetch all prototypes in parallel
  let prototypes = [];
  try {
    const entries = await Promise.all(
      ids.map(async (id) => {
        const raw = await kv.get(`proto:${id}`);
        return raw ? JSON.parse(raw) : null;
      })
    );
    // Filter nulls (deleted/missing entries), newest first
    prototypes = entries.filter(Boolean).reverse();
  } catch {
    return json({ error: "Failed to read prototypes from datastore." }, 503);
  }

  return json({ prototypes });
}

// ─── POST: submit a new prototype ────────────────────────────────────────────
export async function onRequestPost({ request, env }) {
  const kv = env.PROTOTYPES_KV;
  if (!kv) {
    return json({ error: "Datastore unavailable. Check KV binding." }, 503);
  }

  // Parse body
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body." }, 400);
  }

  // Validate required fields
  const { name, title, url, summary } = body ?? {};
  const missing = [];
  if (!name || typeof name !== "string" || !name.trim()) missing.push("name");
  if (!title || typeof title !== "string" || !title.trim()) missing.push("title");
  if (!url || typeof url !== "string" || !url.trim()) missing.push("url");
  if (!summary || typeof summary !== "string" || !summary.trim()) missing.push("summary");

  if (missing.length) {
    return json({ error: `Missing required fields: ${missing.join(", ")}.` }, 400);
  }

  // Basic URL format check
  try {
    new URL(url.trim());
  } catch {
    return json({ error: "Invalid URL format. Must be a full URL including https://." }, 400);
  }

  // Length guards
  if (name.trim().length > 100)    return json({ error: "name must be 100 characters or fewer." }, 400);
  if (title.trim().length > 150)   return json({ error: "title must be 150 characters or fewer." }, 400);
  if (url.trim().length > 500)     return json({ error: "url must be 500 characters or fewer." }, 400);
  if (summary.trim().length > 500) return json({ error: "summary must be 500 characters or fewer." }, 400);

  // Reject unexpected fields — keep the datastore clean
  const allowed = new Set(["name", "title", "url", "summary"]);
  const extra = Object.keys(body).filter((k) => !allowed.has(k));
  if (extra.length) {
    return json({ error: `Unexpected fields: ${extra.join(", ")}.` }, 400);
  }

  // Build prototype object
  const id = crypto.randomUUID();
  const prototype = {
    id,
    name: name.trim(),
    title: title.trim(),
    url: url.trim(),
    summary: summary.trim(),
    submittedAt: new Date().toISOString(),
  };

  // Write prototype entry
  try {
    await kv.put(`proto:${id}`, JSON.stringify(prototype));
  } catch {
    return json({ error: "Failed to save prototype. Please try again." }, 503);
  }

  // Update index
  try {
    const raw = await kv.get("index");
    const ids = raw ? JSON.parse(raw) : [];
    ids.push(id);
    await kv.put("index", JSON.stringify(ids));
  } catch {
    // Prototype was saved but index update failed — log and return partial success
    return json(
      { error: "Prototype saved but index update failed. Contact the sprint lead.", prototype },
      207
    );
  }

  return json({ prototype }, 201);
}
