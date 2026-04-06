/**
 * /api/prototypes
 * Scope: norton-reimagined-sprint only.
 *
 * GET  → returns all submitted prototypes, newest first
 * POST → submits a new prototype; accepts either a URL (priority) or
 *        a raw HTML/JS file (stored in KV, served at /api/prototypes/:id/file)
 *
 * KV binding: PROTOTYPES_KV
 * Index key:    "index"         → JSON array of prototype IDs (insertion order)
 * Data keys:    "proto:<id>"    → JSON prototype object
 * File keys:    "file:<id>"     → { fileName, content } (only when file submitted)
 *
 * No npm dependencies — built-in fetch only.
 */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const MAX_FILE_BYTES = 500 * 1024; // 500 KB

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
  if (!kv) return json({ error: "Datastore unavailable. Check KV binding." }, 503);

  let ids;
  try {
    const raw = await kv.get("index");
    ids = raw ? JSON.parse(raw) : [];
  } catch {
    return json({ error: "Failed to read prototype index." }, 503);
  }

  let prototypes = [];
  try {
    const entries = await Promise.all(
      ids.map(async (id) => {
        const raw = await kv.get(`proto:${id}`);
        return raw ? JSON.parse(raw) : null;
      })
    );
    prototypes = entries.filter(Boolean).reverse(); // newest first
  } catch {
    return json({ error: "Failed to read prototypes from datastore." }, 503);
  }

  return json({ prototypes });
}

// ─── POST: submit a new prototype ────────────────────────────────────────────
export async function onRequestPost({ request, env }) {
  const kv = env.PROTOTYPES_KV;
  if (!kv) return json({ error: "Datastore unavailable. Check KV binding." }, 503);

  // Parse body
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body." }, 400);
  }

  const { name, title, url, summary, fileContent, fileName } = body ?? {};

  // ── Required field validation ──────────────────────────────────────────────
  const missing = [];
  if (!name    || typeof name    !== "string" || !name.trim())    missing.push("name");
  if (!title   || typeof title   !== "string" || !title.trim())   missing.push("title");
  if (!summary || typeof summary !== "string" || !summary.trim()) missing.push("summary");

  // Must have EITHER url OR fileContent+fileName
  const hasUrl  = url && typeof url === "string" && url.trim();
  const hasFile = fileContent && typeof fileContent === "string" && fileContent.trim()
               && fileName  && typeof fileName  === "string" && fileName.trim();

  if (!hasUrl && !hasFile) {
    missing.push("url or fileContent+fileName (at least one required)");
  }

  if (missing.length) {
    return json({ error: `Missing required fields: ${missing.join(", ")}.` }, 400);
  }

  // ── URL validation (when provided) ────────────────────────────────────────
  if (hasUrl) {
    try { new URL(url.trim()); } catch {
      return json({ error: "Invalid URL format. Must be a full URL including https://." }, 400);
    }
  }

  // ── File validation (when provided and no URL) ─────────────────────────────
  if (hasFile && !hasUrl) {
    const ext = fileName.trim().split(".").pop().toLowerCase();
    if (!["html", "js"].includes(ext)) {
      return json({ error: "Only .html and .js files are accepted." }, 400);
    }
    const byteSize = new TextEncoder().encode(fileContent).length;
    if (byteSize > MAX_FILE_BYTES) {
      return json({ error: `File exceeds the 500 KB limit (submitted: ${Math.round(byteSize / 1024)} KB).` }, 400);
    }
  }

  // ── Length guards ──────────────────────────────────────────────────────────
  if (name.trim().length    > 100) return json({ error: "name must be 100 characters or fewer." }, 400);
  if (title.trim().length   > 150) return json({ error: "title must be 150 characters or fewer." }, 400);
  if (summary.trim().length > 500) return json({ error: "summary must be 500 characters or fewer." }, 400);
  if (hasUrl && url.trim().length > 500) return json({ error: "url must be 500 characters or fewer." }, 400);

  // ── Reject unexpected fields ───────────────────────────────────────────────
  const allowed = new Set(["name", "title", "url", "summary", "fileContent", "fileName"]);
  const extra = Object.keys(body).filter((k) => !allowed.has(k));
  if (extra.length) return json({ error: `Unexpected fields: ${extra.join(", ")}.` }, 400);

  // ── Build prototype object ─────────────────────────────────────────────────
  const id = crypto.randomUUID();

  // URL wins if both provided; otherwise fall back to the hosted file URL
  const resolvedUrl = hasUrl
    ? url.trim()
    : `/api/prototypes/${id}/file`;

  const prototype = {
    id,
    name:        name.trim(),
    title:       title.trim(),
    url:         resolvedUrl,
    summary:     summary.trim(),
    submittedAt: new Date().toISOString(),
    // Surface whether this is a hosted file so the UI can label it
    sourceType:  hasUrl ? "url" : "file",
    ...(hasFile && !hasUrl ? { fileName: fileName.trim() } : {}),
  };

  // ── Persist file content (only when no URL provided) ──────────────────────
  if (hasFile && !hasUrl) {
    try {
      await kv.put(`file:${id}`, JSON.stringify({
        fileName: fileName.trim(),
        content:  fileContent,
      }));
    } catch {
      return json({ error: "Failed to store uploaded file. Please try again." }, 503);
    }
  }

  // ── Persist prototype metadata ─────────────────────────────────────────────
  try {
    await kv.put(`proto:${id}`, JSON.stringify(prototype));
  } catch {
    return json({ error: "Failed to save prototype. Please try again." }, 503);
  }

  // ── Update index ───────────────────────────────────────────────────────────
  try {
    const raw = await kv.get("index");
    const ids = raw ? JSON.parse(raw) : [];
    ids.push(id);
    await kv.put("index", JSON.stringify(ids));
  } catch {
    return json(
      { error: "Prototype saved but index update failed. Contact the sprint lead.", prototype },
      207
    );
  }

  return json({ prototype }, 201);
}
