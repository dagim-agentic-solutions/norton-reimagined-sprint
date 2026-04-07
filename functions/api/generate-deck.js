/**
 * POST /api/generate-deck
 * Password-gated endpoint: generates a Gamma pitch deck for a prototype.
 *
 * Request body: { password, protoId, title, summary, url }
 * Response:     { gammaUrl } on success, { error } on failure
 *
 * Flow: validate password → build rich pitch text → POST to Gamma → poll → return gammaUrl
 */

const DECK_PASSWORD_HASH = "norton2026sprint"; // checked server-side; never exposed to browser

const LAURA_CONTEXT = `
LAURA — THE TARGET PERSONA:
Laura is a 35–55 working parent who is the de-facto guardian of her household's digital life — but she doesn't want the job. She wants a trusted expert to quietly handle it in the background, the way insurance or utilities do. She has 5–10 devices across her family, is tech-comfortable but not technically curious, and is burnt out being the family IT person.

Her 4 Jobs To Be Done:
1. Protect the whole household with as little admin as possible
2. Block threats before anyone clicks
3. Keep her kids safe online with simple, trustworthy controls
4. Tell her what to do in plain language when something goes wrong

What she loves: outcomes not mechanics, "You're protected" status, one solution for every device and family member, calm assured tone.
What she rejects: dashboards full of toggles, jargon, gamification, dark-pattern upsells, anything that adds to her mental load.
`;

const NORTON_CONTEXT = `
NORTON REIMAGINED — THE INITIATIVE:
This is a 3-day design sprint to reimagine Norton as a Digital Fiduciary — a product that proactively protects Laura's entire household without requiring her to manage it. The goal is to move Norton beyond its legacy "antivirus tool" positioning into a trusted household protection platform that covers identity, finances, devices, and family safety under one intelligent umbrella.

FY25 Context:
- Norton's entry-tier units grew 5% YoY but bookings fell 3% — showing price pressure from OS-bundled protection (Apple, Microsoft Defender, Google)
- The growth story is in higher-tier upgrades and LifeLock identity attach
- Competitors: McAfee+, Aura, Bitdefender, NordVPN (Threat Protection), Google (Scam Detection), Apple (Stolen Device Protection)
- The differentiator Norton has that no competitor can replicate: 30 years of threat intelligence, LifeLock identity layer, cross-device household coverage, trusted brand

The sprint hypothesis: If Norton can make the complex simple, the invisible visible, and the reactive proactive — all wrapped in a brand Laura already trusts — it can own the "household digital protection" category that nobody else has claimed.
`;

