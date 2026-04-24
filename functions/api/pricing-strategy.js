import { runLLM } from "../_lib/llmRouter";

/**
 * POST /api/pricing-strategy
 * Public endpoint — no auth required.
 * Evaluates a 3-tier subscription pricing strategy against Laura persona + competitive market.
 *
 * Request body: {
 *   prototype: { id, title, name, summary, lauraScore, lauraVerdict, lauraRecommendation,
 *                lauraEngagementChallenge, lauraCompetitorGap },
 *   tiers: [{ name, price, features, jtbd }],  // exactly 3
 *   additionalDetails: string (optional)
 * }
 */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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

export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body." }, 400);
  }

  const { prototype, tiers, additionalDetails } = body;

  if (!prototype || !prototype.title) {
    return json({ error: "Missing prototype." }, 400);
  }
  if (!Array.isArray(tiers) || tiers.length !== 3) {
    return json({ error: "Exactly 3 tiers required." }, 400);
  }
  for (let i = 0; i < 3; i++) {
    if (!tiers[i].name || !tiers[i].price) {
      return json({ error: `Tier ${i + 1} is missing name or price.` }, 400);
    }
  }

  // Build Laura scoring context if available
  const lauraLines = [];
  if (prototype.lauraScore != null) lauraLines.push(`Laura Score: ${prototype.lauraScore}/100 (${prototype.lauraVerdict || ""})`);
  if (prototype.lauraRecommendation) lauraLines.push(`Laura Recommendation: ${prototype.lauraRecommendation}`);
  if (prototype.lauraImprovementIdeas && prototype.lauraImprovementIdeas.length) {
    lauraLines.push('Improvement Ideas:');
    prototype.lauraImprovementIdeas.slice(0, 3).forEach((idea, idx) => {
      lauraLines.push(`  ${idx + 1}. ${idea}`);
    });
  }
  if (prototype.lauraEngagementChallenge) lauraLines.push(`Engagement Challenge: ${prototype.lauraEngagementChallenge}`);
  if (prototype.lauraCompetitorGap) lauraLines.push(`Competitor Gap: ${prototype.lauraCompetitorGap}`);
  const lauraBlock = lauraLines.length ? `\n${lauraLines.join("\n")}` : "";

  const formatTier = (t, i) =>
    `TIER ${i + 1}: ${t.name} — ${t.price}
Features: ${Array.isArray(t.features) && t.features.length ? t.features.join(", ") : "None specified"}
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

COMPETITIVE LANDSCAPE INSTRUCTIONS:
Do NOT use a fixed competitor list. Instead, infer the most relevant competitors based on what this product actually does (derived from the product concept, features selected, and customer stories).

Examples of how to map the concept to competitors:
- AI assistant / conversational AI → ChatGPT, Gemini, Claude, Copilot, Perplexity
- Family safety / parental controls / location sharing → Aura, Life360, Google Family Link, Apple Screen Time
- Identity theft protection / credit monitoring → Aura, Experian IdentityWorks, TransUnion TrueIdentity
- Password management → 1Password, Bitwarden, Dashlane
- VPN → ExpressVPN, NordVPN, Mullvad
- Antivirus / device protection → McAfee+, Bitdefender, Malwarebytes
- Digital wellness / privacy → Surfshark One, Privacy.com
- Broad security suite → McAfee+, Bitdefender Total Security, Google One with security

CRITICAL: Never include LifeLock as a competitor — LifeLock is part of Norton's own product family.
Always compare against 3-5 directly relevant competitors for the specific concept being evaluated.

${additionalDetails ? `ADDITIONAL CONTEXT: ${additionalDetails}\n\n` : ""}In the competitiveViability section, name the specific competitors you chose and explain why they are the right comparison set for this concept.

Evaluate rigorously. Return ONLY valid JSON (no markdown):
{
  "lauraComprehension": { "score": 0-100, "verdict": "CLEAR|CONFUSING|UNCLEAR", "explanation": "2-3 sentences", "issues": [] },
  "tierClarity": { "score": 0-100, "verdict": "OBVIOUS|MODERATE|UNCLEAR", "explanation": "2-3 sentences", "issues": [] },
  "competitiveViability": { "score": 0-100, "verdict": "STRONG|MODERATE|WEAK", "competitors": ["name the 3-5 relevant competitors you chose"], "explanation": "2-3 sentences referencing those specific competitors", "threats": [] },
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
      maxTokens: 4000,
      temperature: 0.2,
    });

    const cleaned = rawText
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "")
      .trim();

    const result = JSON.parse(cleaned);
    return json(result);
  } catch (err) {
    return json({ error: "LLM error", detail: err.message }, 502);
  }
}
