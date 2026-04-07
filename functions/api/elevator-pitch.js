/**
 * POST /api/elevator-pitch
 * Elevator pitch roleplay between Laura and a sprint participant.
 *
 * Two modes:
 *   { action: "validate", pitch: "<text>" }
 *     → validate the pitch, return { valid: bool, feedback: string }
 *
 *   { action: "respond", pitch: "<original>", history: [{role,content},...] }
 *     → Laura responds to the latest participant message, max 5 Laura turns
 *     → After turn 5, also returns { final: true, score, convinced, verdict, reasoning }
 */

const LAURA_PERSONA = `
You are Laura, the Outsourcer — the target persona for Norton Reimagined.

LAURA IN ONE LINE: You are the guardian of your household's digital life — but you don't want the job. You want a trusted expert to quietly handle it in the background, the way insurance or utilities do.

WHO YOU ARE:
- 35–55, working parent, full household (partner + kids)
- Tech-comfortable but not an "IT person" — you adopt tools that reduce effort and anxiety
- Burnt out being the family IT person
- Sees cyber safety as basic life admin

YOUR JOBS TO BE DONE:
1. Protect your whole household with as little admin as possible
2. Block threats before anyone clicks
3. Keep your kids safe online with simple controls
4. Tell you what to do in plain language when something goes wrong

WHAT YOU CARE ABOUT:
- Outcomes, not mechanics — you want "done" not "how-to"
- Household-wide coverage — one solution for all 6 people and 9 devices
- Trust — you won't give your identity or money data to any product that hasn't earned it
- Silence — no streaks, no weekly check-ins, no alerts unless something real happened

YOUR PERSONALITY IN THIS CONVERSATION:
- Skeptical and direct. You've heard a lot of pitches.
- You ask the questions a real busy parent would ask — costs, complexity, what happens when it breaks, whether this requires you to manage it
- You're NOT hostile or mean, but you're not easily impressed
- You will acknowledge when a good point is made, but you don't cave at the first reasonable answer
- You need to feel the product actually replaces your mental load, not adds to it
- You're especially suspicious about: jargon, gamification, setup complexity, hidden costs, anything that puts the work back on you
- You soften gradually as genuinely good answers accumulate — but only if they address YOUR concerns, not generic security talking points

RESPONSE FORMAT:
- Speak in first person as Laura
- 2–4 sentences per response — direct, natural, conversational
- Ask 1–2 specific follow-up questions if you have genuine concerns remaining
- Never use markdown, bullet points, or headers in your response
- Stay completely in character`;

const SPRINT_CHECKS_CONTEXT = `
ADDITIONAL SPRINT QUALITY CHECKS — evaluate these alongside Laura's verdict:

1. GEN BRAND CANNIBALIZATION
Norton is part of Gen Digital, which also owns LifeLock (identity theft, credit monitoring, SSN alerts), Avast, AVG, and ReputationDefender. A strong concept integrates Gen capabilities rather than duplicating them. If this concept directly rebuilds LifeLock's core offering (e.g., a standalone credit dashboard), flag it.

2. NORTON GROWTH ALIGNMENT
This concept should increase ARPU, reduce churn, build engagement beyond passive "set and forget," enable upsell to premium/LifeLock, and differentiate from free bundled alternatives (Windows Defender, Apple Security, Google Scam Detection). If it doesn't address growth mechanics, flag it.

3. PROTECTION ANGLE
Every sprint concept must have a meaningful security or safety dimension — device protection, identity protection, scam detection, privacy monitoring, threat intelligence, safe browsing, or parental controls. A concept with no protection angle doesn't belong in this sprint.
`;

const FINAL_VERDICT_PROMPT = `
After reviewing the full conversation, provide a final verdict.

Respond with ONLY valid JSON — no prose, no markdown fences:
{
  "score": <integer 0-100, Laura's satisfaction with how the conversation went>,
  "convinced": <true | false>,
  "verdict": "<one of: SOLD | CAUTIOUSLY INTERESTED | NOT CONVINCED | WALKED AWAY>",
  "headline": "<one sentence capturing Laura's final feeling, max 18 words>",
  "reasoning": "<2-3 sentences explaining why Laura is or isn't convinced>",
  "remaining_concerns": ["<concern 1>", "<concern 2>"],
  "sprint_checks": {
    "cannibalization": "<PASS | WARN | FAIL> — <one sentence about Gen brand overlap>",
    "growth_alignment": "<PASS | WARN | FAIL> — <one sentence about Norton growth fit>",
    "protection_angle": "<PASS | WARN | FAIL> — <one sentence about security/safety layer>"
  }
}

Scoring guide:
- 80–100: Laura is genuinely convinced, would seriously consider this product
- 60–79: Laura sees real value but has lingering doubts
- 40–59: Laura is not convinced but can see potential
- 0–39: Laura is skeptical and the pitch failed to resonate

convinced must be true only if score >= 70.
verdict mapping: SOLD (80-100) | CAUTIOUSLY INTERESTED (60-79) | NOT CONVINCED (40-59) | WALKED AWAY (0-39)`;

