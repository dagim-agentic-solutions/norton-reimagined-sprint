/**
 * /api/prototypes
 * Scope: norton-reimagined-sprint only.
 *
 * GET  → returns all submitted prototypes, newest first
 * POST → submits a new prototype:
 *        - url (string): used directly, no Vercel involved
 *        - fileContent + fileName + encoding: file deployed to Vercel automatically
 *          Supported: .html, .js (encoding: "utf-8"), .zip (encoding: "base64")
 *          Each file submission gets its own unique Vercel project + permanent URL.
 *
 * KV binding: PROTOTYPES_KV
 *   "index"      → JSON array of IDs (insertion order)
 *   "proto:<id>" → JSON prototype object
 *   "file:<id>"  → { fileName, content } — kept for legacy KV-hosted files only
 *
 * Secrets: ANTHROPIC_API_KEY (pressure-test), VERCEL_TOKEN (file deployments)
 * No npm dependencies — built-in fetch + Web APIs only.
 */

// ── Constants ─────────────────────────────────────────────────────────────────
import { ensureAdmin } from '../_lib/adminAuth.js';

const MAX_FILE_BYTES   = 10 * 1024 * 1024; // 10 MB raw (before base64)
const ALLOWED_EXTS     = ["html", "js", "ts", "tsx", "jsx", "zip", "pdf", "jpg", "jpeg", "png", "gif", "webp", "svg"];
const TEXT_EXTS        = new Set(["html","htm","css","js","ts","jsx","tsx","json","txt","md","svg","xml","yaml","yml","toml"]);

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

function guard(request, env) {
  const auth = ensureAdmin(request, env);
  if (!auth.ok) {
    return json({ error: auth.error || 'Unauthorized' }, auth.status || 401);
  }
  return null;
}

// ── Preflight ─────────────────────────────────────────────────────────────────
export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

// ── GET: list all prototypes ──────────────────────────────────────────────────
export async function onRequestGet({ request, env }) {
  // Read-only access should be public; admin key only required for mutations.
  const kv = env.PROTOTYPES_KV;
  if (!kv) return json({ error: "Datastore unavailable. Check KV binding." }, 503);

  let ids;
  try {
    const raw = await kv.get("index");
    ids = raw ? JSON.parse(raw) : [];
  } catch {
    return json({ error: "Failed to read prototype index." }, 503);
  }

  let prototypes;
  try {
    const entries = await Promise.all(
      ids.map(async (id) => {
        const raw = await kv.get(`proto:${id}`);
        return raw ? JSON.parse(raw) : null;
      })
    );
    prototypes = entries.filter(Boolean).reverse(); // newest first
  } catch {
    return json({ error: "Failed to read prototypes from datastore." }, 503);
  }

  return json({ prototypes });
}


// ── DELETE: remove a prototype ────────────────────────────────────────────────
export async function onRequestDelete({ request, env }) {
  const denied = guard(request, env);
  if (denied) return denied;
  const kv = env.PROTOTYPES_KV;
  if (!kv) return json({ error: "Datastore unavailable." }, 503);

  // Extract id from the URL path: /api/prototypes/{id}
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);
  const id = parts[parts.length - 1];

  if (!id || id === "prototypes") {
    return json({ error: "Missing prototype id in URL." }, 400);
  }

  try {
    // Remove from index
    const raw = await kv.get("index");
    const ids = raw ? JSON.parse(raw) : [];
    const newIds = ids.filter((i) => i !== id);
    await kv.put("index", JSON.stringify(newIds));

    // Remove prototype data
    await kv.delete(`proto:${id}`);

    return json({ ok: true });
  } catch (err) {
    return json({ error: `Delete failed: ${err.message}` }, 500);
  }
}

