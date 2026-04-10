import { crawlPrototype, buildVisionContent } from '../../../_lib/visualCrawler.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS }
  });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

const CACHE_TTL = 60 * 60 * 12; // 12 hours
const MAX_DESCRIBE_SCREENS = 5;

export async function onRequestGet({ params, env }) {
  const kv = env.PROTOTYPES_KV;
  if (!kv) return json({ error: 'Datastore unavailable.' }, 503);

  const id = params.id;
  if (!id) return json({ error: 'Missing prototype ID.' }, 400);

  const cacheKey = `clone:${id}`;
  try {
    const cached = await kv.get(cacheKey);
    if (cached) {
      const parsed = JSON.parse(cached);
      return json({ ok: true, ...parsed, cached: true });
    }
  } catch {}

  const protoRaw = await kv.get(`proto:${id}`);
  if (!protoRaw) return json({ error: 'Prototype not found.' }, 404);
  const proto = JSON.parse(protoRaw);

  let fileContent = proto.fileContent || '';
  if (!fileContent && proto.fileStoredSeparately) {
    try { fileContent = await kv.get(`file:${id}`) || ''; } catch {}
  }

  const protoUrl = proto.url || proto.resolvedUrl || '';
  let crawlResult = { screens: [], textContent: '' };
  if (protoUrl && !protoUrl.startsWith('/api/')) {
    try {
      crawlResult = await crawlPrototype(protoUrl, { fileContent });
    } catch (err) {
      console.error('[clone] crawl error', err);
    }
  } else if (fileContent) {
    crawlResult.textContent = fileContent;
  }

  const screenSummaries = await describeScreens(crawlResult.screens, env);
  const textFallback = extractDeepText(crawlResult.textContent || fileContent || '');

  const prompt = buildClonePrompt(proto, screenSummaries, textFallback);
  const payload = {
    prompt,
    generatedAt: new Date().toISOString(),
    screensAnalyzed: screenSummaries.length,
  };

  await kv.put(cacheKey, JSON.stringify(payload), { expirationTtl: CACHE_TTL }).catch(() => {});

  return json({ ok: true, ...payload, cached: false });
}

function extractDeepText(html) {
  if (!html) return '';
  const extras = [];
  for (const m of html.matchAll(/(?:aria-label|alt|placeholder|title)="([^"]{2,160})"/gi)) {
    extras.push(m[1]);
  }
  const withHints = html
    .replace(/<(h[1-6])[^>]*>([\s\S]*?)<\/\1>/gi, (_, tag, inner) => `[${tag.toUpperCase()}] ${inner} `)
    .replace(/<button[^>]*>([\s\S]*?)<\/button>/gi, (_, inner) => `[BTN] ${inner} `)
    .replace(/<a[^>]*>([\s\S]*?)<\/a>/gi, (_, inner) => `[LINK] ${inner} `)
    .replace(/<(label|span|p|li|td|th)[^>]*>([\s\S]*?)<\/\1>/gi, (_, _t, inner) => inner + ' ');
  const cleaned = withHints
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
  return (extras.join(' | ') + ' ' + cleaned).slice(0, 12000);
}

async function describeScreens(screens, env) {
  const usable = screens.filter(s => s.base64).slice(0, MAX_DESCRIBE_SCREENS);
  if (!usable.length || !env.ANTHROPIC_API_KEY) {
    return screens.slice(0, MAX_DESCRIBE_SCREENS).map((s, idx) => ({
      label: s.label || `Screen ${idx + 1}`,
      url: s.url,
      layout: 'Screenshot available but no automated description.',
      sections: [],
      notableCopy: [],
      visualNotes: ''
    }));
  }

  const instruction = `You will be shown ${usable.length} screenshots from a product prototype. For EACH screenshot, output JSON describing:\n{\n  "label": "short human-readable name (use provided label if present)",\n  "url": "source URL",\n  "layout": "2-3 sentences summarising layout and structure",\n  "sections": ["key sections or modules"],\n  "notableCopy": ["important headlines or CTA text exactly as seen"],\n  "visualNotes": "color palette, imagery, notable UI patterns"\n}\nReturn ONLY JSON in the format: { "screens": [ ... ] }.`;

  const content = buildVisionContent(usable, instruction);
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 900,
        messages: [{ role: 'user', content }]
      })
    });
    if (!res.ok) throw new Error(`Anthropic ${res.status}`);
    const data = await res.json();
    const text = (data?.content?.[0]?.text || '').trim();
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed?.screens)) {
      return parsed.screens.map((s, idx) => ({
        label: s.label || usable[idx]?.label || `Screen ${idx + 1}`,
        url: s.url || usable[idx]?.url,
        layout: truncate(s.layout, 300),
        sections: Array.isArray(s.sections) ? s.sections.slice(0, 6) : [],
        notableCopy: Array.isArray(s.notableCopy) ? s.notableCopy.slice(0, 6) : [],
        visualNotes: truncate(s.visualNotes, 200)
      }));
    }
  } catch (err) {
    console.error('[clone] describeScreens error', err);
  }
  return usable.map((s, idx) => ({
    label: s.label || `Screen ${idx + 1}`,
    url: s.url,
    layout: 'Automated description unavailable.',
    sections: [],
    notableCopy: [],
    visualNotes: ''
  }));
}

