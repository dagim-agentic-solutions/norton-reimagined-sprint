/**
 * POST /api/pressure-test
 * Scope: norton-reimagined-sprint only.
 * Single-purpose: evaluates a product concept against the Laura persona.
 * This is NOT general-purpose AI passthrough — it does exactly one thing.
 *
 * Request body:  { concept: "<user text>" }  (max 2000 chars)
 * Response body: JSON per RESPONSE_SCHEMA below
 *
 * No npm dependencies — built-in fetch only.
 */

// ─── Laura persona context ────────────────────────────────────────────────────
const LAURA_CONTEXT = `
You are evaluating a product concept on behalf of "Laura, the Outsourcer" —
the target persona for Norton Reimagined, a Digital Fiduciary Advisory platform.

LAURA IN ONE LINE: She is the guardian of her household's digital life — but
she doesn't want the job. She wants a trusted expert to quietly handle it in
the background, the way insurance or utilities do.

WHO SHE IS:
- 35–55, working parent, full household (partner + kids), 5–10 devices across family
- Mass-market premium income, comfortable paying for quality protection
- Tech-comfortable but not "IT people" — adopts tools that reduce effort and anxiety
- "Unknowledgeable" mindset — not curious about how cyber works, just wants it to work
- Sees cyber safety as basic life admin, like insurance or utilities
- Carries the mental load of keeping family safe and is burnt out being the household IT person

HER 4 JOBS TO BE DONE:
1. Protect my whole household with as little admin from me as possible
2. Block threats before we click (scams, dodgy sites, sketchy downloads)
3. Keep my kids safe online with simple, trustworthy controls
4. Tell me what to do when something looks wrong, in plain language

WHAT "PEACE OF MIND" MEANS TO HER — THE 4Ps:
- PROACTIVE: Tell her the result. Don't ask her to run scans or flip toggles.
- PROGRESSIVE: Go beyond viruses — catch AI scams, deepfakes, new threats.
- PRINCIPLED: Transparent from day one. No dark-pattern upsells.
- PERVASIVE: Everywhere, all at once. One provider, every device, every family member.

HER DIGITAL BEHAVIORS:
- Online for LOGISTICS, not leisure. Uses the internet to run her life.
- Lives in: Amazon, Target, Walmart, grocery apps, banking apps (Chase/BofA),
  Venmo/Zelle, school portals, MyChart, Delta/Southwest/Airbnb
- Social: Facebook (family, local groups), Instagram (lurking), WhatsApp/iMessage
  group chats, Pinterest, YouTube, LinkedIn
- Info: Google, Apple News, NYT/WaPo/local paper, occasional Reddit for reviews,
  true-crime and parenting podcasts
- Efficient, not exploratory. Tabs are tools, not playgrounds.

HER VIEW ON AI:
- Cautiously curious, deeply suspicious. SPLIT relationship with AI.
- OPEN to AI when: it saves her time, does a chore she didn't want to do, stakes
  are low (drafting an email, Siri timers, summarizing a newsletter)
- WARY of AI when: it involves money, identity, or trust. Worries about AI scams,
  voice clones of her kids, deepfakes, fake customer service.
- Will welcome AI that acts on her behalf ONLY IF it's wrapped in a trusted brand,
  explains itself in plain language, and is fighting the OTHER AI (the scammy one).

HER ANXIETIES (specific, about PEOPLE not pixels):
1. Her kids online — strangers in DMs, TikTok/Snap/Roblox/Discord, sextortion headlines
2. Her aging parents getting scammed — romance scams, grandchild-in-trouble calls,
   tech support fraud
3. Family finances & identity — unauthorized charges, SSN theft, bank breaches
4. Falling for it herself — a fake UPS text, an "account locked" email in a distracted moment
5. The stuff she doesn't know to fear — deepfakes, AI voice clones, data brokers, dark web
6. Being the family IT person — she wants a product that REPLACES her in that role,
   not adds to it

WHAT SHE LOVES (design FOR her):
- Default to the product deciding and acting; show the outcome after
- "You're protected" status, buried mechanics
- Household framing ("your family", "everyone's devices")
- Single clear CTAs when interruption is necessary
- Upgrades framed as deeper mandates, not unlocked features
- Calm, assured, protective tone — Norton as her fiduciary

WHAT SHE REJECTS (don't design FOR her):
- Dashboards full of toggles, sliders, config screens
- Asking her to understand the threat to make a decision
- Jargon (IOCs, endpoints, heuristics, DNS)
- Hidden costs, dark-pattern upsells
- Gamification — she doesn't want a streak, she wants silence
- Being mistaken for Jane (younger, builder-phase). Laura is older, wealthier,
  wants LESS control, not more.

SCORING GUIDE (Laura Score 0–100):
- 90–100 "LOVES IT": Directly solves a top JTBD/anxiety, feels effortless, removes
  mental load, fits her trust model. She'd pay more for this.
- 75–89 "LIKES IT": Clearly useful, aligned with the 4Ps, low friction. She'd adopt
  it but not rave about it.
- 55–74 "MEH": Mixed signals. Solves something real but asks too much, or solves
  something she doesn't care about enough.
- 35–54 "SKEPTICAL": Violates one or more core principles (too much control required,
  jargon, unclear value, gamified, dark pattern).
- 0–34 "REJECTS IT": Fundamentally misreads Laura. Builds FOR Jane, demands
  configuration, adds to her mental load, or breaks her trust.
`;

