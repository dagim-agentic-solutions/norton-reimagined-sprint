/**
 * DELETE /api/prototypes/:id
 * Scope: norton-reimagined-sprint only.
 * Password-protected — caller must send { password: "Norton" } in the JSON body.
 * Removes the prototype from KV index and deletes its data + any uploaded file.
 */

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const DELETE_PASSWORD = "Norton";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestDelete({ params, request, env }) {
  const kv = env.PROTOTYPES_KV;
  if (!kv) return json({ error: "Datastore unavailable." }, 503);

  // Parse body
  let body;
  try { body = await request.json(); }
  catch { return json({ error: "Invalid JSON body." }, 400); }

  // Password check
  if (!body?.password || body.password !== DELETE_PASSWORD) {
    return json({ error: "Incorrect password." }, 401);
  }

  const id = params.id;
  if (!id) return json({ error: "Missing prototype ID." }, 400);

  // Verify it exists
  const existing = await kv.get(`proto:${id}`);
  if (!existing) return json({ error: "Prototype not found." }, 404);

  // Remove from index
  try {
    const raw = await kv.get("index");
    const ids = raw ? JSON.parse(raw) : [];
    const updated = ids.filter(i => i !== id);
    await kv.put("index", JSON.stringify(updated));
  } catch {
    return json({ error: "Failed to update index." }, 503);
  }

  // Delete prototype data
  await kv.delete(`proto:${id}`).catch(() => {});

  // Delete uploaded file if present
  await kv.delete(`file:${id}`).catch(() => {});

  return json({ success: true, id });
}
