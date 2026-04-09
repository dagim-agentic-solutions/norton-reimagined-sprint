/**
 * visualCrawler.js
 *
 * Crawls a prototype URL, discovers all internal screens/routes,
 * takes screenshots of each via Microlink, and returns base64 images
 * with page metadata for use in vision-based LLM analysis.
 *
 * Max screens: 8 (CPU/memory budget)
 * Screenshot size: 1200x900
 */

const MAX_SCREENS   = 8;
const SCREENSHOT_W  = 1200;
const SCREENSHOT_H  = 900;
const FETCH_TIMEOUT = 12000;
const SS_TIMEOUT    = 15000;

// ── Take a single screenshot via Microlink ──────────────────────────────────
async function screenshot(url) {
  try {
    const api = `https://api.microlink.io?url=${encodeURIComponent(url)}&screenshot=true&meta=false&embed=screenshot.url&viewport.width=${SCREENSHOT_W}&viewport.height=${SCREENSHOT_H}&waitFor=1500`;
    const metaRes = await fetch(api, { signal: AbortSignal.timeout(SS_TIMEOUT) });
    if (!metaRes.ok) return null;
    const meta = await metaRes.json();
    const ssUrl = meta?.data?.screenshot?.url;
    if (!ssUrl) return null;
    const imgRes = await fetch(ssUrl, { signal: AbortSignal.timeout(10000) });
    if (!imgRes.ok) return null;
    const buf = await imgRes.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  } catch {
    return null;
  }
}

// ── Discover internal links from HTML ───────────────────────────────────────
function discoverLinks(html, baseUrl) {
  const links = new Set();
  try {
    const base = new URL(baseUrl);
    const origin = base.origin;
    const basePath = base.pathname.replace(/[^/]*$/, ''); // directory portion

    // href links
    for (const m of html.matchAll(/href=["']([^"'#?][^"']*?)["']/gi)) {
      const raw = m[1].trim();
      if (!raw || raw.startsWith('mailto:') || raw.startsWith('javascript:')) continue;
      try {
        const resolved = new URL(raw, baseUrl);
        if (resolved.origin === origin) links.add(resolved.href);
      } catch {}
    }

    // data-href, data-url, data-src (common in interactive prototypes)
    for (const m of html.matchAll(/data-(?:href|url|src|screen|page|route)=["']([^"']+)["']/gi)) {
      const raw = m[1].trim();
      if (!raw) continue;
      try {
        const resolved = new URL(raw, baseUrl);
        if (resolved.origin === origin) links.add(resolved.href);
      } catch {}
    }

    // src attributes pointing to .html files on same origin
    for (const m of html.matchAll(/src=["']([^"']+\.html[^"']*)["']/gi)) {
      try {
        const resolved = new URL(m[1], baseUrl);
        if (resolved.origin === origin) links.add(resolved.href);
      } catch {}
    }
  } catch {}

  // Remove the base URL itself
  links.delete(baseUrl);
  return [...links];
}

// ── Main crawl function ─────────────────────────────────────────────────────
/**
 * @param {string} protoUrl  - The prototype's public URL
 * @param {object} opts      - { fileContent?: string } for uploaded files
 * @returns {Promise<{ screens: Array<{ url: string, label: string, base64: string|null }>, textContent: string }>}
 */
export async function crawlPrototype(protoUrl, opts = {}) {
  const screens = [];
  const visited = new Set();

  // ── Queue starts with main URL ─────────────────────────────────────────
  const queue = [{ url: protoUrl, label: 'Main Screen' }];

  // If we have file content, extract links from it immediately
  let rootHtml = opts.fileContent || null;
  if (!rootHtml && protoUrl && !protoUrl.startsWith('/api/')) {
    try {
      const res = await fetch(protoUrl, {
        headers: { 'User-Agent': 'NortonSprint-CrawlerBot/1.0' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT),
      });
      if (res.ok) rootHtml = await res.text();
    } catch {}
  }

  if (rootHtml) {
    const links = discoverLinks(rootHtml, protoUrl);
    // Label discovered links by their filename
    for (const link of links) {
      try {
        const u = new URL(link);
        const name = u.pathname.split('/').filter(Boolean).pop() || u.pathname;
        queue.push({ url: link, label: name });
      } catch {}
    }
  }

  // ── Screenshot each queued URL ─────────────────────────────────────────
  for (const item of queue) {
    if (screens.length >= MAX_SCREENS) break;
    if (visited.has(item.url)) continue;
    visited.add(item.url);

    const b64 = await screenshot(item.url);
    screens.push({ url: item.url, label: item.label, base64: b64 });
  }

  return { screens, textContent: rootHtml || '' };
}

// ── Build Anthropic vision message content from screens ──────────────────────
/**
 * Returns an array of Anthropic message content blocks:
 * [{ type: 'text', text: '...' }, { type: 'image', source: { type: 'base64', ... } }, ...]
 */
export function buildVisionContent(screens, analysisInstruction) {
  const blocks = [];

  if (analysisInstruction) {
    blocks.push({ type: 'text', text: analysisInstruction });
  }

  for (const screen of screens) {
    blocks.push({
      type: 'text',
      text: `\n--- Screen: ${screen.label} (${screen.url}) ---`,
    });

    if (screen.base64) {
      blocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: screen.mimeType || 'image/png',
          data: screen.base64,
        },
      });
    } else {
      blocks.push({
        type: 'text',
        text: '[Screenshot unavailable for this screen]',
      });
    }
  }

  return blocks;
}
