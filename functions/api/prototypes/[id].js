/**
 * DELETE /api/prototypes/:id
 * Removes a prototype from KV index + data.
 */

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "DELETE, PATCH, OPTIONS",
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

/**
 * PATCH /api/prototypes/:id
 * Body: { action: "rescore" } — re-runs Laura visual scoring and updates KV.
 */
import { crawlPrototype, buildVisionContent } from '../../_lib/visualCrawler.js';

// ── Deep text extraction (duplicated here to avoid cross-file import issues) ─
function extractDeepText(html) {
  const extras = [];
  for (const m of html.matchAll(/(?:aria-label|alt|placeholder|title)="([^"]{2,120})"/gi)) {
    extras.push(m[1]);
  }
  const withHints = html
    .replace(/<(h[1-6])[^>]*>([\s\S]*?)<\/\1>/gi, (_, tag, inner) => `[${tag.toUpperCase()}] ${inner} `)
    .replace(/<button[^>]*>([\s\S]*?)<\/button>/gi, (_, inner) => `[BTN] ${inner} `)
    .replace(/<a[^>]*>([\s\S]*?)<\/a>/gi, (_, inner) => `[LINK] ${inner} `)
    .replace(/<(label|span|p|li|td|th)[^>]*>([\s\S]*?)<\/\1>/gi, (_, _t, inner) => inner + ' ');
  const cleaned = withHints
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
  return (extras.join(' | ') + ' ' + cleaned).slice(0, 12000);
}

const LAURA_CONTEXT_RESCORE = `
You are evaluating a product prototype against TWO lenses simultaneously:
(1) Laura — the target persona
(2) Norton's three business objectives

Your final 0–100 score is a weighted composite:
  - 50% Laura (does she love it, use it regularly, find it effortless?)
  - 25% Engagement (does it shift Norton from set-and-forget to a tool Laura returns to daily/weekly?)
  - 15% Growth (does it give Norton a credible edge vs. Apple Security, Google One, LifeLock, Aura, standalone scam apps?)
  - 10% Protection Heritage (does it preserve Norton's identity as the gold standard in protection?)

LAURA IN ONE LINE: She is the guardian of her household's digital life — but she doesn't want the job. She wants a trusted expert to quietly handle it in the background, the way insurance or utilities do.

WHO SHE IS:
- 35–55, working parent, full household (partner + kids), 5–10 devices across family
- Mass-market premium income, comfortable paying for quality protection
- Tech-comfortable but not "IT people" — adopts tools that reduce effort and anxiety
- Carries the mental load of keeping family safe and is burnt out being the household IT person

HER 4 JOBS TO BE DONE:
1. Protect my whole household with as little admin from me as possible
2. Block threats before we click (scams, dodgy sites, sketchy downloads)
3. Keep my kids safe online with simple, trustworthy controls
4. Tell me what to do when something looks wrong, in plain language

BUSINESS OBJECTIVE: ENGAGEMENT — Norton must shift from set-and-forget to a product Laura actively opens daily/weekly. Does this prototype give her a natural recurring reason to return?

BUSINESS OBJECTIVE: GROWTH — Does this give Norton a clear "why Norton vs. anything else"? Is it defensible against Apple, Google, LifeLock, and standalone apps?

BUSINESS OBJECTIVE: PROTECTION HERITAGE — Does this still feel like Norton at its best — the next chapter of 30 years of protection — rather than a random pivot to fintech or social media?

SCORING (0–100): 90-100 → LOVES IT | 75-89 → LIKES IT | 55-74 → MEH | 35-54 → SKEPTICAL | 0-34 → REJECTS IT
`;

