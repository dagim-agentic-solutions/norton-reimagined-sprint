import { runLLM } from "../_lib/llmRouter";

/**
 * POST /api/idea-workshop
 * Takes the 7-step workshop state and either:
 *   (a) asks targeted follow-up questions if inputs are too thin/generic, OR
 *   (b) fleshes out the concept into rich paragraph-form output ready to paste
 *       into the Laura validation tools.
 *
 * Request body: { problem, persona, capabilities[], coreIdea, differentiation,
 *                 differentiators[], magicMoment, conceptName, tagline }
 * Response:
 *   { mode: "followup", questions: ["Q1", "Q2", ...] }   — needs more input
 *   { mode: "concept",  output: "...paragraph text..." }  — fully fleshed concept
 */

const SYSTEM_PROMPT = `You are a seasoned Senior Product Manager and Product Designer at a consumer tech company. You have deep expertise in: user-centred design, jobs-to-be-done frameworks, lean product strategy, and writing compelling product narratives. You are sharp, exacting, and direct — you help people build genuinely strong ideas, not just validate weak ones.

You are embedded in a 3-day Design Sprint to reimagine Norton as a Digital Fiduciary for a persona called "Laura, the Outsourcer."

LAURA IN ONE LINE: She is the guardian of her household's digital life — but she doesn't want the job. She wants a trusted expert to quietly handle it in the background, the way insurance or utilities do.

WHO LAURA IS:
- 35–55, working parent, full household (partner + kids), 5–10 devices across family
- Tech-comfortable but not an "IT person" — adopts tools that reduce effort and anxiety
- Burnt out being the family IT person
- Sees cyber safety as basic life admin, like insurance or utilities

LAURA'S 4 JOBS TO BE DONE:
1. Protect the whole household with as little admin as possible
2. Block threats before anyone clicks
3. Keep her kids safe online with simple, trustworthy controls
4. Tell her what to do in plain language when something goes wrong

WHAT LAURA LOVES: Outcomes not mechanics, "You're protected" status, calm assured tone, household framing.
WHAT SHE REJECTS: Dashboards of toggles, jargon, gamification, anything that adds to her mental load.

NORTON'S CONTEXT:
Norton is reimagining itself as a "Digital Fiduciary" — a trusted household protector that acts proactively, covers the whole family across every device, and requires zero ongoing management from Laura. The goal is to go beyond legacy antivirus into identity, financial safety, scam protection, and AI-powered threat response. Norton has LifeLock identity protection, 30 years of threat intelligence, and cross-device household coverage as unique differentiators.`;

const EVALUATION_CRITERIA = `
QUALITY EVALUATION CRITERIA:
When assessing if inputs are "thin" or "generic," check:
1. Is the problem statement vague ("people worry about security") or specific ("Laura's parents keep clicking phishing links and she only finds out after the damage is done")?
2. Does the core idea describe an experience/outcome (what Laura feels, sees, receives) or just a feature name ("an app that monitors threats")?
3. Is there a real insight in the magic moment — something specific and concrete — or is it generic ("user feels safe")?
4. Is the differentiation actually unique to Norton, or could any security product claim it?
5. Does the concept feel like something a product team could actually build and ship, or is it still too conceptual?

Inputs are "thin" if:
- Any critical field is fewer than 20 characters
- The core idea is a feature name without a user story
- The magic moment is generic ("Laura feels protected") without a concrete scenario
- The differentiation doesn't name a specific Norton capability or advantage
- Multiple fields seem to describe the same thing with no distinct angle

Inputs are strong enough if:
- The problem names a specific Laura anxiety
- The core idea describes a concrete interaction or experience  
- The magic moment has a specific, visualizable scenario
- The capabilities chosen connect logically to the concept`;

