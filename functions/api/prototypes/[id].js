/**
 * DELETE /api/prototypes/:id
 * Removes a prototype from KV index + data.
 */

import { ensureAdmin } from '../../_lib/adminAuth.js';

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

function guard(request, env) {
  const auth = ensureAdmin(request, env);
  if (!auth.ok) {
    return json({ error: auth.error || 'Unauthorized' }, auth.status || 401);
  }
  return null;
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestDelete({ request, params, env }) {
  const denied = guard(request, env);
  if (denied) return denied;
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
You are evaluating a product prototype with extreme rigour. Most sprint concepts are too incremental. Your default stance is SKEPTICAL — a prototype must actively earn a high score.

STRICT weighted composite:
  - 40% Engagement Reality: Would Laura genuinely return weekly/daily on her own?
  - 25% Differentiation: What can only Norton ship? Could Apple/Google/Aura copy it in 12 months?
  - 20% Persona Fit: Does this match Laura's actual life and mental model?
  - 10% Market Splash: Would non-subscribers hear about this and switch?
  - 5% Protection Heritage: Does it feel like the next Norton chapter, not a random pivot?

THE SECURITY-APP TRUTH:
- Laura never opens antivirus on purpose. If no proactive value is delivered, cap engagement at 35.
- "AI protection" is table stakes. Don't reward it unless it changes behaviour.
- Dashboards are not value. They are the status quo.
- Only give high marks if the concept creates a ritual Laura wants (morning digest, family confidence, etc.)

LAURA IN ONE LINE: Reluctant guardian of her household's digital life. Doesn't want the job. Wants a trusted expert to handle it invisibly.

WHO SHE IS:
- 35–55, working parent, 5–10 devices, mass-market premium income
- Tech-comfortable but not "IT people"
- Mental load: exhausted from being the family IT desk
- Wants automation, calm, and a single source of truth

HER 4 JOBS TO BE DONE:
1. Protect the whole household with zero admin
2. Block threats before they hit
3. Keep kids safe with trustworthy controls
4. Tell her plainly what happened and what (if anything) she must do

BRAND LEADER ADVANTAGE: Norton can shift mental models if the concept is bold AND believable. Reward ideas that reframe protection entirely (family digital wellness, digital infrastructure) while staying credible.

SCORING CALIBRATION (rarely give >70):
- 85–100 LOVES IT: Revolutionary on every lens
- 70–84 LIKES IT: Very strong, defensible, habit-forming
- 50–69 MEH: Solid but incremental
- 30–49 SKEPTICAL: Fundamental gaps
- 0–29 REJECTS IT: Fails persona or business objectives
`;

export async function onRequestPatch({ params, request, env }) {
  const denied = guard(request, env);
  if (denied) return denied;
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

Before scoring, answer for yourself:
1. Why would Laura open this next Tuesday morning when no alert fired?
2. What prevents Apple/Google/Aura from copying this inside a year?
3. Does this create a "Norton just reinvented ____" headline?

---
Respond with ONLY a valid JSON object — no prose, no markdown fences:
{
  "score": <integer 0-100, strict weighted composite>,
  "verdict": "<LOVES IT | LIKES IT | MEH | SKEPTICAL | REJECTS IT>",
  "recommendation": "<3-4 sentences: what Laura thinks, what would make her return weekly, and whether Norton actually wins>",
  "engagementScore": <integer 0-100>,
  "differentiationScore": <integer 0-100>,
  "growthScore": <integer 0-100>,
  "heritageScore": <integer 0-100>,
  "personaFitScore": <integer 0-100>,
  "engagementChallenge": "<why Laura would/wouldn't open weekly>",
  "competitorGap": "<who copies this fastest>",
  "wouldLauraOpenWeekly": <true | false>
}
Verdict bands: 85-100 → LOVES IT | 70-84 → LIKES IT | 50-69 → MEH | 30-49 → SKEPTICAL | 0-29 → REJECTS IT`;

  const msgContent = screensFound > 0 ? buildVisionContent(crawlResult.screens, instruction) : instruction;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-opus-4-5', max_tokens: 800, messages: [{ role: 'user', content: msgContent }] }),
  });
  if (!res.ok) return json({ error: `Anthropic error ${res.status}` }, 502);

  const data = await res.json();
  const rawText = (data?.content?.[0]?.text ?? '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  let result;
  try { result = JSON.parse(rawText); } catch { return json({ error: 'Failed to parse LLM response', raw: rawText.slice(0, 200) }, 500); }

  // Write updated scores back to KV
  const updated = {
    ...proto,
    lauraScore:               result.score                ?? proto.lauraScore,
    lauraVerdict:             result.verdict              ?? proto.lauraVerdict,
    lauraRecommendation:      result.recommendation       ?? proto.lauraRecommendation,
    lauraEngagementScore:     result.engagementScore      ?? null,
    lauraDifferentiationScore:result.differentiationScore ?? null,
    lauraGrowthScore:         result.growthScore          ?? null,
    lauraHeritageScore:       result.heritageScore        ?? null,
    lauraPersonaFitScore:     result.personaFitScore      ?? null,
    lauraEngagementChallenge: result.engagementChallenge  ?? null,
    lauraCompetitorGap:       result.competitorGap        ?? null,
    lauraWouldOpenWeekly:     result.wouldLauraOpenWeekly ?? null,
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
    lauraEngagementScore:      updated.lauraEngagementScore,
    lauraDifferentiationScore: updated.lauraDifferentiationScore,
    lauraGrowthScore:          updated.lauraGrowthScore,
    lauraHeritageScore:        updated.lauraHeritageScore,
    lauraPersonaFitScore:      updated.lauraPersonaFitScore,
    lauraEngagementChallenge:  updated.lauraEngagementChallenge,
    lauraCompetitorGap:        updated.lauraCompetitorGap,
    lauraWouldOpenWeekly:      updated.lauraWouldOpenWeekly,
    screensAnalyzed: crawlResult.screens.length,
  });
}
