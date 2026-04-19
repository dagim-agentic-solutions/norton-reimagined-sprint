import { runLLM } from "../_lib/llmRouter";
import { ensureAdmin } from "../_lib/adminAuth.js";

/**
 * POST /api/pricing-strategy
 * Evaluates a 3-tier subscription pricing strategy against Laura persona + competitive market.
 *
 * Request body: {
 *   prototype: { id, title, name, summary, lauraScore, lauraVerdict, lauraRecommendation,
 *                lauraEngagementChallenge, lauraCompetitorGap },
 *   tiers: [{ name, price, features, jtbd }],  // exactly 3
 *   additionalDetails: string (optional)
 * }
 */

const ALLOWED_ORIGIN = "*";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, x-admin-key, x-sprintbox-key, Authorization",
  };
}

function guard(request, env) {
  const auth = ensureAdmin(request, env);
  if (!auth.ok) {
    return new Response(JSON.stringify({ error: auth.error || "Unauthorized" }), {
      status: auth.status || 401,
      headers: { "Content-Type": "application/json", ...corsHeaders() },
    });
  }
  return null;
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

export async function onRequestPost({ request, env }) {
  const denied = guard(request, env);
  if (denied) return denied;

  const headers = { "Content-Type": "application/json", ...corsHeaders() };

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body." }), { status: 400, headers });
  }

  const { prototype, tiers, additionalDetails } = body;

  if (!prototype || !prototype.title) {
    return new Response(JSON.stringify({ error: "Missing prototype." }), { status: 400, headers });
  }
  if (!Array.isArray(tiers) || tiers.length !== 3) {
    return new Response(JSON.stringify({ error: "Exactly 3 tiers required." }), { status: 400, headers });
  }
  for (let i = 0; i < 3; i++) {
    if (!tiers[i].name || !tiers[i].price) {
      return new Response(
        JSON.stringify({ error: `Tier ${i + 1} is missing name or price.` }),
        { status: 400, headers }
      );
    }
  }

  // Build Laura scoring context if available
  const lauraLines = [];
  if (prototype.lauraScore != null) lauraLines.push(`Laura Score: ${prototype.lauraScore}/100 (${prototype.lauraVerdict || ""})`);
  if (prototype.lauraRecommendation) lauraLines.push(`Laura Recommendation: ${prototype.lauraRecommendation}`);
  if (prototype.lauraEngagementChallenge) lauraLines.push(`Engagement Challenge: ${prototype.lauraEngagementChallenge}`);
  if (prototype.lauraCompetitorGap) lauraLines.push(`Competitor Gap: ${prototype.lauraCompetitorGap}`);
  const lauraBlock = lauraLines.length ? `\n${lauraLines.join("\n")}` : "";

  const formatTier = (t, i) =>
    `TIER ${i + 1}: ${t.name} — ${t.price}
Features: ${Array.isArray(t.features) ? t.features.join(", ") || "None specified" : t.features || "None specified"}
Customer Story / JTBD: ${t.jtbd || "Not provided"}`;

  const prompt = `You are a world-class product strategist evaluating a 3-tier subscription pricing strategy for a Norton security product.

PRODUCT: ${prototype.title} — ${prototype.summary || "No summary provided"}${lauraBlock}

PRICING:
${tiers.map((t, i) => formatTier(t, i)).join("\n\n")}

TARGET PERSONA — LAURA:
- 35-55, working parent, household of 5-10 devices
- Wants security to "just work", minimal admin
- Price-sensitive but pays for clear value
- Rejects complexity, jargon, unclear tier differentiation

COMPETITORS: Norton 360 ($39.99-99.99/yr), Aura ($12-37/mo), LifeLock ($8.99-34.99/mo), McAfee+ ($39.99-149.99/yr), Google One with security ($2.99-9.99/mo)

${additionalDetails ? `ADDITIONAL CONTEXT: ${additionalDetails}\n\n` : ""}Evaluate rigorously. Return ONLY valid JSON (no markdown):
{
  "lauraComprehension": { "score": 0-100, "verdict": "CLEAR|CONFUSING|UNCLEAR", "explanation": "2-3 sentences", "issues": [] },
  "tierClarity": { "score": 0-100, "verdict": "OBVIOUS|MODERATE|UNCLEAR", "explanation": "2-3 sentences", "issues": [] },
  "competitiveViability": { "score": 0-100, "verdict": "STRONG|MODERATE|WEAK", "explanation": "2-3 sentences", "threats": [] },
  "overallVerdict": "STRONG|PROMISING|NEEDS WORK|RETHINK",
  "overallScore": 0-100,
  "overallSummary": "3-4 sentences",
  "recommendations": [{ "tier": "tier name or All Tiers", "type": "name|price|features|story|positioning", "current": "what it is", "suggested": "what to change", "reason": "why" }]
}`;

  try {
    const rawText = await runLLM({
      env,
      mode: "strategy",
      messages: [{ role: "user", content: prompt }],
      maxTokens: 2000,
      temperature: 0.2,
    });

    const cleaned = rawText
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "")
      .trim();

    const result = JSON.parse(cleaned);
    return new Response(JSON.stringify(result), { status: 200, headers });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: "LLM error", detail: err.message }),
      { status: 502, headers }
    );
  }
}