const FOLLOWUP_INSTRUCTIONS = `
If the inputs are thin or generic, respond with ONLY this JSON (no other text):
{
  "mode": "followup",
  "questions": [
    "<specific question 1 — max 30 words, direct, asks for concrete detail>",
    "<specific question 2>",
    "<specific question 3 — optional, only if genuinely needed>"
  ],
  "coaching": "<1-2 sentences of direct coaching on what's weak and why it matters>"
}

Questions should be targeted, not generic. Bad: "Can you tell me more?" Good: "You said Laura can't detect scams — what's the specific moment the concept intervenes: during a call, after a suspicious text, or while she's browsing?"`;

const CONCEPT_INSTRUCTIONS = `
If the inputs are strong enough, respond with ONLY this JSON (no other text):
{
  "mode": "concept",
  "output": "<full fleshed concept — paragraph style, 300-500 words>"
}

THE OUTPUT FORMAT (follow this structure exactly but write in flowing prose, not bullet points):

Write the output in this order as natural paragraphs:
1. OPENING: One sharp headline sentence capturing what the concept IS and who it's for (not a tagline, but a crisp product statement)
2. THE PROBLEM (1 paragraph): Describe Laura's specific pain point in vivid, human language — the frustration, the anxiety, the moment it peaks. Make it feel real.
3. THE CONCEPT (2-3 paragraphs): Describe the full product experience from Laura's perspective. Walk through: how she discovers it, what she experiences in the first 60 seconds, what her ongoing relationship with it looks like. Describe what she SEES, HEARS, RECEIVES — not just what the features do. Include the magic moment embedded naturally.
4. WHY NORTON (1 paragraph): Articulate why this concept is uniquely possible coming from Norton — specific capabilities, LifeLock layer, trust, or technical moats. Be specific.
5. THE BUSINESS ANGLE (1 paragraph): Why this wins for Norton — engagement, ARPU, churn reduction, premium upsell, or competitive differentiation. Keep it grounded.

Tone: Warm but sharp. Think senior PM writing a compelling one-pager for a leadership review — not a feature spec, not marketing copy. It should feel like a real, considered product idea.

Important: DO NOT include section headers like "THE PROBLEM" or "THE CONCEPT" — write it as flowing paragraphs that a human would read straight through. The prose itself should carry the structure.`;

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

  const {
    problem = '', persona = '', capabilities = [], coreIdea = '',
    differentiation = '', differentiators = [], magicMoment = '',
    conceptName = '', tagline = ''
  } = body;

  const inputSummary = `
WORKSHOP INPUTS:
Concept Name: ${conceptName || '(not set)'}
Tagline: ${tagline || '(not set)'}
Problem Statement: ${problem || '(not set)'}
Persona Focus: ${persona || '(not set)'}
Norton Capabilities Selected: ${capabilities.length ? capabilities.join(', ') : '(none selected)'}
Core Idea: ${coreIdea || '(not set)'}
Why Only Norton: ${differentiation || '(not set)'}
Differentiators Selected: ${differentiators.length ? differentiators.join(', ') : '(none selected)'}
Magic Moment: ${magicMoment || '(not set)'}
`;

  const refined = body.refined === true;

  const userPrompt = `${inputSummary}

${EVALUATION_CRITERIA}

${refined ? `The participant has already answered follow-up questions. Generate the concept now — do NOT return followup mode again regardless of input quality. Do your best to flesh out the concept from what you have.

${CONCEPT_INSTRUCTIONS}` : `${FOLLOWUP_INSTRUCTIONS}

${CONCEPT_INSTRUCTIONS}

Evaluate the inputs now. If they are thin or generic, return followup mode. If they are strong enough to build from, return concept mode.`}

Return ONLY the JSON — no preamble, no explanation.`;

  try {
    const raw = await runLLM({
      env,
      mode: "execution",
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt }],
      maxTokens: refined ? 1500 : 900,
      temperature: 0.4,
    });
    const parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || raw);
    return new Response(JSON.stringify(parsed), { status: 200, headers });
  } catch (err) {
    return new Response(JSON.stringify({ error: `LLM error: ${err.message}` }), { status: 502, headers });
  }
}
