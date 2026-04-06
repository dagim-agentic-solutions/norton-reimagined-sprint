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
        // Single HTML or JS file
        vercelFiles = [{
          file: fileName.trim(),
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

  // ── Persist prototype ──────────────────────────────────────────────────────
  const prototype = {
    id,
    name:        name.trim(),
    title:       title.trim(),
    url:         resolvedUrl,
    summary:     summary.trim(),
    submittedAt: new Date().toISOString(),
    sourceType,
    ...(hasFile && !hasUrl ? { fileName: fileName.trim(), vercelProject } : {}),
  };

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
  if (!deployData.url) throw new Error("Vercel did not return a deployment URL.");

  // 2. Disable deployment protection (Pro feature) so anyone with the link can view
  await fetch(`https://api.vercel.com/v9/projects/${encodeURIComponent(projectName)}`, {
    method: "PATCH",
    headers: authHeader,
    body: JSON.stringify({
      ssoProtection:        null,
      passwordProtection:   null,
      deploymentProtection: "none",
    }),
  }).catch(() => {}); // non-fatal — deployment still works if this fails

  return `https://${deployData.url}`;
}
