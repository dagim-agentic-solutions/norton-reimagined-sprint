const JSON_H = { 'Content-Type': 'application/json' };
const KEY = slug => `concept-cards:${slug}`;
const MAX_CARDS = 200;

async function getCards(kv, slug) {
  const raw = await kv.get(KEY(slug));
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}

async function saveCards(kv, slug, cards) {
  await kv.put(KEY(slug), JSON.stringify(cards));
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_H });
}

export async function onRequestGet({ env, request }) {
  const url = new URL(request.url);
  const slug = (url.searchParams.get('slug') || 'norton').toLowerCase();
  const cards = await getCards(env.PROTOTYPES_KV, slug);
  return json({ ok: true, cards });
}

export async function onRequestPost({ env, request }) {
  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON' }, 400); }

  const slug = (body.slug || 'norton').toLowerCase();
  const participant = String(body.participant || 'Anonymous').slice(0, 80);
  const headline = String(body.headline || '').trim();
  const subheadline = String(body.subheadline || '').trim();
  const howItWorks = String(body.howItWorks || '').trim();
  const proofPoint = String(body.proofPoint || '').trim();
  const benefits = Array.isArray(body.benefits) ? body.benefits.slice(0, 3) : [];

  if (!headline) return json({ error: 'Headline is required.' }, 400);

  const normalizedBenefits = benefits.map((b = {}) => ({
    title: String(b.title || '').slice(0, 80).trim(),
    description: String(b.description || '').slice(0, 240).trim(),
  }));

  const card = {
    id: crypto.randomUUID(),
    participant,
    headline,
    subheadline,
    benefits: normalizedBenefits,
    howItWorks,
    proofPoint,
    createdAt: Date.now(),
  };

  const cards = await getCards(env.PROTOTYPES_KV, slug);
  cards.push(card);
  if (cards.length > MAX_CARDS) {
    cards.splice(0, cards.length - MAX_CARDS);
  }
  await saveCards(env.PROTOTYPES_KV, slug, cards);

  if (env.CONCEPT_CARD_BROADCAST_URL) {
    fetch(env.CONCEPT_CARD_BROADCAST_URL, {
      method: 'POST',
      headers: JSON_H,
      body: JSON.stringify({ type: 'concept-card:created', payload: { ...card, slug } }),
    }).catch(() => {});
  }

  return json({ ok: true, card });
}