// ── POST: submit a new prototype ──────────────────────────────────────────────
export async function onRequestPost({ request, env, ctx }) {
  const denied = guard(request, env);
  if (denied) return denied;
  const kv = env.PROTOTYPES_KV;
  if (!kv) return json({ error: "Datastore unavailable. Check KV binding." }, 503);

  let body;
  try { body = await request.json(); }
  catch { return json({ error: "Invalid JSON body." }, 400); }

  const { name, title, url, summary, fileContent, fileName, encoding = "utf8", mimeType } = body ?? {};

  // ── Required fields ────────────────────────────────────────────────────────
  const missing = [];
  if (!name    || typeof name    !== "string" || !name.trim())    missing.push("name");
  if (!title   || typeof title   !== "string" || !title.trim())   missing.push("title");
  if (!summary || typeof summary !== "string" || !summary.trim()) missing.push("summary");

  const hasUrl  = !!(url && typeof url === "string" && url.trim());
  const hasFile = !!(fileContent && typeof fileContent === "string" && fileContent.trim()
                  && fileName   && typeof fileName   === "string" && fileName.trim());

  if (!hasUrl && !hasFile) missing.push("url or fileContent+fileName");
  if (missing.length) return json({ error: `Missing required fields: ${missing.join(", ")}.` }, 400);

  // ── URL validation ─────────────────────────────────────────────────────────
  let normalizedUrl = null;
  if (hasUrl) {
    normalizedUrl = url.trim();
    if (!/^https?:\/\//i.test(normalizedUrl)) {
      normalizedUrl = 'https://' + normalizedUrl;
    }
    try {
      const parsed = new URL(normalizedUrl);
      if (parsed.protocol !== 'https:') {
        return json({ error: 'URL must start with https:// (use the file upload option for local files).' }, 400);
      }
    } catch {
      return json({ error: 'Invalid URL format. Must include https://.' }, 400);
    }
  }

  // ── File validation ────────────────────────────────────────────────────────
  if (hasFile && !hasUrl) {
    const ext = fileName.trim().split(".").pop().toLowerCase();
    if (!ALLOWED_EXTS.includes(ext)) {
      return json({ error: `Only ${ALLOWED_EXTS.join(", ")} files are accepted.` }, 400);
    }
    // Size check (base64 inflates by ~33%, so raw ≈ base64 * 0.75)
    const approxBytes = encoding === "base64"
      ? fileContent.length * 0.75
      : new TextEncoder().encode(fileContent).length;
    if (approxBytes > MAX_FILE_BYTES) {
      return json({ error: `File exceeds the 5 MB limit.` }, 400);
    }
  }

  // ── Length guards ──────────────────────────────────────────────────────────
  if (name.trim().length    > 100) return json({ error: "name must be ≤ 100 chars." }, 400);
  if (title.trim().length   > 150) return json({ error: "title must be ≤ 150 chars." }, 400);
  if (summary.trim().length > 500) return json({ error: "summary must be ≤ 500 chars." }, 400);
  if (hasUrl && normalizedUrl && normalizedUrl.length > 500) return json({ error: "url must be ≤ 500 chars." }, 400);

  // ── Reject unexpected fields ───────────────────────────────────────────────
  const allowed = new Set(["name","title","url","summary","fileContent","fileName","encoding","mimeType","clientId"]);
  const extra = Object.keys(body).filter(k => !allowed.has(k));
  if (extra.length) return json({ error: `Unexpected fields: ${extra.join(", ")}.` }, 400);

  // ── Build ID and project name ──────────────────────────────────────────────
  const id = crypto.randomUUID();
  const shortId = id.split("-")[0]; // 8 hex chars
  const vercelProject = `norton-proto-${shortId}`;

  // ── Deploy file to Vercel (if no URL provided) ─────────────────────────────
  let resolvedUrl = hasUrl ? (normalizedUrl || url.trim()) : null;
  let sourceType  = hasUrl ? "url" : "file";

  let prototype;  // declared here so binary-media branch can assign before the main build block
  if (hasFile && !hasUrl) {
    const ext = fileName.trim().split(".").pop().toLowerCase();
    const IMAGE_EXTS = ["jpg","jpeg","png","gif","webp","svg"];
    const isBinaryMedia = ext === "pdf" || IMAGE_EXTS.includes(ext);
    let vercelFiles;

    // Images and PDFs: skip Vercel entirely — build prototype and jump to persist
    if (isBinaryMedia) {
      prototype = {
        id,
        name:        name.trim(),
        title:       title.trim(),
        summary:     summary.trim(),
        url:         null,
        resolvedUrl: null,
        fileName:    fileName.trim(),
        mimeType:    mimeType || (ext === "pdf" ? "application/pdf" : "image/" + ext),
        fileContent: fileContent,
        encoding:    "base64",
        sourceType:  "file",
        submittedAt: new Date().toISOString(),
      };
      // For large binary files (>1MB base64), store fileContent separately in KV
      // to keep the main prototype record small
      const protoToStore = { ...prototype };
      if (fileContent && fileContent.length > 500_000) {
        await kv.put(`file:${id}`, fileContent).catch(() => {});
        protoToStore.fileContent = null; // don't embed in main record
        protoToStore.fileStoredSeparately = true;
      }
      // Persist immediately (Laura scoring runs in background)
      try { await kv.put(`proto:${id}`, JSON.stringify(protoToStore)); }
      catch { return json({ error: "Failed to save prototype. Please try again." }, 503); }
      try {
        const raw = await kv.get("index");
        const ids = raw ? JSON.parse(raw) : [];
        ids.push(id);
        await kv.put("index", JSON.stringify(ids));
      } catch { /* non-fatal */ }
      // Score against Laura in background (non-blocking — vision call can be slow)
      if (ctx) ctx.waitUntil((async () => {
        try {
          const lauraResult = await scoreLaura(prototype, fileContent, env);
          if (lauraResult) {
            const updated = { ...prototype, ...lauraResult };
            await kv.put(`proto:${id}`, JSON.stringify(updated));
          }
        } catch {}
      })());
      return json({ ok: true, prototype });
    }

    if (!env.VERCEL_TOKEN) {
      return json({ error: "File deployments unavailable — VERCEL_TOKEN secret not set. Contact the sprint lead." }, 503);
    }
    try {
      if (ext === "zip") {
        const rawFiles = await parseZip(fileContent); // fileContent is base64
        if (rawFiles.length === 0) {
          return json({ error: "ZIP file appears to be empty or unreadable." }, 400);
        }
        vercelFiles = filesToVercelPayload(rawFiles);
        // Inject Norton favicon into any index.html inside the zip
        const iconTags = '<link rel="icon" type="image/svg+xml" href="https://norton-reimagined-sprint.pages.dev/assets/norton-checkmark.svg"><link rel="apple-touch-icon" sizes="180x180" href="https://norton-reimagined-sprint.pages.dev/assets/icon-180.png">';
        vercelFiles = vercelFiles.map(f => {
          if ((f.file === "index.html" || f.file === "public/index.html") && f.encoding !== "base64") {
            let d = f.data;
            if (d.includes("</head>")) {
              d = d.replace("</head>", iconTags + "</head>");
            } else if (d.includes("<head>")) {
              d = d.replace("<head>", "<head>" + iconTags);
            }
            return { ...f, data: d };
          }
          return f;
        });
      } else {
        // Single HTML / JS / JSX file — serve at root as index.html
        const ext = fileName.trim().split(".").pop().toLowerCase();
        let deployContent = fileContent;
        let deployEncoding = encoding === "base64" ? "base64" : "utf-8";
        const iconTags = '<link rel="icon" type="image/svg+xml" href="https://norton-reimagined-sprint.pages.dev/assets/norton-checkmark.svg"><link rel="apple-touch-icon" sizes="180x180" href="https://norton-reimagined-sprint.pages.dev/assets/icon-180.png">';
        if (ext === 'jsx' || ext === 'tsx') {
          deployContent = wrapJsxPrototype(deployContent, { encoding, isTsx: ext === 'tsx' });
          deployEncoding = 'utf-8';
        } else if (ext === 'html' && encoding !== 'base64') {
          if (deployContent.includes('</head>')) {
            deployContent = deployContent.replace('</head>', iconTags + '</head>');
          } else if (deployContent.includes('<head>')) {
            deployContent = deployContent.replace('<head>', '<head>' + iconTags);
          }
        }
        vercelFiles = [{
          file: ext === "js" ? "index.js" : "index.html",
          data: deployContent,
          encoding: deployEncoding,
        }];
      }
    } catch (err) {
      return json({ error: `Failed to process file: ${err.message}` }, 400);
    }

    try {
      resolvedUrl = await deployToVercel(vercelFiles, vercelProject, env.VERCEL_TOKEN);
    } catch (err) {
      return json({ error: `Vercel deployment failed: ${err.message}` }, 502);
    }
    sourceType = "vercel";
  }

  // ── Build prototype object (only reached for non-binary-media files) ─────────
  prototype = {
    id,
    name:        name.trim(),
    title:       title.trim(),
    url:         resolvedUrl || normalizedUrl,
    summary:     summary.trim(),
    submittedAt: new Date().toISOString(),
    sourceType,
    ...(hasFile && !hasUrl ? { fileName: fileName.trim(), vercelProject } : {}),
  };

  // ── Auto-score against Laura (non-fatal) ───────────────────────────────────
  // Pass fileContent for file uploads so we can extract text directly.
  // For URL submissions we'll fetch the page. Failures are silently ignored.
  const lauraResult = await scoreLaura(prototype, hasFile && !hasUrl ? fileContent : null, env);
  if (lauraResult) {
    prototype = { ...prototype, ...lauraResult };
  }

  // ── Persist ────────────────────────────────────────────────────────────────
  try { await kv.put(`proto:${id}`, JSON.stringify(prototype)); }
  catch { return json({ error: "Failed to save prototype. Please try again." }, 503); }

  try {
    const raw = await kv.get("index");
    const ids = raw ? JSON.parse(raw) : [];
    ids.push(id);
    await kv.put("index", JSON.stringify(ids));
  } catch {
    return json({ error: "Prototype saved but index update failed.", prototype }, 207);
  }

  return json({ prototype }, 201);
}