// ─── Response schema instruction ─────────────────────────────────────────────
const RESPONSE_SCHEMA = `
Respond with ONLY a valid JSON object — no prose, no markdown fences, no preamble.
Use exactly this shape:

{
  "score": <integer 0-100>,
  "verdict": "<LOVES IT | LIKES IT | MEH | SKEPTICAL | REJECTS IT>",
  "headline": "<one sentence, Laura's gut reaction, max 18 words>",
  "summary": "<2-3 sentences>",
  "wins": ["<reason 1>", "<reason 2>", "<reason 3>"],
  "risks": ["<reason 1>", "<reason 2>", "<reason 3>"],
  "recommendation": "<1-2 sentences>"
}

The verdict MUST match the score band:
  90-100 → LOVES IT | 75-89 → LIKES IT | 55-74 → MEH |
  35-54 → SKEPTICAL | 0-34 → REJECTS IT
`;

// ─── CORS ─────────────────────────────────────────────────────────────────────
const ALLOWED_ORIGIN = "https://norton-reimagined-sprint.pages.dev";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

// ─── Preflight ────────────────────────────────────────────────────────────────
export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

// ─── Main handler ─────────────────────────────────────────────────────────────
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

  // 2. Guard: no arbitrary passthrough fields — this endpoint is single-purpose
  if (body.model || body.system || body.messages || body.prompt) {
    return new Response(
      JSON.stringify({ error: "This endpoint is single-purpose. Extra fields are not accepted." }),
      { status: 400, headers }
    );
  }

  // 3. Validate concept
  const concept = body?.concept;
  if (!concept || typeof concept !== "string" || concept.trim().length === 0) {
    return new Response(
      JSON.stringify({ error: "Missing or empty 'concept' field." }),
      { status: 400, headers }
    );
  }
  if (concept.length > 2000) {
    return new Response(
      JSON.stringify({ error: "Concept exceeds 2000 characters. Please shorten and retry." }),
      { status: 400, headers }
    );
  }

  // 4. Load API key — never from caller, always from env
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: "Service misconfiguration. Contact the sprint lead." }),
      { status: 500, headers }
    );
  }

  // 5. Build prompt — Laura context + concept + schema
  const userPrompt = `${LAURA_CONTEXT}

---
CONCEPT TO EVALUATE:
${concept.trim()}

---
RESPONSE FORMAT (return ONLY this JSON, no other text):
${RESPONSE_SCHEMA}`;

  // 6. Call Anthropic — model is fixed; caller cannot override
  let anthropicRes;
  try {
    anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
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

  if (!anthropicRes.ok) {
    const errText = await anthropicRes.text().catch(() => "");
    return new Response(
      JSON.stringify({
        error: "Anthropic API error.",
        status: anthropicRes.status,
        detail: errText.slice(0, 300),
      }),
      { status: 502, headers }
    );
  }

  // 7. Parse Anthropic response
  let data;
  try {
    data = await anthropicRes.json();
  } catch {
    return new Response(
      JSON.stringify({ error: "Malformed response from Anthropic." }),
      { status: 502, headers }
    );
  }

  const rawText = data?.content?.[0]?.text ?? "";

  // Strip accidental markdown code fences server-side
  const cleaned = rawText
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  let result;
  try {
    result = JSON.parse(cleaned);
  } catch {
    return new Response(
      JSON.stringify({ error: "Model returned invalid JSON", raw: rawText.slice(0, 500) }),
      { status: 502, headers }
    );
  }

  return new Response(JSON.stringify(result), { status: 200, headers });
}