export async function onRequestPatch({ params, request, env }) {
  const kv = env.PROTOTYPES_KV;
  if (!kv) return json({ error: 'Datastore unavailable.' }, 503);

  const id = params.id;
  if (!id) return json({ error: 'Missing prototype ID.' }, 400);

  let body = {};
  try { body = await request.json(); } catch {}
  if (body.action !== 'rescore') return json({ error: 'Unknown action. Use action: "rescore".' }, 400);
  if (!env.ANTHROPIC_API_KEY) return json({ error: 'ANTHROPIC_API_KEY not configured.' }, 503);

  // Fetch prototype
  const raw = await kv.get(`proto:${id}`);
  if (!raw) return json({ error: 'Prototype not found.' }, 404);
  const proto = JSON.parse(raw);

  const protoUrl = proto.url || proto.resolvedUrl || '';
  let crawlResult = { screens: [], textContent: '' };

  // Load fileContent from KV if stored separately
  let rescoreFileContent = proto.fileContent || '';
  if (!rescoreFileContent && proto.fileStoredSeparately) {
    try { rescoreFileContent = await kv.get(`file:${id}`) || ''; } catch {}
  }
  if (protoUrl && !protoUrl.startsWith('/api/')) {
    try { crawlResult = await crawlPrototype(protoUrl, { fileContent: rescoreFileContent }); } catch {}
  }
  const textFallback = extractDeepText(crawlResult.textContent || '');
  const screensFound = crawlResult.screens.filter(s => s.base64).length;

  const metaContext = [
    `Title: "${proto.title}"`,
    `Submitted by: ${proto.name}`,
    `Summary: ${proto.summary || ''}`,
    textFallback ? `\nExtracted text from all screens:\n${textFallback}` : '',
  ].join('\n');

  const instruction = `${LAURA_CONTEXT_RESCORE}

---
PROTOTYPE TO EVALUATE:
${metaContext}

${screensFound > 0 ? `You are being shown ${crawlResult.screens.length} screenshot(s) of the prototype. Study EVERY screen carefully.` : 'No screenshots available — use extracted text above.'}

---
Respond with ONLY a valid JSON object — no prose, no markdown fences:
{
  "score": <integer 0-100>,
  "verdict": "<LOVES IT | LIKES IT | MEH | SKEPTICAL | REJECTS IT>",
  "recommendation": "<2-3 sentences — what Laura thinks AND how well it serves Norton's engagement/growth/heritage objectives>",
  "engagementScore": <integer 0-100, how well it drives recurring use>,
  "growthScore": <integer 0-100, how well it positions Norton competitively>,
  "heritageScore": <integer 0-100, how well it honours Norton's protection identity>
}
Verdict bands: 90-100 → LOVES IT | 75-89 → LIKES IT | 55-74 → MEH | 35-54 → SKEPTICAL | 0-34 → REJECTS IT`;

  const msgContent = screensFound > 0 ? buildVisionContent(crawlResult.screens, instruction) : instruction;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-opus-4-5', max_tokens: 400, messages: [{ role: 'user', content: msgContent }] }),
  });
  if (!res.ok) return json({ error: `Anthropic error ${res.status}` }, 502);

  const data = await res.json();
  const rawText = (data?.content?.[0]?.text ?? '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  let result;
  try { result = JSON.parse(rawText); } catch { return json({ error: 'Failed to parse LLM response', raw: rawText.slice(0, 200) }, 500); }

  // Write updated scores back to KV
  const updated = {
    ...proto,
    lauraScore: result.score ?? proto.lauraScore,
    lauraVerdict: result.verdict ?? proto.lauraVerdict,
    lauraRecommendation: result.recommendation ?? proto.lauraRecommendation,
    lauraEngagementScore: result.engagementScore ?? null,
    lauraGrowthScore: result.growthScore ?? null,
    lauraHeritageScore: result.heritageScore ?? null,
    lauraRescored: new Date().toISOString(),
    lauraScreensAnalyzed: crawlResult.screens.length,
  };
  await kv.put(`proto:${id}`, JSON.stringify(updated));

  return json({
    ok: true,
    id,
    title: proto.title,
    lauraScore: updated.lauraScore,
    lauraVerdict: updated.lauraVerdict,
    lauraRecommendation: updated.lauraRecommendation,
    lauraEngagementScore: updated.lauraEngagementScore,
    lauraGrowthScore: updated.lauraGrowthScore,
    lauraHeritageScore: updated.lauraHeritageScore,
    screensAnalyzed: crawlResult.screens.length,
  });
}
