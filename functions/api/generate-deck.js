import { ensureAdmin } from "../_lib/adminAuth.js";

/**
 * /api/generate-deck
 *
 * POST { password, title, summary, url }
 *   → validates password, kicks off async Gamma generation
 *   → returns { generationId }  (fast — well under 30s CF limit)
 *
 * GET  ?id=<generationId>
 *   → polls Gamma once and returns { status, gammaUrl? }
 *   → browser polls this every 4s until status === "completed" or "failed"
 */

const DECK_PASSWORD_HASH = "norton2026sprint";

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
  return `# PITCH DECK: ${title}
## Norton Reimagined Design Sprint

---

${LAURA_CONTEXT}

---

${NORTON_CONTEXT}

---

## THE PROTOTYPE: ${title}

**What it is:**
${summary}

**Live prototype:** ${url || "(link not provided)"}

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

**Slide 9 — Feature Deep-Dive: What Makes This Different**
Break down the 3–5 core features or capabilities inside this prototype. For each one:
- Name the feature in plain language (no jargon)
- Explain exactly what it does for Laura — the job it completes, the anxiety it removes
- Explain why this is differentiated: what competitors miss, what Norton's unique position enables, and why this feature couldn't be replicated easily by Apple, Google, McAfee, or Aura
- Flag which feature is the "hero" — the one thing that would make Laura say "no other product does this"
Make this slide feel like a product teardown, not a feature list.

**Slide 10 — Brand Vision & Go-to-Market Campaign**
How does Norton take this concept to market and pitch this shift to the millions of existing Norton customers and the broader consumer base?
- Campaign concept: Give this product a campaign name, a hero tagline, and a one-line manifesto that captures what Norton is becoming (not just what it does)
- Primary message: What single truth does this campaign communicate to Laura? What emotion does it create?
- Channel strategy: Where does Norton reach Laura? (TV, YouTube pre-roll, social, email to existing base, retail partners, co-marketing with device OEMs)
- Key visual idea: Describe the hero creative — what does the campaign look and feel like? What's the contrast between the "before" (Laura overwhelmed, the family IT person) and the "after" (Laura free, Norton quietly handling everything)
- Retention angle: How does this campaign speak to existing Norton subscribers in a way that makes them feel they're upgrading into something better — not being sold a new product?

**Slide 11 — The Business Case**
Why this wins for Norton: retention uplift, ARPU expansion, entry-tier to premium upgrade path, LifeLock attach opportunity, churn reduction. Connect to the FY25 context.

**Slide 12 — What We're Asking**
Clear ask from the sprint team: validation, feedback, go/no-go signal, or next steps. One CTA per slide.

---

TONE: Premium consumer brand, confident but not corporate. Warm and direct. Designed to resonate with both Laura and Norton leadership. No jargon. Show why this matters.

FORMAT: 16:9 presentation. High visual impact. Clean. Data where relevant but story-first.`;
}

const ALLOWED_ORIGIN = "*";
function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function guard(request, env) {
  const auth = ensureAdmin(request, env);
  if (!auth.ok) {
    return new Response(JSON.stringify({ error: auth.error || 'Unauthorized' }), {
      status: auth.status || 401,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() },
    });
  }
  return null;
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

// ── GET: single poll for status ───────────────────────────────────────────────
export async function onRequestGet({ request, env }) {
  const denied = guard(request, env);
  if (denied) return denied;
  const headers = { "Content-Type": "application/json", ...corsHeaders() };
  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  const protoId = url.searchParams.get("protoId") || null;
  const title   = url.searchParams.get("title")   || "";

  if (!id) {
    return new Response(JSON.stringify({ error: "Missing id param." }), { status: 400, headers });
  }
  const gammaKey = env.GAMMA_API_KEY;
  if (!gammaKey) {
    return new Response(JSON.stringify({ error: "Gamma API not configured." }), { status: 500, headers });
  }
  try {
    const res = await fetch(`https://public-api.gamma.app/v1.0/generations/${id}`, {
      headers: { "X-API-KEY": gammaKey },
    });
    if (!res.ok) {
      return new Response(JSON.stringify({ status: "pending" }), { status: 200, headers });
    }
    const data = await res.json();
    // When generation completes, save a system note to the prototype's comments
    if (data.status === "completed" && data.gammaUrl && protoId && env.PROTOTYPES_KV) {
      await saveSystemNote(env.PROTOTYPES_KV, protoId, data.gammaUrl, title);
    }
    return new Response(JSON.stringify({
      status: data.status || "pending",
      gammaUrl: data.gammaUrl || null,
    }), { status: 200, headers });
  } catch {
    return new Response(JSON.stringify({ status: "pending" }), { status: 200, headers });
  }
}

// ── POST: validate password + start generation ────────────────────────────────
export async function onRequestPost({ request, env }) {
  const denied = guard(request, env);
  if (denied) return denied;
  const headers = { "Content-Type": "application/json", ...corsHeaders() };

  let body;
  try { body = await request.json(); } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON." }), { status: 400, headers });
  }

  // 1. Password check
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

  // 4. Start generation (async — returns immediately with generationId)
  const pitchText = buildPitchText(title, summary, url || "");
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
        numCards: 12,
        cardOptions: { dimensions: "16x9" },
        textOptions: {
          amount: "medium",
          tone: "professional and inspiring",
          audience: "product and business stakeholders at a consumer tech company",
        },
        imageOptions: { source: "pexels" },
        sharingOptions: { externalAccess: "view" },
      }),
    });
    if (!createRes.ok) {
      const err = await createRes.text();
      return new Response(JSON.stringify({ error: `Gamma error: ${err.slice(0, 200)}` }), { status: 502, headers });
    }
    const createData = await createRes.json();
    return new Response(JSON.stringify({ generationId: createData.generationId }), { status: 200, headers });
  } catch (err) {
    return new Response(JSON.stringify({ error: `Network error starting generation: ${err.message}` }), { status: 502, headers });
  }
}

// ── Internal helper: save a system note to the prototype's comments ───────────
async function saveSystemNote(kv, protoId, gammaUrl, title) {
  if (!kv || !protoId) return;
  const kvKey = `comments::${protoId}`;
  try {
    const raw = await kv.get(kvKey);
    const comments = raw ? JSON.parse(raw) : [];
    const now = new Date().toLocaleString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
    });
    comments.push({
      id: crypto.randomUUID(),
      protoId,
      author: '✦ Pitch Deck',
      text: `Deck generated on ${now}: ${gammaUrl}`,
      createdAt: Date.now(),
      system: true,
    });
    await kv.put(kvKey, JSON.stringify(comments));
  } catch { /* non-blocking — don't fail the poll response if note fails */ }
}
