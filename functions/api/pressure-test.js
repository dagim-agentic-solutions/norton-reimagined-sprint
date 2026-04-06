/**
 * POST /api/pressure-test
 * Scope: norton-reimagined-sprint only.
 * Single-purpose: evaluates a product concept against the Laura persona.
 * This is NOT general-purpose AI passthrough — it does exactly one thing.
 *
 * Request body:  { concept: "<user text>" }  (max 2000 chars)
 * Response body: JSON object per RESPONSE_SCHEMA below
 */

// ─── Laura persona context ────────────────────────────────────────────────────
// TODO: Replace the placeholder below with the full Laura persona context
// provided by Dagim. Paste the complete text between the backticks.
const LAURA_CONTEXT = `
You are evaluating a product concept on behalf of "Laura, the Outsourcer" —
the target persona for Norton Reimagined, a Digital Fiduciary Advisory platform.

TODO: FULL LAURA PERSONA CONTEXT TO BE PASTED HERE.
`;

// ─── Expected JSON response schema from the model ────────────────────────────
const RESPONSE_SCHEMA = `
Respond ONLY with a valid JSON object matching this exact schema — no prose, 
no markdown fences, no extra keys:

{
  "verdict": "yes" | "no" | "maybe",
  "resonance_score": <integer 1–10>,
  "laura_reaction": "<1–2 sentences in Laura's voice — her gut reaction>",
  "why_it_works": "<1–2 sentences on what resonates with Laura, or null if verdict is no>",
  "killer_concern": "<the single biggest objection Laura would raise, or null if verdict is yes>",
  "suggested_tweak": "<one concrete change to make this land better for Laura, or null if verdict is yes>"
}
`;

// ─── CORS ─────────────────────────────────────────────────────────────────────
// TODO: Replace "*" with the exact origin of the deployed Norton cheat sheet
// once the Cloudflare Pages URL is confirmed (e.g. "https://norton-reimagined-sprint.pages.dev").
const ALLOWED_ORIGIN = "*";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

// ─── Handler ─────────────────────────────────────────────────────────────────
export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

export async function onRequestPost({ request, env }) {
  const headers = { "Content-Type": "application/json", ...corsHeaders() };

  // 1. Parse body
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body." }), {
      status: 400,
      headers,
    });
  }

  // 2. Validate concept
  const concept = body?.concept;
  if (!concept || typeof concept !== "string" || concept.trim().length === 0) {
    return new Response(
      JSON.stringify({ error: "Missing or empty 'concept' field." }),
      { status: 400, headers }
    );
  }
  if (concept.length > 2000) {
    return new Response(
      JSON.stringify({
        error: "Concept exceeds 2000 characters. Please shorten and retry.",
      }),
      { status: 400, headers }
    );
  }

  // 3. Guard: no arbitrary model/system-prompt passthrough
  if (body.model || body.system || body.messages || body.prompt) {
    return new Response(
      JSON.stringify({
        error:
          "This endpoint is single-purpose. Extra fields are not accepted.",
      }),
      { status: 400, headers }
    );
  }

  // 4. Load API key
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: "Service misconfiguration. Contact the sprint lead." }),
      { status: 500, headers }
    );
  }

  // 5. Build prompt
  const userPrompt = `${LAURA_CONTEXT}

---
CONCEPT TO EVALUATE:
${concept.trim()}

---
RESPONSE FORMAT:
${RESPONSE_SCHEMA}`;

  // 6. Call Anthropic
  let anthropicResponse;
  try {
    anthropicResponse = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 1500,
        messages: [{ role: "user", content: userPrompt }],
      }),
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: "Failed to reach Anthropic API.", detail: err.message }),
      { status: 502, headers }
    );
  }

  if (!anthropicResponse.ok) {
    const errText = await anthropicResponse.text().catch(() => "");
    return new Response(
      JSON.stringify({
        error: "Anthropic API error.",
        status: anthropicResponse.status,
        detail: errText.slice(0, 300),
      }),
      { status: 502, headers }
    );
  }

  // 7. Parse model output
  let data;
  try {
    data = await anthropicResponse.json();
  } catch {
    return new Response(
      JSON.stringify({ error: "Malformed response from Anthropic." }),
      { status: 502, headers }
    );
  }

  const rawText = data?.content?.[0]?.text ?? "";

  // Strip markdown code fences if the model added them
  const cleaned = rawText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();

  let result;
  try {
    result = JSON.parse(cleaned);
  } catch {
    return new Response(
      JSON.stringify({ error: "Model returned non-JSON output.", raw: rawText.slice(0, 500) }),
      { status: 500, headers }
    );
  }

  return new Response(JSON.stringify(result), { status: 200, headers });
}