// ═══════════════════════════════════════════════════════════════════════════════
// LAURA AUTO-SCORING
// Runs automatically on every prototype submission. Non-fatal — prototype saves
// even if scoring fails. Extracts readable text from the prototype content and
// evaluates it against the full Laura persona using Anthropic directly.
// ═══════════════════════════════════════════════════════════════════════════════

const LAURA_CONTEXT_SCORE = `
You are evaluating a product prototype with extreme rigour. Most prototypes in design sprints are too safe, too incremental, or too niche to earn high scores. Your default posture is SKEPTICAL — a prototype must actively prove it deserves a high score, not just pass a checklist.

Your final 0–100 score is a STRICT weighted composite:
  - 40% ENGAGEMENT REALITY: Does Laura genuinely return to this weekly or daily — not because she has to, but because she wants to? Does it earn real estate on her home screen?
  - 25% DIFFERENTIATION: What can ONLY Norton ship? What does this do that Apple Security, Google One, Aura, Genie, or 1Password cannot copy within 12 months?
  - 20% LAURA PERSONA FIT: Does this fit how she actually lives — effortless, default-on, calm, household-framed?
  - 10% MARKET SPLASH: Would this make headlines? Drive trial? Create a "wait, Norton does that now?" moment?
  - 5% PROTECTION HERITAGE: Does it still feel like the next chapter of Norton — not a random pivot?

Concept reminder: you’re reviewing sprint concepts, not finished products. If the prototype clearly describes a believable ritual or moat—even if every screen isn’t built yet—credit the potential. Score what the team is aiming for when fully executed, not just the pixels you see today.

════════════════════════════════════════════
THE BRUTAL TRUTH ABOUT SECURITY APPS
════════════════════════════════════════════
CORE CHALLENGE: Pure security apps do not create daily engagement for normal people. Think honestly:

- When did Laura last open her antivirus app ON PURPOSE (not from a notification)?
- "AI-powered protection" is now table stakes — Apple, Google, and Microsoft ship it free.
- A calmer alert UI is incremental, not transformational. It reduces pain but does not build habit.
- Background protection is the MINIMUM expected — Laura does not return to a product that just "keeps running quietly."
- UNLESS the concept fundamentally shifts what Laura gets out of opening the app (utility, insight, family connection, peace of mind as a FEELING not a feature), a security-focused idea will score low on engagement.

WHEN SECURITY CAN SCORE HIGH:
- If the concept reframes protection as something valuable beyond threat-blocking (e.g., a family wellness hub, a digital life manager, a trust layer for AI interactions)
- If it gives Laura daily pull — a reason to check in like she checks email or weather
- If it does something Laura cannot get anywhere else at any price
- If it uses Norton's brand authority to reshape how Laura THINKS about digital safety (mental model shift)

════════════════════════════════════════════
LENS 1 — LAURA, THE OUTSOURCER
════════════════════════════════════════════
LAURA IN ONE LINE: She is the reluctant guardian of her household's digital life. She does not want the job. She wants a trusted expert to handle it invisibly — like insurance or utilities — but she is deeply burnt out on apps that demand her attention without giving her anything back.

WHO SHE IS:
- 35–55, working parent, full household (partner + kids), 5–10 devices
- Tech-comfortable but not "IT people" — adopts tools that reduce effort and anxiety
- "Unknowledgeable" mindset: not curious about how cyber works, just wants it to work
- Sees security as basic life admin. Already pays for Norton. Rarely opens it.
- Her real pain: mental load, not threat level. She worries in the abstract, not in response to specific risks.

HER 4 JOBS TO BE DONE:
1. Protect my whole household with zero admin from me
2. Block threats before we click — scams, dodgy sites, risky downloads
3. Keep my kids safe with simple, trustworthy controls
4. Tell me what to do when something looks wrong, in plain English

THE ENGAGEMENT PROBLEM — BE HONEST ABOUT IT:
Security does not build habit. Laura does not "check her protection score" in the morning.
She checks weather, news, messages, calendar, banking. NOT her antivirus.
The ONLY way a security app earns daily use is if it gives her something she genuinely wants:
- Useful household intelligence (beyond threats)
- Family coordination or peace of mind as a DAILY ritual
- Something new she discovers every time she opens it
Ask this question first: "Why would Laura open this tomorrow morning when no threat has fired?"
If you cannot answer that clearly, cap the engagement score at 35.

WHAT SHE LOVES: Default-on everything, household framing, calm tone, zero config, pleasant surprises.
WHAT SHE REJECTS: Dashboards of toggles, jargon, gamification, upsells, anything that requires her to DO something she does not understand.

BRAND LEADER ADVANTAGE — WHEN IT APPLIES:
Like Nike reframing athletics, Headspace reframing mental health, or Apple reframing privacy — Norton has the brand authority to shift Laura's mental model of what "digital safety" means. A concept that reimagines the category entirely (not just a better antivirus) can score high on this dimension. Give credit for bold brand moves that feel credible for Norton's heritage even if they go far beyond traditional security.

════════════════════════════════════════════
LENS 2 — DIFFERENTIATION CHALLENGE
════════════════════════════════════════════
Before scoring differentiation, mentally check this list:
- Apple builds free security, scam detection, and Screen Time into iOS — could this just be "use Screen Time better"?
- Google One bundles VPN + identity monitoring for $3/month — is this just that?
- Aura and LifeLock already do identity + family monitoring — is this just that with a Norton logo?
- Genie and Robokiller already do AI scam detection standalone — is this just that?
- 1Password and Dashlane already do password + family vaults — is this just that?

If the answer to ANY of those is "yes, basically" — cap differentiation score at 40.
Norton earns a high differentiation score ONLY if it does something structurally unique: a category it can own, data or trust relationships competitors cannot replicate, or a combination of capabilities that only Norton's scale + brand enables.

════════════════════════════════════════════
LENS 3 — MARKET SPLASH & GROWTH
════════════════════════════════════════════
Ask: Would a journalist write "Norton just became a _____ company"?
Ask: Would a non-subscriber hear about this and consider switching FROM Apple/Google for it?
Ask: Does this open a new acquisition channel or strengthen retention in a way that's visible?
If the concept is "better antivirus for existing subscribers" — cap growth score at 30.
High scores require net-new appeal: a reason for people who weren't thinking about Norton to start.

════════════════════════════════════════════
SCORING CALIBRATION — CONCEPT-STAGE LENS
════════════════════════════════════════════
- 85–100: Breakthrough concept — ritual + moat are undeniable even if execution is early. Expect only the very best ideas here.
- 70–84: Strong concept — clear weekly habit AND a believable reason Norton wins. This is the target zone for top sprint work.
- 55–69: Promising direction — either the ritual or the defensible wedge is solid, but one critical piece is still fuzzy.
- 40–54: Interesting feature set but missing the big idea — feels incremental or copyable.
- 0–39: Misses Laura entirely or undermines Norton’s brand.

Because we’re reviewing concepts, it’s okay to reward ambition. If a team clearly articulates how the ritual and wedge will work (even if you don’t see every screen), use the 70s. Reserve sub‑50 scores for concepts that don’t yet answer the core questions.

Verdict MUST match score band exactly:
- 85–100 → LOVES IT
- 70–84 → LIKES IT
- 50–69 → MEH
- 30–49 → SKEPTICAL
- 0–29 → REJECTS IT
`;