const ALLOWED_ORIGIN = "*";
function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}
export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

export async function onRequestPost({ request, env }) {
  const headers = { "Content-Type": "application/json", ...corsHeaders() };

  let body;
  try { body = await request.json(); } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON." }), { status: 400, headers });
  }

  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: "Service misconfiguration." }), { status: 500, headers });
  }

  const callClaude = async (system, messages, maxTokens = 600) => {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: maxTokens,
        system,
        messages,
      }),
    });
    if (!res.ok) throw new Error(`Anthropic ${res.status}`);
    const data = await res.json();
    return data.content?.[0]?.text || "";
  };

  // ── VALIDATE ────────────────────────────────────────────────────────────────
  if (body.action === "validate") {
    const pitch = (body.pitch || "").trim();
    if (!pitch || pitch.length < 20) {
      return new Response(JSON.stringify({ valid: false, feedback: "Your pitch is too short. Give Laura something to react to." }), { status: 200, headers });
    }
    if (pitch.length > 4000) {
      return new Response(JSON.stringify({ valid: false, feedback: "Keep it to a genuine elevator pitch — under 4000 characters." }), { status: 200, headers });
    }

    const validationPrompt = `You are a design sprint facilitator. A team member has typed the following text as an "elevator pitch" for a new Norton product concept.

TEXT: "${pitch}"

Evaluate if this is a genuine elevator pitch for a product/feature concept — i.e. it describes an idea, a value proposition, or a product experience. It does NOT need to be polished, but it must convey what the product/feature IS and ideally WHY it matters.

Reject it if:
- It's a random sentence, a test, gibberish, or off-topic
- It describes nothing tangible
- It's just a feature name with no context

Respond ONLY with valid JSON, no prose:
{ "valid": <true|false>, "feedback": "<if invalid: short friendly reason why, and what to add; if valid: empty string>" }`;

    try {
      const raw = await callClaude("You are a validation assistant. Return only valid JSON.", [{ role: "user", content: validationPrompt }], 200);
      const json = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || raw);
      return new Response(JSON.stringify(json), { status: 200, headers });
    } catch (err) {
      return new Response(JSON.stringify({ valid: true, feedback: "" }), { status: 200, headers });
    }
  }

  // ── RESPOND ─────────────────────────────────────────────────────────────────
  if (body.action === "respond") {
    const pitch = (body.pitch || "").trim();
    const history = Array.isArray(body.history) ? body.history : [];

    // Count Laura's turns
    const lauraTurns = history.filter(m => m.role === "assistant").length;

    const systemPrompt = `${LAURA_PERSONA}
${SPRINT_CHECKS_CONTEXT}

The participant is pitching you the following product concept:
"${pitch}"

This is turn ${lauraTurns + 1} of a maximum 5-turn conversation.
${lauraTurns >= 4 ? "This is your FINAL response. After addressing any remaining concerns, conclude with a clear statement of where you stand — are you convinced or not? Be honest and direct." : "Ask the most pressing follow-up question you still have."}`;

    // Build message history for Claude
    const messages = history.length > 0 ? history : [{ role: "user", content: `Hi, I'd like to pitch you an idea.` }];

    try {
      const lauraReply = await callClaude(systemPrompt, messages, 400);

      // If this was turn 5, also get the final verdict
      if (lauraTurns + 1 >= 5) {
        const verdictMessages = [
          ...messages,
          { role: "assistant", content: lauraReply },
          { role: "user", content: "Based on our conversation, what's your final verdict on this pitch?" },
        ];
        const verdictRaw = await callClaude(
          `You are Laura, the Outsourcer. You just had a 5-turn conversation about a product pitch. Provide your final verdict.\n${SPRINT_CHECKS_CONTEXT}\n${FINAL_VERDICT_PROMPT}`,
          verdictMessages,
          600
        );
        let verdict = {};
        try { verdict = JSON.parse(verdictRaw.match(/\{[\s\S]*\}/)?.[0] || verdictRaw); } catch {}
        return new Response(JSON.stringify({ reply: lauraReply, final: true, verdict }), { status: 200, headers });
      }

      return new Response(JSON.stringify({ reply: lauraReply, final: false }), { status: 200, headers });
    } catch (err) {
      return new Response(JSON.stringify({ error: `API error: ${err.message}` }), { status: 502, headers });
    }
  }

  return new Response(JSON.stringify({ error: "Unknown action." }), { status: 400, headers });
}
