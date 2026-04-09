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

// ── Preflight ─────────────────────────────────────────────────────────────────
export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

// ── GET: list all prototypes ──────────────────────────────────────────────────
export async function onRequestGet({ env }) {
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
  if (hasUrl) {
    try { new URL(url.trim()); }
    catch { return json({ error: "Invalid URL format. Must include https://." }, 400); }
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
  if (hasUrl && url.trim().length > 500) return json({ error: "url must be ≤ 500 chars." }, 400);

  // ── Reject unexpected fields ───────────────────────────────────────────────
  const allowed = new Set(["name","title","url","summary","fileContent","fileName","encoding","mimeType","clientId"]);
  const extra = Object.keys(body).filter(k => !allowed.has(k));
  if (extra.length) return json({ error: `Unexpected fields: ${extra.join(", ")}.` }, 400);

  // ── Build ID and project name ──────────────────────────────────────────────
  const id = crypto.randomUUID();
  const shortId = id.split("-")[0]; // 8 hex chars
  const vercelProject = `norton-proto-${shortId}`;

  // ── Deploy file to Vercel (if no URL provided) ─────────────────────────────
  let resolvedUrl = hasUrl ? url.trim() : null;
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
        // Single HTML or JS file — always serve at root as index.html
        const ext = fileName.trim().split(".").pop().toLowerCase();
        let deployContent = fileContent;
        // Inject Norton favicon into HTML files
        if (ext === "html" && encoding !== "base64") {
          const iconTags = '<link rel="icon" type="image/svg+xml" href="https://norton-reimagined-sprint.pages.dev/assets/norton-checkmark.svg"><link rel="apple-touch-icon" sizes="180x180" href="https://norton-reimagined-sprint.pages.dev/assets/icon-180.png">';
          if (deployContent.includes("</head>")) {
            deployContent = deployContent.replace("</head>", iconTags + "</head>");
          } else if (deployContent.includes("<head>")) {
            deployContent = deployContent.replace("<head>", "<head>" + iconTags);
          }
        }
        vercelFiles = [{
          file: ext === "js" ? "index.js" : "index.html",
          data: deployContent,
          encoding: encoding === "base64" ? "base64" : "utf-8",
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
    url:         resolvedUrl,
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
You are evaluating a product prototype against TWO lenses simultaneously:
(1) Laura — the target persona
(2) Norton's three business objectives

Your final 0–100 score is a weighted composite:
  - 50% Laura (does she love it, use it regularly, find it effortless?)
  - 25% Business Objective: Engagement (does it shift Norton from set-and-forget to a tool Laura returns to daily/weekly?)
  - 15% Business Objective: Growth (does it give Norton a credible edge in the competitive landscape vs. Apple Security, Google One, standalone scam apps, LifeLock?)
  - 10% Business Objective: Protection Heritage (does it preserve and honour Norton's 30-year identity as the gold standard in protection — not a pivot away from security?)

════════════════════════════════════════════
LENS 1 — LAURA, THE OUTSOURCER
════════════════════════════════════════════
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

WHAT SHE LOVES: Default-on protection, household framing, calm assured tone, zero config.
WHAT SHE REJECTS: Dashboards of toggles, jargon, gamification, dark patterns, added admin.

════════════════════════════════════════════
LENS 2 — NORTON'S BUSINESS OBJECTIVES
════════════════════════════════════════════

OBJECTIVE A — ENGAGEMENT (weight: 25%)
Norton's strategic shift: move from a "set it and forget it" security utility to a product Laura actively opens and values regularly (daily or weekly). A high-scoring prototype creates natural, recurring reasons for Laura to return — not because she has to, but because she wants to.
Ask: Does this prototype give Laura a reason to open Norton tomorrow? Next week? Does it build habit or ritual? Or is it still a background process she never thinks about?

OBJECTIVE B — GROWTH & COMPETITIVE EDGE (weight: 15%)
Norton competes with Apple's built-in security, Google One, identity-focused players (LifeLock, Aura, Lifelock), standalone scam apps (Robokiller, Genie), and password managers (1Password). A high-scoring prototype gives Norton a clear "why Norton vs. anything else" — either through breadth (one app for everything), trust (30-year brand), or a category Norton can own that competitors can't easily replicate.
Ask: Does this prototype help Norton win in the market? Does it differentiate meaningfully? Could a competitor easily copy it in 12 months?

OBJECTIVE C — PROTECTION HERITAGE (weight: 10%)
Norton's brand equity is built on 30 years of being the most trusted name in protection. The reimagined product must evolve Norton — not abandon it. It should feel like the next logical chapter of the protection story, not a random pivot.
Ask: Does this prototype still feel like Norton at its best? Does it reinforce the idea that Norton = protection, now for the modern threat landscape? Or does it drift into territory that feels un-Norton (fintech, social media, entertainment)?

════════════════════════════════════════════
COMPOSITE SCORING GUIDE (0–100)
════════════════════════════════════════════
- 90–100 LOVES IT: Exceptional on all lenses — Laura loves it, it drives habit, it's competitively defensible, and it's unmistakably Norton.
- 75–89 LIKES IT: Strong on most lenses — clear value for Laura and business, minor gaps.
- 55–74 MEH: Passes on some lenses but has real weaknesses — either Laura won't use it regularly, or business impact is unclear.
- 35–54 SKEPTICAL: Significant concerns on 2+ lenses — either Laura rejects it or it undermines business objectives.
- 0–34 REJECTS IT: Fails fundamentally — wrong persona, damages the brand, or has no competitive merit.
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

  // ── 2. Crawl the prototype for all screens + screenshots ────────────────
  const protoUrl = prototype.url || prototype.resolvedUrl || '';
  let crawlResult = { screens: [], textContent: '' };

  if (isBinaryMedia && fileContent) {
    // Directly use the uploaded image as a vision screen
    const mediaMime = prototype.mimeType || (isImageUpload ? 'image/' + fileExt : 'image/png');
    const safeBase64 = fileContent.replace(/[^A-Za-z0-9+/=]/g, '');
    crawlResult.screens = [{ url: prototype.fileName, label: prototype.fileName, base64: safeBase64, mimeType: mediaMime }];
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

${screensFound > 0 ? `You are being shown ${crawlResult.screens.length} screenshot(s) of the prototype below. Study EVERY screen carefully — look at all the UI elements, buttons, labels, flows, and interactions visible. Use what you see to inform your assessment of how Laura would react.` : 'No screenshots were available. Use the extracted text above for your assessment.'}

---
Respond with ONLY a valid JSON object — no prose, no markdown fences:
{
  "score": <integer 0-100, weighted composite across all lenses>,
  "verdict": "<LOVES IT | LIKES IT | MEH | SKEPTICAL | REJECTS IT>",
  "recommendation": "<2-3 sentences covering both Laura's reaction AND how well the concept serves Norton's engagement, growth, and heritage objectives>",
  "engagementScore": <integer 0-100, does it drive regular use vs. set-and-forget?>,
  "growthScore": <integer 0-100, does it give Norton a defensible competitive edge?>,
  "heritageScore": <integer 0-100, does it honour Norton's protection identity?>
}
The verdict MUST match the score band: 90-100 → LOVES IT | 75-89 → LIKES IT | 55-74 → MEH | 35-54 → SKEPTICAL | 0-34 → REJECTS IT`;

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
        model: 'claude-opus-4-5',  // Vision-capable model
        max_tokens: 400,
        messages: [{ role: 'user', content: msgContent }],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const raw = (data?.content?.[0]?.text ?? '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const result = JSON.parse(raw);
    return {
      lauraScore:           result.score           ?? null,
      lauraVerdict:         result.verdict          ?? null,
      lauraRecommendation:  result.recommendation   ?? null,
      lauraEngagementScore: result.engagementScore  ?? null,
      lauraGrowthScore:     result.growthScore      ?? null,
      lauraHeritageScore:   result.heritageScore    ?? null,
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