async function screenshotUrl(url) {
  // Uses microlink.io (free, no key needed) to screenshot any live URL.
  // Returns base64-encoded PNG, or null on failure.
  try {
    const apiUrl = `https://api.microlink.io?url=${encodeURIComponent(url)}&screenshot=true&meta=false&embed=screenshot.url`;
    const metaRes = await fetch(apiUrl, { signal: AbortSignal.timeout(15000) });
    if (!metaRes.ok) return null;
    const meta = await metaRes.json();
    const screenshotUrl = meta?.data?.screenshot?.url;
    if (!screenshotUrl) return null;

    // Fetch the actual image
    const imgRes = await fetch(screenshotUrl, { signal: AbortSignal.timeout(10000) });
    if (!imgRes.ok) return null;
    const imgBuf = await imgRes.arrayBuffer();
    const bytes = new Uint8Array(imgBuf);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  } catch {
    return null;
  }
}

// ── Deep text extraction from HTML ─────────────────────────────────────────
// Preserves button labels, headings, link text, aria-labels, placeholder text,
// and screen section hints so the LLM sees the full prototype content.
function extractDeepText(html) {
  // Pull aria-labels, alt text, placeholders, titles before stripping tags
  const extras = [];
  for (const m of html.matchAll(/(?:aria-label|alt|placeholder|title)="([^"]{2,120})"/gi)) {
    extras.push(m[1]);
  }
  // Preserve button/heading content with context hint
  const withHints = html
    .replace(/<(h[1-6])[^>]*>([\s\S]*?)<\/\1>/gi, (_, tag, inner) =>
      `[${tag.toUpperCase()}] ${inner} `)
    .replace(/<button[^>]*>([\s\S]*?)<\/button>/gi, (_, inner) =>
      `[BTN] ${inner} `)
    .replace(/<a[^>]*>([\s\S]*?)<\/a>/gi, (_, inner) =>
      `[LINK] ${inner} `)
    .replace(/<(label|span|p|li|td|th)[^>]*>([\s\S]*?)<\/\1>/gi, (_, _t, inner) => inner + ' ');
  const cleaned = withHints
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
  const combined = extras.join(' | ') + ' ' + cleaned;
  return combined.slice(0, 12000);
}

