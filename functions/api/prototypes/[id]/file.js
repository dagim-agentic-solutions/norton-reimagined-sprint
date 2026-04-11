const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

function base64ToUint8(base64) {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestGet({ params, env }) {
  const kv = env.PROTOTYPES_KV;
  if (!kv) return json({ error: 'Datastore unavailable.' }, 503);

  const id = params.id;
  if (!id) return json({ error: 'Missing prototype ID.' }, 400);

  const raw = await kv.get(`proto:${id}`);
  if (!raw) return json({ error: 'Prototype not found.' }, 404);

  const proto = JSON.parse(raw);
  if (proto.sourceType !== 'file') {
    return json({ error: 'This prototype does not have a downloadable file.' }, 400);
  }

  let fileContent = proto.fileContent || '';
  if (!fileContent && proto.fileStoredSeparately) {
    fileContent = await kv.get(`file:${id}`);
  }
  if (!fileContent) return json({ error: 'File unavailable.' }, 404);

  const encoding = (proto.encoding || 'base64').toLowerCase();
  let body;
  if (encoding === 'base64') {
    body = base64ToUint8(fileContent);
  } else {
    body = new TextEncoder().encode(fileContent);
  }

  const headers = new Headers({
    ...CORS,
    'Content-Type': proto.mimeType || 'application/octet-stream',
    'Content-Disposition': `inline; filename="${proto.fileName || 'prototype'}"`,
  });

  return new Response(body, { status: 200, headers });
}
