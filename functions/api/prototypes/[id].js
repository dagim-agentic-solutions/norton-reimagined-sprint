/**
 * DELETE /api/prototypes/:id
 * Removes a prototype from KV index + data.
 */

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestDelete({ params, env }) {
  const kv = env.PROTOTYPES_KV;
  if (!kv) return json({ error: "Datastore unavailable." }, 503);

  const id = params.id;
  if (!id) return json({ error: "Missing prototype ID." }, 400);

  // Remove from index
  try {
    const raw = await kv.get("index");
    const ids = raw ? JSON.parse(raw) : [];
    await kv.put("index", JSON.stringify(ids.filter(i => i !== id)));
  } catch {
    return json({ error: "Failed to update index." }, 503);
  }

  // Delete prototype data and any associated file
  await kv.delete(`proto:${id}`).catch(() => {});
  await kv.delete(`file:${id}`).catch(() => {});

  return json({ ok: true, id });
}