async function scoreLaura(prototype, fileContent, env) {
  // Scores a prototype against Laura using visual screenshots + deep text extraction.
  // Crawls all discovered screens, takes screenshots, sends to Claude Vision.
  if (!env.ANTHROPIC_API_KEY) return null;

  // ── 1. Check if this is an image/PDF upload — use directly as vision input
  const IMAGE_EXTS = ['jpg','jpeg','png','gif','webp','svg'];
  const fileExt = (prototype.fileName || '').split('.').pop().toLowerCase();
  const isImageUpload = IMAGE_EXTS.includes(fileExt);
  const isPdfUpload   = fileExt === 'pdf';
  const isBinaryMedia = isImageUpload || isPdfUpload;

  // If fileContent was stored separately (large file), load it from KV
  if (!fileContent && prototype.fileStoredSeparately && env.PROTOTYPES_KV) {
    try { fileContent = await env.PROTOTYPES_KV.get(`file:${prototype.id}`) || ''; } catch {}
  }
  // Also check if prototype itself has fileContent (passed directly)
  if (!fileContent && prototype.fileContent) {
    fileContent = prototype.fileContent;
  }

  // ── 2. Crawl the prototype for all screens + screenshots ────────────────
  const protoUrl = prototype.url || prototype.resolvedUrl || '';
  let crawlResult = { screens: [], textContent: '' };

  if (isBinaryMedia && fileContent) {
    // Directly use the uploaded image/PDF as a vision input
    const mediaMime = prototype.mimeType || (isPdfUpload ? 'application/pdf' : 'image/' + fileExt);
    const safeBase64 = fileContent.replace(/[^A-Za-z0-9+/=]/g, '');
    crawlResult.screens = [{ url: prototype.fileName, label: prototype.fileName, base64: safeBase64, mimeType: mediaMime, isPdf: isPdfUpload }];
  } else if (protoUrl && !protoUrl.startsWith('/api/')) {
    try {
      crawlResult = await crawlPrototype(protoUrl, { fileContent: fileContent || '' });
    } catch { /* fall through to text-only */ }
  } else if (fileContent) {
    // File upload — no URL to screenshot, use text extraction only
    crawlResult.textContent = fileContent;
  }

  // ── 2. Deep text extraction as fallback / supplement ───────────────────
  const textFallback = extractDeepText(crawlResult.textContent || fileContent || '');

  // ── 3. Build meta context ──────────────────────────────────────────────
  const metaContext = [
    `Title: "${prototype.title}"`,
    `Submitted by: ${prototype.name}`,
    `Summary: ${prototype.summary}`,
    textFallback ? `\nExtracted text from all screens:\n${textFallback}` : '',
  ].join('\n');

  const screensFound = crawlResult.screens.filter(s => s.base64).length;
  const instruction = `${LAURA_CONTEXT_SCORE}

---
PROTOTYPE TO EVALUATE:
${metaContext}

${screensFound > 0 ? `You are being shown ${crawlResult.screens.length} screenshot(s) of the prototype below. Study EVERY screen carefully — look at all the UI elements, buttons, labels, flows, and interactions visible. Use what you see to inform your assessment of how Laura would react. Pay attention to: what the app asks Laura to DO, what it gives her in return, how often she would realistically return to it.` : 'No screenshots were available. Use the extracted text above for your assessment.'}

BEFORE scoring, answer these questions internally:
1. Why would Laura open this app tomorrow morning when no security alert has fired?
2. What does this do that Apple Screen Time + Google One + Aura combined cannot?
3. Is this a 10x improvement or a 10% improvement on what exists?
4. Would a non-Norton subscriber hear about this and switch?
5. Does this concept change how Laura THINKS about digital safety, or just make the current experience slightly better?

---
Respond with ONLY a valid JSON object — no prose, no markdown fences:
{
  "score": <integer 0-100, strict weighted composite — calibrated so 70+ is genuinely exceptional>,
  "verdict": "<LOVES IT | LIKES IT | MEH | SKEPTICAL | REJECTS IT>",
  "recommendation": "<3-4 sentences: What is this concept's fatal flaw OR breakthrough insight? Be specific about why Laura would or would not return weekly. Call out the competitors it does NOT beat.>",
  "engagementScore": <integer 0-100 — honest answer to: would Laura open this weekly on her own initiative?>,
  "differentiationScore": <integer 0-100 — what only Norton can ship; penalise if Apple/Google/Aura could copy in 12 months>,
  "growthScore": <integer 0-100 — would a non-subscriber hear about this and switch? Would it make headlines?>,
  "heritageScore": <integer 0-100 — does it feel like the next chapter of Norton, not a random pivot?>,
  "personaFitScore": <integer 0-100 — how well does it fit Laura's actual daily life and mental model?>,
  "engagementChallenge": "<1-2 sentences: honest answer to 'why would Laura open this weekly when no alert fires?'>",
  "competitorGap": "<1 sentence: what competitor could most easily replicate this and how soon?>",
  "wouldLauraOpenWeekly": <true | false>
}
Verdict MUST match score band exactly: 85-100 → LOVES IT | 70-84 → LIKES IT | 50-69 → MEH | 30-49 → SKEPTICAL | 0-29 → REJECTS IT`;

  // ── 4. Build message content (text + vision blocks) ─────────────────────
  const msgContent = screensFound > 0
    ? buildVisionContent(crawlResult.screens, instruction)
    : instruction;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-opus-4-5',  // Vision-capable model; highest reasoning quality for scoring
        max_tokens: 800,
        messages: [{ role: 'user', content: msgContent }],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const raw = (data?.content?.[0]?.text ?? '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const result = JSON.parse(raw);
    return {
      lauraScore:               result.score                ?? null,
      lauraVerdict:             result.verdict              ?? null,
      lauraRecommendation:      result.recommendation       ?? null,
      lauraEngagementScore:     result.engagementScore      ?? null,
      lauraDifferentiationScore:result.differentiationScore ?? null,
      lauraGrowthScore:         result.growthScore          ?? null,
      lauraHeritageScore:       result.heritageScore        ?? null,
      lauraPersonaFitScore:     result.personaFitScore      ?? null,
      lauraEngagementChallenge: result.engagementChallenge  ?? null,
      lauraCompetitorGap:       result.competitorGap        ?? null,
      lauraWouldOpenWeekly:     result.wouldLauraOpenWeekly ?? null,
    };
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ZIP PARSER — pure JS, no npm. Uses DecompressionStream (deflate-raw) for
// DEFLATE entries and central directory for correct sizes (handles data
// descriptors from macOS/Windows zippers).
// ═══════════════════════════════════════════════════════════════════════════════
async function parseZip(base64Data) {
  // Decode base64 → Uint8Array
  const binaryStr = atob(base64Data);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
  const buffer = bytes.buffer;
  const view   = new DataView(buffer);
  const len    = buffer.byteLength;

  // 1. Find End of Central Directory record (search from end, handles ZIP comment)
  let eocd = -1;
  for (let i = len - 22; i >= Math.max(0, len - 65558); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("Not a valid ZIP file (EOCD not found).");

  const numEntries = view.getUint16(eocd + 10, true);
  const cdOffset   = view.getUint32(eocd + 16, true);

  // 2. Parse central directory (always has correct sizes, even with data descriptors)
  const files = [];
  let cdPos = cdOffset;

  for (let i = 0; i < numEntries; i++) {
    if (view.getUint32(cdPos, true) !== 0x02014b50) break;

    const compression      = view.getUint16(cdPos + 10, true);
    const compressedSize   = view.getUint32(cdPos + 20, true);
    const filenameLen      = view.getUint16(cdPos + 28, true);
    const extraLen         = view.getUint16(cdPos + 30, true);
    const commentLen       = view.getUint16(cdPos + 32, true);
    const localOffset      = view.getUint32(cdPos + 42, true);
    const filename         = new TextDecoder("utf-8").decode(
      new Uint8Array(buffer, cdPos + 46, filenameLen)
    );

    cdPos += 46 + filenameLen + extraLen + commentLen;

    // Skip directories and macOS metadata
    if (
      filename.endsWith("/") ||
      filename.startsWith("__MACOSX/") ||
      filename.includes("/.DS_Store") ||
      filename === ".DS_Store"
    ) continue;

    // Get data offset from local file header
    const localFilenameLen = view.getUint16(localOffset + 26, true);
    const localExtraLen    = view.getUint16(localOffset + 28, true);
    const dataOffset       = localOffset + 30 + localFilenameLen + localExtraLen;

    let data;
    if (compression === 0) {
      // STORED — no compression
      data = new Uint8Array(buffer.slice(dataOffset, dataOffset + compressedSize));
    } else if (compression === 8) {
      // DEFLATE — use DecompressionStream
      const compressed = new Uint8Array(buffer, dataOffset, compressedSize);
      const ds = new DecompressionStream("deflate-raw");
      const writer = ds.writable.getWriter();
      const reader = ds.readable.getReader();
      writer.write(compressed);
      writer.close();
      const chunks = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      const total = chunks.reduce((s, c) => s + c.length, 0);
      data = new Uint8Array(total);
      let pos = 0;
      for (const c of chunks) { data.set(c, pos); pos += c.length; }
    } else {
      throw new Error(`Unsupported compression method ${compression} in "${filename}". Please use standard ZIP (DEFLATE or STORED).`);
    }

    files.push({ path: filename, data });
  }

  // Strip common folder prefix (e.g. my-prototype/index.html → index.html)
  return stripCommonPrefix(files);
}

function stripCommonPrefix(files) {
  if (files.length === 0) return files;
  const firstParts = files[0].path.split("/");
  let prefixLen = 0;
  for (let depth = 1; depth < firstParts.length; depth++) {
    const prefix = firstParts.slice(0, depth).join("/") + "/";
    if (files.every(f => f.path.startsWith(prefix))) prefixLen = prefix.length;
    else break;
  }
  if (prefixLen === 0) return files;
  return files.map(f => ({ ...f, path: f.path.slice(prefixLen) })).filter(f => f.path);
}

// ═══════════════════════════════════════════════════════════════════════════════
// VERCEL DEPLOYMENT
// ═══════════════════════════════════════════════════════════════════════════════
function filesToVercelPayload(rawFiles) {
  const decoder = new TextDecoder("utf-8", { fatal: false });
  return rawFiles.map(({ path, data }) => {
    const ext = path.split(".").pop().toLowerCase();
    if (TEXT_EXTS.has(ext)) {
      return { file: path, data: decoder.decode(data), encoding: "utf-8" };
    } else {
      // Binary — base64 encode
      let binary = "";
      for (let i = 0; i < data.length; i++) binary += String.fromCharCode(data[i]);
      return { file: path, data: btoa(binary), encoding: "base64" };
    }
  });
}

async function deployToVercel(files, projectName, token) {
  const authHeader = { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" };

  // 1. Create deployment
  const deployRes = await fetch("https://api.vercel.com/v13/deployments", {
    method: "POST",
    headers: authHeader,
    body: JSON.stringify({
      name: projectName,
      files,
      projectSettings: {
        framework:       null,
        buildCommand:    null,
        outputDirectory: null,
        installCommand:  null,
      },
      target: "production",
    }),
  });

  if (!deployRes.ok) {
    const err = await deployRes.json().catch(() => ({}));
    throw new Error(err.error?.message || `Vercel responded with ${deployRes.status}`);
  }

  const deployData = await deployRes.json();
  // Debug: log all URL fields Vercel returns
  console.log("Vercel deploy response fields:", JSON.stringify({
    url: deployData.url,
    alias: deployData.alias,
    aliases: deployData.aliases,
    readyState: deployData.readyState,
  }));
  if (!deployData.url) throw new Error(`Vercel returned no URL. Keys: ${Object.keys(deployData).join(", ")}`);

  // 2. Disable deployment protection so anyone with the link can view.
  // First get the project id (needed by some protection endpoints).
  const projectRes = await fetch(
    `https://api.vercel.com/v9/projects/${encodeURIComponent(projectName)}`,
    { headers: authHeader }
  );
  const projectData = projectRes.ok ? await projectRes.json() : {};
  const projectId   = projectData.id || projectName;

  // Patch protection off — try both field names for compatibility.
  const patchRes = await fetch(
    `https://api.vercel.com/v9/projects/${encodeURIComponent(projectId)}`,
    {
      method:  "PATCH",
      headers: authHeader,
      body: JSON.stringify({
        ssoProtection:      null,
        passwordProtection: null,
      }),
    }
  );

  if (!patchRes.ok) {
    const patchErr = await patchRes.json().catch(() => ({}));
    // Surface the error so we can debug — still return the URL
    console.error("Vercel protection patch failed:", JSON.stringify(patchErr));
    // Attach error info to the response URL so caller can see it
    return `https://${deployData.url}?__protection_patch_error=${encodeURIComponent(patchErr?.error?.message || patchRes.status)}`;
  }

  return `https://${deployData.url}`;
}


function wrapJsxPrototype(rawContent, { encoding = 'utf-8', isTsx = false }) {
  const source = encoding === 'base64' ? base64ToUtf8(rawContent) : rawContent;
  const stripped = sanitizeJsxSource(source);
  const needsAutoRender = !/ReactDOM\./.test(stripped);
  const componentName = needsAutoRender ? guessComponentName(stripped) : null;
  const autoRender = needsAutoRender && componentName;
  let finalSource = stripped;
  if (autoRender) {
    finalSource += `
const __root = ReactDOM.createRoot(document.getElementById('root'));
__root.render(<${componentName} />);
`;
  }
  const safeSource = finalSource.replace(/<\/script>/gi, '<\/script>').trim();
  const presets = isTsx ? 'env,react,typescript' : 'env,react';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Prototype</title>
  <link rel="icon" type="image/svg+xml" href="https://norton-reimagined-sprint.pages.dev/assets/norton-checkmark.svg">
  <link rel="apple-touch-icon" sizes="180x180" href="https://norton-reimagined-sprint.pages.dev/assets/icon-180.png">
  <script crossorigin src="https://unpkg.com/react@18/umd/react.development.js"></script>
  <script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.development.js"></script>
  <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
  <style>
    html, body { margin:0; padding:0; background:#F8F8F7; font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; min-height:100vh; }
    #root { min-height:100vh; }
  </style>
</head>
<body>
  <div id="root"></div>
  <script type="text/babel" data-presets="${presets}">
    const { useState, useEffect, useMemo, useRef, useCallback, useReducer, useContext } = React;
${safeSource}
  </script>
</body>
</html>`;
}

function sanitizeJsxSource(src) {
  let out = src.replace(/\r\n/g, '\n');
  out = out.replace(/\r/g, '\n');
  out = out.replace(/import\s+[^;]+?['"'][^'"']+['"'];?\s*/g, '');
  out = out.replace(/export\s+default\s+function\s+/g, 'function ');
  out = out.replace(/export\s+default\s+class\s+/g, 'class ');
  out = out.replace(/export\s+default\s+/g, '');
  out = out.replace(/export\s+const\s+/g, 'const ');
  out = out.replace(/export\s+function\s+/g, 'function ');
  out = out.replace(/export\s+class\s+/g, 'class ');
  out = out.replace(/export\s+\{[^}]+\};?/g, '');
  return out;
}


function guessComponentName(source) {
  const fn = source.match(/function\s+([A-Z][A-Za-z0-9_]*)\s*\(/);
  if (fn) return fn[1];
  const constMatch = source.match(/const\s+([A-Z][A-Za-z0-9_]*)\s*=\s*(?:\(|function|class)/);
  if (constMatch) return constMatch[1];
  const classMatch = source.match(/class\s+([A-Z][A-Za-z0-9_]*)\s+extends\s+React/);
  if (classMatch) return classMatch[1];
  return null;
}

function base64ToUtf8(b64) {
  const binary = atob(b64);
  const bytes = Uint8Array.from(binary, ch => ch.charCodeAt(0));
  const decoder = new TextDecoder('utf-8');
  return decoder.decode(bytes);
}

