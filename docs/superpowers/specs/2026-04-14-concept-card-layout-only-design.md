# Concept Card Feed — Single Column Layout (2026-04-14)

## Background
- On the Concept 1-Pager page, submitted cards currently appear in a responsive grid that becomes multi-column on desktop.
- Dagim wants the feed to remain a single column at all breakpoints and for each card to stretch across the full horizontal space of the container.

## Requirements
1. Submitted cards stack vertically (one card per row) with consistent spacing between entries.
2. Cards must span the full width of the feed container (no leftover gutters) while retaining existing internal padding and styles.
3. Change must work on both preview and production domains without affecting other tool layouts.

## Design
- Update the submitted-cards wrapper (`#submittedCards` / `.submitted-grid`) to use a single-column layout:
  - `display: flex; flex-direction: column; gap: 24px;` (or equivalent single-column grid definition).
  - Ensure the container itself remains full width and responsive (100% of the parent).
- Force each `.submitted-card` to stretch across the container:
  - `width: 100%; max-width: none;` while preserving the existing internal padding/shadows.
  - Maintain current background/border styles so cards still look like the Norton-branded panel.
- Expand the nested `.concept-card` preview inside each submitted tile so it fills the tile width (`max-width: none; width: 100%; margin: 0;`) to avoid leftover black space.
- Keep the rest of the Concept 1-Pager layout intact (form, preview, hero) — only the submitted-cards wrapper/card widths change.

## Testing Notes
- Verify on desktop + mobile preview builds that cards are stacked vertically with equal spacing and no horizontal clipping.
- Confirm no regressions to the WebSocket feed, card content, or downloads.
