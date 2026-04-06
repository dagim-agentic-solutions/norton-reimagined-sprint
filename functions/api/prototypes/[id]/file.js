/**
 * GET /api/prototypes/:id/file
 * Serves a raw HTML or JS file that was uploaded with a prototype submission.
 * Scope: norton-reimagined-sprint only.
 */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestGet({ params, env }) {
  const kv = env.PROTOTYPES_KV;
  if (!kv) {
    return new Response(JSON.stringify({ error: "Datastore unavailable." }), {
      status: 503,
      headers: { "Content-Type": "application/json", ...CORS },
    });
  }

  const id = params.id;
  if (!id) {
    return new Response(JSON.stringify({ error: "Missing prototype ID." }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...CORS },
    });
  }

  let stored;
  try {
    stored = await kv.get(`file:${id}`, "json");
  } catch {
    return new Response(JSON.stringify({ error: "Failed to retrieve file." }), {
      status: 503,
      headers: { "Content-Type": "application/json", ...CORS },
    });
  }

  if (!stored) {
    return new Response(JSON.stringify({ error: "File not found." }), {
      status: 404,
      headers: { "Content-Type": "application/json", ...CORS },
    });
  }

  const contentType = stored.fileName?.endsWith(".js")
    ? "text/javascript; charset=utf-8"
    : "text/html; charset=utf-8";

  return new Response(stored.content, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `inline; filename="${stored.fileName}"`,
      ...CORS,
    },
  });
}
