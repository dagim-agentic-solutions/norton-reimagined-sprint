# Concept Card Feed — Delete Button Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow facilitators to delete submitted concept cards from the feed (and KV store) instantly, with realtime sync across all clients.

**Architecture:** Extend the existing `/api/concept-cards` route with a `DELETE` handler (CORS-enabled), then add a delete control + client logic to the Concept 1-Pager so cards disappear immediately and WebSocket broadcasts keep other tabs in sync.

**Tech Stack:** Cloudflare Pages Functions (Node/Workers runtime), vanilla HTML/CSS/JS, Cloudflare Workers WebSocket hub.

---

### Task 1: Add DELETE support to `/api/concept-cards`

**Files:**
- Modify: `functions/api/concept-cards.js`

- [ ] Update `CORS_HEADERS` so `Access-Control-Allow-Methods` includes `DELETE`.
- [ ] Export a new `onRequestDelete` handler:
  - Parse `slug` (query param, default `norton`) and `id` (required) from the request URL.
  - Load the current list from KV via `getCards`, filter out the matching card, and `saveCards` back.
  - Respond with `{ ok: true, id }` even if the card was already missing.
  - After saving, POST a broadcast to `env.CONCEPT_CARD_BROADCAST_URL` with `{ type: 'concept-card:deleted', payload: { id, slug } }` (same headers as POST) so other clients can drop the card without polling.
- [ ] Keep the existing GET/POST code unchanged.

### Task 2: Add delete control to the UI

**Files:**
- Modify: `concept-card.html` (CSS + template markup)

- [ ] Add CSS for a subtle delete button (e.g., `.delete-btn { background: transparent; border: none; color: #dc2626; font-size: 12px; cursor: pointer; }`) and a hover/focus style so it aligns nicely with the timestamp.
- [ ] Update `buildSubmittedCard(card)` so the `<header>` contains the timestamp + a `button type="button" class="delete-btn" data-action="delete" data-id="${card.id}`">Delete</button>`.

### Task 3: Wire up delete behavior on the client

**Files:**
- Modify: `concept-card.html` (JS block)

- [ ] Introduce a `const deletingIds = new Set();` near the other state variables to prevent duplicate deletes.
- [ ] Extend `handleSubmittedClick` to handle `data-action="delete"`:
  - Optimistically remove the card from `submittedCards`/DOM (`removeCardLocally(id)` helper) and add the id to `deletingIds`.
  - `fetch(`${API_URL}?slug=${SLUG}&id=${id}`, { method: 'DELETE' })`.
  - On success, leave the card removed; on failure, reinsert the card and show `showStatus('Unable to delete …', 'error')`.
- [ ] Add helpers:
  - `function removeCardLocally(id)` — splice from `submittedCards`, re-render or remove the element.
  - `function restoreCard(card)` if needed on failure.
- [ ] Update the WebSocket `message` handler to react to `concept-card:deleted` events: call `removeCardLocally(evt.payload.id)` unless that id is in `deletingIds` (then just delete from the Set).

### Task 4: Manual QA

**Commands:**
- Run the dev server: `npx wrangler pages dev . --local --port 8788`
- [ ] In the browser, load http://localhost:8788/concept-card.html, submit a throwaway card, and delete it via the new button — ensure it disappears immediately and doesn’t reappear after refresh.
- [ ] Open a second tab (or curl the API) to confirm the WebSocket broadcast removes the card elsewhere (or fall back to the 15s polling).
- [ ] Stop the dev server (Ctrl+C).

### Task 5: Final checks + PR

**Commands:**
- [ ] `git status` (expect changes to `functions/api/concept-cards.js`, `concept-card.html`, spec/plan docs).
- [ ] Stage & commit: `git commit -am "feat: allow deleting submitted concept cards"`.
- [ ] Push branch, open PR with summary + test plan, merge to `main`, and run `npx wrangler pages deploy . --project-name norton-reimagined-sprint --branch main` to ship the API + UI change.
