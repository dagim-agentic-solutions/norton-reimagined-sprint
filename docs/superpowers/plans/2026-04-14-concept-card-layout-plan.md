# Concept Card Feed — Single Column Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Force the submitted concept card feed on `concept-card.html` to render as a single, full-width column across breakpoints.

**Architecture:** This is a pure CSS change inside `concept-card.html`: update the `.submitted-grid`, `.submitted-card`, and `.empty-state` rules inside the `<style>` block so the container uses a flex column layout, cards span 100% width, and the empty state still centers correctly.

**Tech Stack:** Static HTML/CSS (no build tooling), Cloudflare Pages preview via `wrangler` for local verification.

---

### Task 1: Update `.submitted-grid` to flex column

**Files:**
- Modify: `concept-card.html` (inline `<style>` block around `.submitted-grid` definition)

- [ ] Locate the `.submitted-grid` CSS block (currently `display:grid` with `grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 20px;`). Replace it with:
  ```css
  .submitted-grid {
    display: flex;
    flex-direction: column;
    gap: 24px;
    width: 100%;
  }
  ```
  (This removes the grid template and ensures the container itself occupies the full width.)
- [ ] Save the file.

### Task 2: Ensure cards + empty state span full width

**Files:**
- Modify: `concept-card.html` (same `<style>` block)

- [ ] In the `.submitted-card` rule, add `width: 100%;` and `max-width: none;` (right after the existing padding/background styles) so each card stretches across the container.
- [ ] Extend the `.submitted-card .card-preview-wrapper .concept-card` rule so the nested concept card preview goes full bleed inside the tile (set `max-width: none; width: 100%; margin: 0;`).
- [ ] Remove grid-specific styling from `.empty-state`. Replace the block with something like:
  ```css
  .empty-state {
    text-align: center;
    color: var(--ink-soft);
    padding: 24px 0;
  }
  ```
  (Deletes `grid-column: 1 / -1;` because flex layout no longer uses it; keeps the centered copy.)
- [ ] Save the file.

### Task 3: Manual QA in local preview

**Commands:**
- Run local preview so you can visually confirm the feed layout:
  ```bash
  cd /Users/og-agentic-solutions/Projects/norton-reimagined-sprint
  npx wrangler pages dev . --local --port 8788
  ```
- [ ] Once the dev server is up, open http://localhost:8788/concept-card.html in a browser. Scroll to “Submitted concept cards” and confirm:
  - Cards stack vertically as one column with ~24px gap.
  - Each card spans the full width (no leftover gutters on desktop).
  - Empty state still looks centered when no cards exist.
- [ ] Stop the dev server (Ctrl+C).

### Task 4: Final checks and commit

**Commands:**
- [ ] `git status` should show only `concept-card.html` modified plus the plan/spec files.
- [ ] Stage and commit the change:
  ```bash
  git add concept-card.html docs/superpowers/specs/2026-04-14-concept-card-layout-only-design.md docs/superpowers/plans/2026-04-14-concept-card-layout-plan.md
  git commit -m "feat: make concept card feed single column"
  ```
- [ ] (Optional) If desired, run `npx wrangler pages deploy . --branch main` after review/approval to push the layout fix.
