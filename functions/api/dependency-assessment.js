/**
 * /api/dependency-assessment
 *
 * POST { protoId, force? }
 *   → If cached and !force: return cached report immediately.
 *   → Otherwise: return { status: "pending", jobKey } immediately,
 *     kick off visual analysis via ctx.waitUntil (no timeout limit).
 *
 * GET ?protoId=
 *   → Return cached report, or { status: "pending" } if job is running, or 404.
 *
 * KV keys:
 *   "dep-assessment::<protoId>"       → { cachedAt, report }
 *   "dep-assessment-job::<protoId>"   → { status: "pending"|"error", startedAt, error? }
 */

import { runLLM } from '../_lib/llmRouter.js';
import { ensureAdmin } from '../_lib/adminAuth.js';
import { crawlPrototype, buildVisionContent } from '../_lib/visualCrawler.js';

// ── Deep text extraction ──────────────────────────────────────────────────────
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

// ── Robust JSON extraction ────────────────────────────────────────────────────
function extractJSON(raw) {
  if (!raw) return null;
  let s = raw.replace(/^```(?:json)?\s*/im, '').replace(/^```\s*$/im, '').trim();
  try { return JSON.parse(s); } catch {}
  let depth = 0, start = -1, end = -1;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '{') { if (depth === 0) start = i; depth++; }
    else if (s[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (start !== -1 && end > start) {
    try { return JSON.parse(s.slice(start, end + 1)); } catch {}
  }
  return null;
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
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

// ── GET: poll for result ──────────────────────────────────────────────────────
export async function onRequestGet({ request, env }) {
  const denied = guard(request, env);
  if (denied) return denied;
  const kv = env.PROTOTYPES_KV;
  if (!kv) return json({ error: 'KV unavailable' }, 503);

  const url = new URL(request.url);
  const protoId = url.searchParams.get('protoId');
  if (!protoId) return json({ error: 'protoId is required' }, 400);

  // Check for completed report
  const cached = await kv.get(`dep-assessment::${protoId}`);
  if (cached) {
    try { return json({ status: 'done', cached: true, ...JSON.parse(cached) }); } catch {}
  }

  // Check for in-progress job
  const job = await kv.get(`dep-assessment-job::${protoId}`);
  if (job) {
    try {
      const j = JSON.parse(job);
      return json({ status: j.status, startedAt: j.startedAt, error: j.error });
    } catch {}
  }

  return json({ status: 'not_found' }, 404);
}

// ── POST: kick off analysis ───────────────────────────────────────────────────
export async function onRequestPost({ request, env, ctx }) {
  const denied = guard(request, env);
  if (denied) return denied;
  const kv = env.PROTOTYPES_KV;
  if (!kv) return json({ error: 'KV unavailable' }, 503);

  if (!env.OPENAI_API_KEY && !env.ANTHROPIC_API_KEY && !env.GEMINI_API_KEY) {
    return json({ error: 'No LLM API keys configured. Use https://norton-reimagined-sprint.pages.dev' }, 503);
  }

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON body' }, 400); }

  const { protoId, force } = body;
  if (!protoId || typeof protoId !== 'string') return json({ error: 'protoId is required' }, 400);

  const cacheKey = `dep-assessment::${protoId}`;
  const jobKey   = `dep-assessment-job::${protoId}`;

  // Return cached result immediately if not forcing
  if (!force) {
    const cached = await kv.get(cacheKey);
    if (cached) {
      try { return json({ status: 'done', cached: true, ...JSON.parse(cached) }); } catch {}
    }
  }

  // Fetch prototype
  const protoRaw = await kv.get(`proto:${protoId}`);
  if (!protoRaw) return json({ error: 'Prototype not found' }, 404);

  let proto;
  try { proto = JSON.parse(protoRaw); } catch { return json({ error: 'Prototype data corrupted' }, 500); }

  // Mark job as pending
  await kv.put(jobKey, JSON.stringify({ status: 'pending', startedAt: new Date().toISOString() }), { expirationTtl: 600 });

  // ── Run analysis in background (no timeout limit) ─────────────────────────
  ctx.waitUntil(runAnalysis({ proto, protoId, cacheKey, jobKey, kv, env }));

  // Return pending immediately — frontend will poll GET
  return json({ status: 'pending', protoId });
}

// ── Core analysis (runs via waitUntil) ────────────────────────────────────────
async function runAnalysis({ proto, protoId, cacheKey, jobKey, kv, env }) {
  try {
    const title        = proto.title || 'Untitled';
    const description  = proto.description || '';
    const summary      = proto.summary || proto.aiSummary || '';
    const capabilities = Array.isArray(proto.capabilities) ? proto.capabilities.join(', ') : (proto.capabilities || '');
    const protoUrl     = proto.url || proto.resolvedUrl || '';

    // ── 1. Visual crawl — screenshot every screen ───────────────────────────
    let crawlResult = { screens: [], textContent: '' };
    if (protoUrl && !protoUrl.startsWith('/api/')) {
      try { crawlResult = await crawlPrototype(protoUrl, { fileContent: proto.fileContent || '' }); } catch {}
    } else if (proto.fileContent) {
      crawlResult.textContent = proto.fileContent;
    }

    const protoContent = extractDeepText(crawlResult.textContent || proto.fileContent || '');
    const screensFound = crawlResult.screens.filter(s => s.base64).length;

    const systemPrompt = `You are a technical dependency analyst for the Norton iOS app design sprint. Return ONLY valid JSON — no prose, no markdown fences.`;

    const knowledgeBase = `## Knowledge Base

### Gen Shared Services
- OLP/COLP: Central licensing, subscription, SKU and entitlement platform. Enhancement = new APIs/license types/entitlement changes. Config = adding/editing SKUs, SiteDirector rules, tenant flags.
- NGP/My Norton Portal: Cross-brand customer portal. Enhancement = new pages/flows/UX redesigns. Config = toggling features per tenant, navigation config, content copy.
- CCT (Cloud Connect): Client integration layer. Enhancement = new client types, new flows/endpoints. Config = onboarding new tenant, updating client IDs, feature flags.
- NSL (Norton Secure Login): SSO/account system. Enhancement = new auth flows, token changes. Config = registering clients, updating redirect URIs, policies.
- IPM Platform/MarTech: In-product messaging & experimentation. Enhancement = new templates, new decisioning logic. Config = creating/updating campaigns, audiences, copy.
- CDP (Customer Data Platform): Customer data and audience platform. Enhancement = new schemas, identity stitching. Config = defining segments, traits, journeys.
- NCS/UMO2: Backend messaging/orchestration. Enhancement = new message types, channels. Config = routing rules, template bindings.
- Reputation Service ("Shasta"): URL reputation for Safe Search, Safe Web. Enhancement = new APIs, detection logic. Config = allow/deny lists, thresholds.
- Norton Storage Platform/Backup (NSP): Cloud backup platform. Enhancement = new backup capabilities, API changes. Config = retention policies, storage tier mappings.
- Gen Score Service (GSS/Protection Score): Shared scoring service. Enhancement = new vectors, scoring algorithms. Config = weights, thresholds, rollout rules.

### Current Norton iOS Features (EXIST — do NOT flag as net-new)
Scam & Phishing: Genie/Scam Protection Hub, Safe Web, Safe SMS, Safe Call, Safe Email, Secure Calendar, Scam Support, Scam Reimbursement/Insurance.
Device & Network: Smart Scan, Device Security, Wi-Fi Security, Device Report Card/Protection Report.
Privacy & VPN: Secure VPN, Ad Tracker Blocker.
Identity: Dark Web Monitoring, Privacy Monitor, Privacy Monitor Assistant.
Account: In-app Account & Device Management, Updated Onboarding/Permission Flows, Protection Score Tile.

### Net-New Builds
- NeoClaw — ALWAYS net-new. New scanning/detection engine.
- Daily Digest — net-new ONLY if visible in prototype.
- Content Feed — net-new ONLY if visible in prototype.
- Trending Scams — net-new ONLY if visible in prototype.

### Foundational Platform Builds (flag if prototype depends on these)
- Native Privacy Monitor experience
- Native Sign Up/Log In (OTP, Google/Apple, email+password)
- Product Telemetry (in-app analytics/event tracking)
- Native License Sharing experience
- CSP Lineup Update (3-tier lineup — still TBD, flag with open questions)
- Enhanced Profile/Settings

## Output Format — ONLY this JSON, nothing else:
{
  "sharedServices": [{ "service": "name", "workType": "config-change|enhancement|new-integration", "notes": "why" }],
  "existingCapabilities": ["existing iOS features this prototype uses"],
  "netNewBuilds": ["net-new features needed"],
  "foundationalBuilds": ["foundational builds this depends on"],
  "riskFlags": ["ambiguous items needing human review"],
  "summary": "2-3 sentence plain-English summary of overall complexity"
}`;

    const userPrompt = `Prototype details:
Title: ${title}
Description: ${description}
Summary: ${summary}
Capabilities selected: ${capabilities}
${protoContent ? `\nExtracted content from all screens (buttons, headings, links, labels):\n${protoContent}` : ''}

${screensFound > 0 ? `${screensFound} screenshot(s) of every prototype screen are attached. Study EVERY screen — all UI elements, features, flows, interactions. Base your assessment on what you actually see in the screenshots AND the extracted text above.` : ''}

${knowledgeBase}`;

    let report = null;

    // ── 2. Vision path (preferred) — send screenshots to Claude ────────────
    if (screensFound > 0 && env.ANTHROPIC_API_KEY) {
      try {
        const msgContent = buildVisionContent(crawlResult.screens, userPrompt);
        const res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: 'claude-opus-4-5',
            max_tokens: 3000,
            system: systemPrompt + ' CRITICAL: respond with ONLY the raw JSON object. No markdown fences, no prose, no explanation.',
            messages: [{ role: 'user', content: msgContent }],
          }),
        });
        if (res.ok) {
          const data = await res.json();
          const raw = data?.content?.[0]?.text?.trim() || '';
          report = extractJSON(raw);
        }
      } catch {}
    }

    // ── 3. Text-only fallback ───────────────────────────────────────────────
    if (!report) {
      const textOnlyPrompt = userPrompt.replace(/\d+ screenshot\(s\).*\n/, '');
      const rawText = await runLLM({
        mode: 'execution',
        system: systemPrompt + ' Return ONLY a raw JSON object — no markdown fences, no prose.',
        messages: [{ role: 'user', content: textOnlyPrompt + '\n\nRespond with ONLY the JSON object.' }],
        maxTokens: 2500,
        env,
      });
      report = extractJSON(rawText);
    }

    if (!report) throw new Error('Could not parse LLM response as JSON after both vision and text attempts');

    // ── 4. Store result ─────────────────────────────────────────────────────
    const cachedAt = new Date().toISOString();
    await kv.put(cacheKey, JSON.stringify({
      cachedAt,
      report,
      screensAnalyzed: crawlResult.screens.length,
      visualAnalysis: screensFound > 0,
    }));
    await kv.delete(jobKey);

  } catch (err) {
    // Store error so frontend can surface it
    await kv.put(jobKey, JSON.stringify({
      status: 'error',
      startedAt: new Date().toISOString(),
      error: err.message,
    }), { expirationTtl: 300 });
  }
}
