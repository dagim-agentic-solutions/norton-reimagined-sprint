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
const MAX_FILE_BYTES   = 5 * 1024 * 1024; // 5 MB raw (before base64)
const ALLOWED_EXTS     = ["html", "js", "zip"];
const TEXT_EXTS        = new Set(["html","htm","css","js","ts","jsx","tsx","json","txt","md","svg","xml","yaml","yml","toml"]);

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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

// ── POST: submit a new prototype ──────────────────────────────────────────────
export async function onRequestPost({ request, env }) {
  const kv = env.PROTOTYPES_KV;
  if (!kv) return json({ error: "Datastore unavailable. Check KV binding." }, 503);

  let body;
  try { body = await request.json(); }
  catch { return json({ error: "Invalid JSON body." }, 400); }

  const { name, title, url, summary, fileContent, fileName, encoding = "utf8" } = body ?? {};

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
    if (!env.VERCEL_TOKEN) {
      return json({ error: "File deployments unavailable — VERCEL_TOKEN secret not set. Contact the sprint lead." }, 503);
    }
  }

  // ── Length guards ──────────────────────────────────────────────────────────
  if (name.trim().length    > 100) return json({ error: "name must be ≤ 100 chars." }, 400);
  if (title.trim().length   > 150) return json({ error: "title must be ≤ 150 chars." }, 400);
  if (summary.trim().length > 500) return json({ error: "summary must be ≤ 500 chars." }, 400);
  if (hasUrl && url.trim().length > 500) return json({ error: "url must be ≤ 500 chars." }, 400);

  // ── Reject unexpected fields ───────────────────────────────────────────────
  const allowed = new Set(["name","title","url","summary","fileContent","fileName","encoding"]);
  const extra = Object.keys(body).filter(k => !allowed.has(k));
  if (extra.length) return json({ error: `Unexpected fields: ${extra.join(", ")}.` }, 400);

  // ── Build ID and project name ──────────────────────────────────────────────
  const id = crypto.randomUUID();
  const shortId = id.split("-")[0]; // 8 hex chars
  const vercelProject = `norton-proto-${shortId}`;

  // ── Deploy file to Vercel (if no URL provided) ─────────────────────────────
  let resolvedUrl = hasUrl ? url.trim() : null;
  let sourceType  = hasUrl ? "url" : "file";

  if (hasFile && !hasUrl) {
    const ext = fileName.trim().split(".").pop().toLowerCase();
    let vercelFiles;

    try {
      if (ext === "zip") {
        const rawFiles = await parseZip(fileContent); // fileContent is base64
        if (rawFiles.length === 0) {
          return json({ error: "ZIP file appears to be empty or unreadable." }, 400);
        }
        vercelFiles = filesToVercelPayload(rawFiles);
      } else {
        // Single HTML or JS file — always serve at root as index.html
        const ext = fileName.trim().split(".").pop().toLowerCase();
        vercelFiles = [{
          file: ext === "js" ? "index.js" : "index.html",
          data: fileContent,
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

  // ── Build prototype object ─────────────────────────────────────────────────
  let prototype = {
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
You are evaluating a product prototype on behalf of "Laura, the Outsourcer" —
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

WHAT SHE LOVES: Default-on protection, household framing, calm assured tone, zero config.
WHAT SHE REJECTS: Dashboards of toggles, jargon, gamification, dark patterns, added admin.

SCORING GUIDE (Laura Score 0–100):
- 90–100 LOVES IT: Solves a top JTBD, feels effortless, removes mental load.
- 75–89 LIKES IT: Clearly useful, aligned with 4Ps, low friction.
- 55–74 MEH: Mixed signals — solves something real but asks too much.
- 35–54 SKEPTICAL: Violates core principles (too much control, jargon, unclear value).
- 0–34 REJECTS IT: Fundamentally misreads Laura, adds to mental load.
`;

function extractTextFromHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&#?[a-z0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function scoreLaura(prototype, fileContent, env) {
  if (!env.ANTHROPIC_API_KEY) return null;

  let extractedText = '';

  // 1. Get content to analyse
  if (fileContent && typeof fileContent === 'string') {
    extractedText = extractTextFromHtml(fileContent);
  } else if (prototype.url && prototype.sourceType === 'url') {
    try {
      const res = await fetch(prototype.url, {
        headers: { 'User-Agent': 'NortonSprint-LauraBot/1.0' },
        signal: AbortSignal.timeout(6000),
      });
      if (res.ok) {
        const html = await res.text();
        extractedText = extractTextFromHtml(html);
      }
    } catch {
      return null; // URL unreachable — skip scoring silently
    }
  }

  if (!extractedText || extractedText.trim().length < 30) return null;

  // 2. Build concept string — title + extracted text, capped at 1800 chars
  const concept = `Prototype title: "${prototype.title}"\nSubmitted by: ${prototype.name}\nSummary: ${prototype.summary}\n\nPrototype content (extracted text):\n${extractedText.slice(0, 1500)}`;

  // 3. Call Anthropic
  const prompt = `${LAURA_CONTEXT_SCORE}

---
PROTOTYPE TO EVALUATE:
${concept}

---
Respond with ONLY a valid JSON object — no prose, no markdown fences:
{
  "score": <integer 0-100>,
  "verdict": "<LOVES IT | LIKES IT | MEH | SKEPTICAL | REJECTS IT>",
  "recommendation": "<1-2 sentences — the single most important change to make this land better for Laura, or why it already works>"
}

The verdict MUST match the score band:
90-100 → LOVES IT | 75-89 → LIKES IT | 55-74 → MEH | 35-54 → SKEPTICAL | 0-34 → REJECTS IT`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 300,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const raw = (data?.content?.[0]?.text ?? '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const result = JSON.parse(raw);
    return {
      lauraScore:          result.score          ?? null,
      lauraVerdict:        result.verdict         ?? null,
      lauraRecommendation: result.recommendation  ?? null,
    };
  } catch {
    return null; // Scoring failure is always non-fatal
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
