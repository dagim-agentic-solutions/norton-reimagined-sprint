import { runLLM } from '../_lib/llmRouter.js';

const KV_KEY = 'hmw:board';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const SYSTEM_PROMPT = `You are an expert UX researcher helping a Norton design sprint team convert customer pain points into "How Might We" (HMW) statements.

STRICT FORMAT — every HMW must follow this exact pattern:
"How might we help Laura [do/feel/achieve] when she's [situation] so that [outcome]?"

RULES:
- Always start with: "How might we help Laura"
- Verb slot: ONLY use "do", "feel", or "achieve" — no other verbs
- Use "do" for tasks/behaviours, "feel" for emotional states, "achieve" for goals/results
- No solutions — never mention UI patterns, tooltips, redesigns, or technical implementations
- No jargon — never use CVR, AOV, NPS or similar metrics in the HMW
- Positive/outcome-oriented — focus on what Laura gains
- Short and scannable — target under 35 words per HMW
- When pain point is vague, add reasonable specificity — never mirror vagueness
- Never ask follow-up questions — always infer and generate

LAURA: A 35-55 working parent who is her household's digital guardian but does not want to be the family IT person. She wants protection to just work, quietly, in the background.

TAGS — assign 1-3 per HMW from: emotion-focused, decision-friction, trust, onboarding, engagement, protection, family, setup-complexity, discovery, control, transparency, value-perception

Return ONLY valid JSON, no prose, no markdown fences:
{
  "results": [
    {
      "original_pain_point": "exact pain point text",
      "hmw_full": "How might we help Laura ...",
      "do_feel_achieve": "do|feel|achieve",
      "situation": "concise situation phrase",
      "outcome": "concise outcome phrase",
      "tags": ["tag1", "tag2"],
      "variants": []
    }
  ]
}`;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

function wordSet(text) {
  return new Set(text.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(Boolean));
}

function jaccardOverlap(a, b) {
  const setA = wordSet(a);
  const setB = wordSet(b);
  let intersection = 0;
  for (const w of setA) {
    if (setB.has(w)) intersection++;
  }
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
}

function extractJSON(text) {
  // Strip markdown fences
  text = text.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '');
  // Find outermost { }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('No JSON object found');
  return JSON.parse(text.slice(start, end + 1));
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function onRequestGet({ env }) {
  const kv = env.PROTOTYPES_KV;
  if (!kv) return json({ error: 'KV unavailable' }, 503);
  const raw = await kv.get(KV_KEY);
  const items = raw ? JSON.parse(raw) : [];
  return json({ items });
}

export async function onRequestDelete({ request, env }) {
  const kv = env.PROTOTYPES_KV;
  if (!kv) return json({ error: 'KV unavailable' }, 503);
  const url = new URL(request.url);
  const id = url.searchParams.get('id');
  if (!id) return json({ error: 'Missing id' }, 400);

  const raw = await kv.get(KV_KEY);
  const items = raw ? JSON.parse(raw) : [];
  const filtered = items.filter((item) => item.id !== id);
  await kv.put(KV_KEY, JSON.stringify(filtered));
  return json({ ok: true });
}

export async function onRequestPost({ request, env }) {
  const kv = env.PROTOTYPES_KV;
  if (!kv) return json({ error: 'KV unavailable' }, 503);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const { painPoints, variants = 1, channel = '', journeyStage = '', segment = '' } = body;

  if (!Array.isArray(painPoints) || painPoints.length === 0 || painPoints.length > 100) {
    return json({ error: 'painPoints must be an array of 1–100 items' }, 400);
  }

  // Build user prompt
  const contextParts = [];
  if (channel) contextParts.push(`Channel: ${channel}`);
  if (journeyStage) contextParts.push(`Journey stage: ${journeyStage}`);
  if (segment) contextParts.push(`Segment: ${segment}`);
  const contextLine = contextParts.length ? `\nContext: ${contextParts.join(' | ')}` : '';

  const userPrompt = `Convert each pain point below into ${variants} HMW statement(s). Return one result object per pain point.${contextLine}

Pain points:
${painPoints.map((p, i) => `${i + 1}. ${p}`).join('\n')}`;

  let parsed;
  try {
    const llmResponse = await runLLM({
      mode: 'strategy',
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
      maxTokens: 3000,
      env,
    });
    parsed = extractJSON(llmResponse);
    if (!parsed) throw new Error('Could not extract JSON from response: ' + (llmResponse || '').slice(0, 200));
  } catch (err) {
    return json({ error: 'LLM parsing failed', detail: err.message }, 502);
  }

  const results = (parsed && parsed.results) || [];

  // Load existing board
  const raw = await kv.get(KV_KEY);
  const existing = raw ? JSON.parse(raw) : [];

  const newItems = [];
  for (const r of results) {
    // De-duplicate: skip if >80% word overlap with any existing item
    const isDuplicate = existing.some(
      (ex) => jaccardOverlap(ex.hmwFull || '', r.hmw_full || '') > 0.8
    );
    if (isDuplicate) continue;

    const item = {
      id: crypto.randomUUID(),
      painPoint: r.original_pain_point || '',
      hmwFull: r.hmw_full || '',
      doFeelAchieve: r.do_feel_achieve || '',
      situation: r.situation || '',
      outcome: r.outcome || '',
      tags: r.tags || [],
      variants: r.variants || [],
      metadata: { channel, journeyStage, segment },
      createdAt: new Date().toISOString(),
    };
    newItems.push(item);
  }

  const updated = [...newItems, ...existing];
  await kv.put(KV_KEY, JSON.stringify(updated));

  // Broadcast via HMW_WS_URL
  if (newItems.length > 0 && env.HMW_WS_URL) {
    try {
      await fetch(`${env.HMW_WS_URL}/broadcast-hmw`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'hmw:new', items: newItems }),
      });
    } catch {
      // Non-fatal broadcast failure
    }
  }

  return json({ ok: true, items: newItems });
}