function buildPitchText(title, summary, url) {
  return `
# PITCH DECK: ${title}
## Norton Reimagined Design Sprint

---

${LAURA_CONTEXT}

---

${NORTON_CONTEXT}

---

## THE PROTOTYPE: ${title}

**What it is:**
${summary}

**Live prototype:** ${url}

---

## PITCH DECK STRUCTURE (generate exactly these sections as slides):

**Slide 1 — Title Slide**
Title: "${title}"
Subtitle: Norton Reimagined Design Sprint · Tiger Team
Visual: Bold, minimal, premium feel

**Slide 2 — The Problem We're Solving**
Laura's pain point this prototype addresses. Use her voice — not security jargon. Focus on the emotional weight of being the household IT person and the anxiety of digital threats she can't see.

**Slide 3 — Meet Laura**
Her profile, her JTBD, what she needs from Norton. Visualize her daily digital reality. Make it human.

**Slide 4 — The Concept**
What this prototype does — described from Laura's perspective, not engineering. Lead with the outcome she experiences, not the feature list.

**Slide 5 — How It Works**
Simple 3-step flow from Laura's point of view: how she discovers it, how she uses it for the first time, why she keeps coming back.

**Slide 6 — Why Now**
The market forces making this the right moment: OS-bundled protection commoditizing basic security, AI scam threats accelerating, consumer trust in Big Tech eroding, Laura's mental load reaching a breaking point.

**Slide 7 — The Competitive Landscape**
How this concept positions Norton vs. McAfee+, Aura, Bitdefender, Google Scam Detection, Apple, and NordVPN. What only Norton can deliver that they cannot.

**Slide 8 — Norton's Unfair Advantage**
The LifeLock identity layer + 30 years of threat intelligence + cross-device household coverage + trusted brand = a moat competitors can't cross. This concept activates those advantages.

**Slide 9 — The Business Case**
Why this wins for Norton: retention uplift, ARPU expansion, entry-tier to premium upgrade path, LifeLock attach opportunity, churn reduction. Connect to the FY25 context.

**Slide 10 — What We're Asking**
Clear ask from the sprint team: validation, feedback, go/no-go signal, or next steps. One CTA per slide.

---

TONE: Premium consumer brand, confident but not corporate. Warm and direct. Designed to resonate with both Laura and Norton leadership. No jargon. Show why this matters.

FORMAT: 16:9 presentation. High visual impact. Clean. Data where relevant but story-first.
`;
}

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

  // 1. Password check (server-side only)
  const pass = (body.password || "").trim();
  const expectedHash = env.DECK_PASSWORD || DECK_PASSWORD_HASH;
  if (pass !== expectedHash) {
    return new Response(JSON.stringify({ error: "Incorrect password. Ask the sprint lead." }), { status: 401, headers });
  }

  // 2. Validate inputs
  const { title, summary, url } = body;
  if (!title || !summary) {
    return new Response(JSON.stringify({ error: "Missing prototype title or summary." }), { status: 400, headers });
  }

  // 3. Gamma API key
  const gammaKey = env.GAMMA_API_KEY;
  if (!gammaKey) {
    return new Response(JSON.stringify({ error: "Gamma API not configured." }), { status: 500, headers });
  }

  // 4. Create Gamma generation
  const pitchText = buildPitchText(title, summary, url || "");
  let generationId;
  try {
    const createRes = await fetch("https://public-api.gamma.app/v1.0/generations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-KEY": gammaKey,
      },
      body: JSON.stringify({
        inputText: pitchText,
        textMode: "preserve",
        format: "presentation",
        numCards: 10,
        cardOptions: { dimensions: "16x9" },
        textOptions: { amount: "medium", tone: "professional and inspiring", audience: "product and business stakeholders at a consumer tech company" },
        imageOptions: { source: "pexels" },
        sharingOptions: { externalAccess: "view" },
      }),
    });
    if (!createRes.ok) {
      const err = await createRes.text();
      return new Response(JSON.stringify({ error: `Gamma error: ${err.slice(0, 200)}` }), { status: 502, headers });
    }
    const createData = await createRes.json();
    generationId = createData.generationId;
  } catch (err) {
    return new Response(JSON.stringify({ error: `Network error: ${err.message}` }), { status: 502, headers });
  }

  // 5. Poll for completion (max 90 seconds, 3s intervals)
  const maxAttempts = 30;
  let gammaUrl = null;
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, 3000));
    try {
      const pollRes = await fetch(`https://public-api.gamma.app/v1.0/generations/${generationId}`, {
        headers: { "X-API-KEY": gammaKey },
      });
      if (!pollRes.ok) continue;
      const pollData = await pollRes.json();
      if (pollData.status === "completed" && pollData.gammaUrl) {
        gammaUrl = pollData.gammaUrl;
        break;
      }
      if (pollData.status === "failed") {
        return new Response(JSON.stringify({ error: "Gamma generation failed." }), { status: 502, headers });
      }
    } catch { continue; }
  }

  if (!gammaUrl) {
    return new Response(JSON.stringify({ error: "Deck generation timed out. Try again." }), { status: 504, headers });
  }

  return new Response(JSON.stringify({ gammaUrl }), { status: 200, headers });
}
