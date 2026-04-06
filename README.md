# norton-reimagined-sprint

> **Scope:** This project is exclusively for the **Norton Reimagined design sprint**.  
> It is **not** reusable infrastructure. Do not repurpose it for other clients or projects.

---

## What this is

A minimal static microsite + Cloudflare Pages Functions backend that powers the
**"Laura, the Outsourcer" concept pressure-tester** on the Norton Reimagined cheat sheet.

Stack: plain HTML + Cloudflare Pages Functions (no framework, no build step).

---

## Endpoints

### `POST /api/pressure-test`

Evaluates a product concept against the Laura persona using Claude.

**Request**
```json
{ "concept": "<your product concept — max 2000 characters>" }
```

**Response** (on success)
```json
{
  "verdict": "yes" | "no" | "maybe",
  "resonance_score": 1–10,
  "laura_reaction": "...",
  "why_it_works": "..." | null,
  "killer_concern": "..." | null,
  "suggested_tweak": "..." | null
}
```

**Errors** return `{ "error": "<message>" }` with an appropriate HTTP status code.

Rules enforced server-side:
- `concept` is required, non-empty, and ≤ 2000 characters
- No caller-supplied model, system prompt, or message list — this endpoint does exactly one thing

### `GET /api/health`

Returns `{ "status": "ok", "project": "norton-reimagined-sprint" }`.

---

## Setting the API key

This project calls the Anthropic API. Usage is billed to the personal Anthropic account
of the sprint lead — **do not share this key outside the sprint team**.

### Local development (Wrangler)

Create a `.dev.vars` file (already gitignored):
```
ANTHROPIC_API_KEY=sk-ant-...
```

Run locally:
```bash
npx wrangler pages dev . --compatibility-date=2024-01-01
```

### Production (Cloudflare Pages)

```bash
npx wrangler pages secret put ANTHROPIC_API_KEY --project-name norton-reimagined-sprint
```

Or set it in the Cloudflare dashboard:  
**Pages → norton-reimagined-sprint → Settings → Environment Variables → Add secret**

---

## Deploy

```bash
npx wrangler pages deploy . --project-name norton-reimagined-sprint --branch main
```

> Confirm `wrangler whoami` shows the **simplfinance.ai** Cloudflare account before deploying.

---

## CORS

Currently set to `"*"` with a TODO comment in `functions/api/pressure-test.js`.  
After the final Pages URL is confirmed, replace `ALLOWED_ORIGIN` with the exact origin
(e.g. `"https://norton-reimagined-sprint.pages.dev"`).

---

## What this is NOT

- Not a general-purpose Claude proxy
- Not shared infrastructure for other projects
- Not connected to BLOK Studio, other client work, or any other OpenClaw project