function truncate(str, len) {
  if (!str) return '';
  if (str.length <= len) return str;
  return str.slice(0, len - 3) + '...';
}

const NORTON_DESIGN_SYSTEM = `## Norton Reimagined — Design System (apply exactly)

### Typography
- Font: **Inter Tight** only (import via Google Fonts)
- Weights: 400, 500, 600, 700, 800
- Hero headlines: weight 800, tracking −0.03em
- Body: weight 400–500, line-height 1.45–1.5
- Labels: weight 700, letter-spacing 0.10–0.14em, UPPERCASE

### Color Palette (CSS variables)
\`\`\`css
--ink:       #242424;   /* primary text, dark surfaces */
--yellow:    #FFE800;   /* accent, CTA, highlights */
--paper:     #F8F8F7;   /* page background */
--card:      #FFFFFF;   /* elevated surfaces */
--line:      #E6E6E4;   /* borders, dividers */
--ink-soft:  #5a5a5a;   /* secondary text */
--ink-softer:#8a8a8a;   /* tertiary */
\`\`\`

### Border Radius
- 999px → pill buttons, tags, badges
- 8px   → cards, inputs, standard containers
- 6px   → small elements, code blocks

### Component Patterns
- Nav: dark (#242424) background, sticky/fixed
- Primary CTA: yellow pill, ink text, weight 700–800
- Eyebrow labels: ink bg, yellow text, pill, 11px uppercase
- Cards: white bg, 1px #E6E6E4 border, 8px radius
- Padding: 26–28px card internal, 56px desktop page

### QA Checklist
- All screens scrollable (no hidden content)
- No text touching edges
- Hover/tap states visible
- WCAG AA contrast
- Realistic placeholder copy (no lorem ipsum)
`;

const LAURA_PERSONA_BRIEF = `## Laura, the Outsourcer — Target Persona

Laura is the guardian of her household's digital life — but she doesn't want the job. She wants a trusted expert to quietly handle it in the background, the way insurance or utilities do.

**Who she is:** 35–55, working parent, 5–10 devices across family, burnt out being the family IT person.

**Her 4 Jobs To Be Done:**
1. Protect the whole household with as little admin as possible
2. Block threats before anyone clicks
3. Keep her kids safe online with simple controls
4. Tell her what to do in plain language when something goes wrong

**Design for her:** Outcomes not mechanics. Calm, assured tone. Single clear CTAs.
She rejects dashboards of toggles, jargon, gamification, anything that adds mental load.`;

const CLONE_INSTRUCTIONS = `## Instructions for Claude
1. Reproduce the prototype exactly — section by section, line by line, including interactions and responsive behaviours.
2. Use ONLY Inter Tight + the Norton palette.
3. Once reproduction is complete, stop and ask: *"I've reproduced this prototype faithfully. What would you like to add or change?"*
4. Implement my follow-up instructions on top of the reproduction.`;

function buildClonePrompt(proto, screenSummaries, textFallback) {
  const safeTitle = proto.title || 'Prototype';
  const sections = [];
  sections.push(`# Clone + Extend: "${safeTitle}"`);
  sections.push(`> Sprint: Norton Reimagined Design Sprint — Tiger Team\n> Original author: ${proto.name || 'Anonymous'}\n> Source URL: ${proto.url || proto.resolvedUrl || '(upload)'}\n> Summary: ${proto.summary || '(none provided)'}`);

  if (screenSummaries.length) {
    const screenText = screenSummaries.map((s, idx) => {
      const parts = [
        `### Screen ${idx + 1}: ${s.label || `Screen ${idx + 1}`}`,
        s.url ? `- URL: ${s.url}` : '',
        s.layout ? `- Layout: ${s.layout}` : '',
        s.sections?.length ? `- Sections:\n  ${s.sections.map(sec => `• ${sec}`).join('\n  ')}` : '',
        s.notableCopy?.length ? `- Notable copy: ${s.notableCopy.map(c => `"${c}"`).join(', ')}` : '',
        s.visualNotes ? `- Visual notes: ${s.visualNotes}` : ''
      ].filter(Boolean).join('\n');
      return parts;
    }).join('\n\n');
    sections.push(`## Auto-captured screen atlas (${screenSummaries.length})\n${screenText}`);
  }

  if (textFallback) {
    sections.push(`## Extracted text snippets\n${textFallback}`);
  }

  sections.push(NORTON_DESIGN_SYSTEM.trim());
  sections.push(LAURA_PERSONA_BRIEF.trim());
  sections.push(CLONE_INSTRUCTIONS.trim());

  return sections.join('\n\n').trim();
}
