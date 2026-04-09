/**
 * /api/dependency-assessment
 *
 * POST { protoId } → run (or return cached) dependency assessment
 * GET  ?protoId=   → return cached assessment or 404
 *
 * KV binding: PROTOTYPES_KV
 *   "dep-assessment::<protoId>" → { cachedAt, report }
 *   "proto:<protoId>"           → prototype object
 */

import { runLLM } from '../_lib/llmRouter.js';
import { crawlPrototype, buildVisionContent } from '../_lib/visualCrawler.js';
// ── Deep text extraction from HTML ─────────────────────────────────────────
// Preserves button labels, headings, link text, aria-labels so the LLM sees
// all screens and interactions in the prototype.
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




// ── Robust JSON extraction (module-level) ────────────────────────────────────
function extractJSON(raw) {
  if (!raw) return null;
  // Strip markdown fences (multiline)
  let s = raw.replace(/^```(?:json)?\s*/im, '').replace(/^```\s*$/im, '').trim();
  // Try direct parse
  try { return JSON.parse(s); } catch {}
  // Find outermost { ... } block
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

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

// ── GET: return cached report ──────────────────────────────────────────────────
export async function onRequestGet({ request, env }) {
  const kv = env.PROTOTYPES_KV;
  if (!kv) return json({ error: 'KV unavailable' }, 503);

  const url = new URL(request.url);
  const protoId = url.searchParams.get('protoId');
  if (!protoId) return json({ error: 'protoId is required' }, 400);

  const cached = await kv.get(`dep-assessment::${protoId}`);
  if (!cached) return json({ error: 'No cached assessment found' }, 404);

  try {
    return json({ cached: true, ...JSON.parse(cached) });
  } catch {
    return json({ error: 'Cached data corrupted' }, 500);
  }
}

// ── POST: generate (or return cached) assessment ──────────────────────────────
export async function onRequestPost({ request, env }) {
  const kv = env.PROTOTYPES_KV;
  if (!kv) return json({ error: 'KV unavailable' }, 503);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const { protoId, force } = body;
  if (!protoId || typeof protoId !== 'string') {
    return json({ error: 'protoId is required' }, 400);
  }

  // Check cache (skip if force=true)
  const cacheKey = `dep-assessment::${protoId}`;
  if (!force) {
    const cached = await kv.get(cacheKey);
    if (cached) {
      try {
        return json({ cached: true, ...JSON.parse(cached) });
      } catch {
        // Fall through to regenerate
      }
    }
  }

  // Fetch prototype
  const protoRaw = await kv.get(`proto:${protoId}`);
  if (!protoRaw) return json({ error: 'Prototype not found' }, 404);

  let proto;
  try {
    proto = JSON.parse(protoRaw);
  } catch {
    return json({ error: 'Prototype data corrupted' }, 500);
  }

  const title = proto.title || 'Untitled';
  const description = proto.description || '';
  const summary = proto.summary || proto.aiSummary || '';
  const capabilities = Array.isArray(proto.capabilities)
    ? proto.capabilities.join(', ')
    : (proto.capabilities || '');

  // ── Visual crawl + deep text extraction ─────────────────────────────────
  const protoUrl = proto.url || proto.resolvedUrl || '';
  let crawlResult = { screens: [], textContent: '' };
  if (protoUrl && !protoUrl.startsWith('/api/')) {
    try {
      crawlResult = await crawlPrototype(protoUrl, { fileContent: proto.fileContent || '' });
    } catch { /* fall through */ }
  } else if (proto.fileContent) {
    crawlResult.textContent = proto.fileContent;
  }
  const protoContent = extractDeepText(crawlResult.textContent || proto.fileContent || '');
  const screensFound = crawlResult.screens.filter(s => s.base64).length;

  const systemPrompt = `You are a technical dependency analyst for the Norton iOS app design sprint. Return ONLY valid JSON — no prose, no markdown fences.`;

  const userPrompt = `A prototype has been submitted with the following details:
Title: ${title}
Description: ${description}
Summary: ${summary}
Capabilities selected: ${capabilities}
${protoContent ? `\nPrototype content (all screens, buttons, and interactions extracted):\n${protoContent}` : ''}

Using the knowledge base below, produce a structured dependency assessment JSON.

## Knowledge Base

### Gen Shared Services
- OLP/COLP (Online Licensing Platform): Central licensing, subscription, SKU and entitlement platform. Enhancement = new APIs/behaviors/license types/entitlement changes. Config = adding/editing SKUs, SiteDirector rules, tenant flags.
- NGP/My Norton Portal: Cross-brand customer portal. Enhancement = new pages/flows/UX redesigns. Config = toggling features per tenant, navigation config, content copy.
- CCT (Cloud Connect): Client integration layer for device registration, entitlement checks. Enhancement = new client types, new flows/endpoints. Config = onboarding new app/tenant, updating client IDs, feature flags.
- NSL (Norton Secure Login): SSO/account system (OAuth/OIDC/SAML). Enhancement = new auth flows, token changes, new IDP flows. Config = registering clients, updating redirect URIs, policies.
- IPM Platform/MarTech: In-product messaging & experimentation. Enhancement = new templates, new decisioning logic. Config = creating/updating campaigns, audiences, copy.
- CDP (Customer Data Platform): Customer data and audience platform. Enhancement = new schemas, identity stitching. Config = defining segments, traits, journeys.
- NCS/UMO2 (Norton Cloud Services/Unified Messaging): Backend messaging/orchestration. Enhancement = new message types, channels. Config = routing rules, template bindings.
- Reputation Service ("Shasta"): URL reputation service for Safe Search, Safe Web. Enhancement = new APIs, detection logic. Config = allow/deny lists, thresholds.
- Norton Storage Platform/Backup (NSP): Cloud backup platform. Enhancement = new backup capabilities, API changes. Config = retention policies, storage tier mappings.
- Gen Score Service (GSS/Protection Score): Shared scoring service. Enhancement = new vectors, scoring algorithms. Config = weights, thresholds, rollout rules.

### Current Norton iOS App Features (these EXIST — do not flag as net-new)
Scam & Phishing: Genie/Scam Protection Hub, Safe Web, Safe SMS, Safe Call, Safe Email, Secure Calendar, Scam Support, Scam Reimbursement/Insurance.
Device & Network: Smart Scan, Device Security, Wi-Fi Security/Suspicious Network Detection, Device Report Card/Protection Report.
Privacy & VPN: Secure VPN, Ad Tracker Blocker.
Identity: Dark Web Monitoring, Privacy Monitor, Privacy Monitor Assistant.
Account: In-app Account & Device Management, Updated Onboarding/Permission Flows, Protection Score Tile.

### Net-New Builds
- NeoClaw — ALWAYS flag as net-new if seen. New scanning/detection engine, does not exist.
- Daily Digest — Flag as net-new ONLY if you see it in the prototype content above. Recurring summary notification/feed.
- Content Feed — Flag as net-new ONLY if you see it in the prototype content above. In-app content/article stream.
- Trending Scams — Flag as net-new ONLY if you see it in the prototype content above. Curated/dynamic scam alerts feed.

### Foundational Platform Builds (flag if prototype depends on any of these)
- Native Privacy Monitor experience
- Native Sign Up/Log In experience (OTP, Google/Apple login, email+password)
- Product Telemetry (in-app analytics/event tracking)
- Native License Sharing experience
- CSP Lineup Update (3-tier product lineup — still TBD, flag with open questions)
- Enhanced Profile/Settings

## Output Format
Return ONLY valid JSON, no prose, no markdown fences:
{
  "sharedServices": [
    { "service": "name", "workType": "config-change|enhancement|new-integration", "notes": "why" }
  ],
  "existingCapabilities": ["list of existing iOS features this prototype uses"],
  "netNewBuilds": ["list of net-new features needed"],
  "foundationalBuilds": ["list of foundational builds this depends on"],
  "riskFlags": ["list of ambiguous items needing human review"],
  "summary": "2-3 sentence plain-English summary of overall complexity"
}`;

  let reportText;
  try {
    if (screensFound > 0 && env.ANTHROPIC_API_KEY) {
      // Use Claude Vision with screenshots for thorough visual analysis
      const visionInstruction = userPrompt + `\n\nYou are being shown ${crawlResult.screens.length} screenshot(s) of every screen in this prototype. Study EVERY screen carefully — identify all UI elements, features, integrations, and interactions visible. Base your dependency assessment on what you actually see.`;
      const msgContent = buildVisionContent(crawlResult.screens, visionInstruction);
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-opus-4-5',
          max_tokens: 2500,
          system: systemPrompt + ' CRITICAL: Your entire response must be ONLY a raw JSON object. Do NOT use markdown fences, do NOT add any prose before or after the JSON.',
          messages: [{ role: 'user', content: msgContent }],
        }),
      });
      if (!res.ok) throw new Error(`Anthropic vision ${res.status}`);
      const data = await res.json();
      reportText = data?.content?.[0]?.text?.trim() || '';
    } else {
      // Fallback: text-only analysis via LLM router
      reportText = await runLLM({
        mode: 'execution',
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
        maxTokens: 2000,
        env,
      });
    }
  } catch (err) {
    return json({ error: `LLM error: ${err.message}` }, 502);
  }

  let report = extractJSON(reportText);
  if (!report) {
    // Final fallback: re-run with text-only (no vision) to get clean JSON
    try {
      const fallbackText = await runLLM({
        mode: 'execution',
        system: systemPrompt + ' You MUST respond with ONLY a valid JSON object — no prose, no markdown, no explanation.',
        messages: [{ role: 'user', content: userPrompt + '\n\nIMPORTANT: Return ONLY the raw JSON object. No prose before or after it.' }],
        maxTokens: 2000,
        env,
      });
      report = extractJSON(fallbackText);
    } catch {}
  }
  if (!report) {
    return json({ error: 'Failed to parse LLM response as JSON', raw: reportText.slice(0, 500) }, 500);
  }

  const cachedAt = new Date().toISOString();
  await kv.put(cacheKey, JSON.stringify({ cachedAt, report }));

  return json({ cached: false, cachedAt, report });
}
