# Concept Card Delete Button & Single-Column Layout — Design (2026-04-14)

## Background
- The Concept 1-Pager page now shows a live feed of submitted concept cards (backed by `PROTOTYPES_KV`).
- Participants need to be able to remove cards that are no longer relevant, and the feed should present cards as a single column that spans the full container width.
- Deletes must be immediate (no confirmation) and affect all viewers (i.e., delete from KV, not just hide locally).

## Requirements
1. **Delete control on each submitted card**
   - Visible inline (e.g., a small text button or icon in the card header) with no confirmation prompt.
   - Clicking delete removes the card from the shared KV store so the feed updates for everyone.
   - Failure states should be surfaced (status text) and the card restored locally if the request fails.
2. **Single-column, full-width feed**
   - Submitted cards stack vertically in one column and span the full horizontal space of the container (edge-to-edge), with consistent vertical spacing between cards.

## Backend / API Design
- Extend `functions/api/concept-cards.js` with a `DELETE` handler:
  - Accept `slug` (query param) and `id`.
  - Load the KV list (`concept-cards:${slug}`), filter out the matching `id`, and `put` the trimmed array back (preserving the 200-card cap logic).
  - Respond with `{ ok: true, id }` so clients can reconcile state if needed.
  - Reuse the existing CORS headers and allow anonymous DELETE (same guard level as GET/POST).
  - After persistence, POST the same payload to the concept-card hub worker (new event `concept-card:deleted`) so connected clients can remove the card in realtime.

## Frontend / UI Design
- **Delete control**
  - Add a small button (text link or trash icon) inside each submitted card header, right-aligned next to the timestamp.
  - On click:
    1. Optimistically remove the card from `submittedCards` and the DOM (so UI feels instant).
    2. `fetch(`${API_URL}?slug=${SLUG}&id=${card.id}`, { method: 'DELETE' })`.
    3. If the request fails, show a red status message (e.g., “Couldn’t delete, try again”) and re-insert the card locally.
  - Continue listening to the WS feed: when a `concept-card:deleted` event arrives, remove that card if it still exists locally. If the socket is down, the 15s polling fallback already in place will reconcile.
- **Layout change**
  - Update `.submitted-grid` to a single-column stack (`display:flex; flex-direction:column; gap:24px;`).
  - Ensure `.submitted-card` spans `width:100%` of the container with appropriate padding so cards feel full-bleed on desktop while remaining responsive on smaller screens.
  - No other stylistic changes to card internals.

## Error Handling
- Immediate delete (no confirmation) per requirement.
- If DELETE fails, show inline error text (reuse `formStatus`) and restore the card.
- If the card was already removed elsewhere, treat the DELETE response as success (no-op locally).

## Testing Notes
- Verify delete flow on production domain + preview domain (CORS already enabled for GET/POST/DELETE).
- Confirm WebSocket broadcast removes cards across multiple tabs.
- Confirm single-column layout on desktop + mobile (full-width cards, consistent spacing).
