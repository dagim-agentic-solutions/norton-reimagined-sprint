# Concept Card Scorecards & Leaderboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-concept scorecards (three 1–5 sliders) to the Concept 1-Pager, plus global summarize/reset controls that compute a leaderboard in the browser.

**Architecture:** Pure front-end change — new HTML/CSS blocks and JavaScript state management backed by `sessionStorage`. No backend writes are required.

**Tech Stack:** HTML/CSS/vanilla JS on `concept-card.html`.

---

### Task 1: Add layout hooks (HTML + CSS)

**Files:**
- Modify: `concept-card.html` (inline `<style>` + submitted card template)

- [ ] In the `<style>` block, add classes for the scorecard panel (`.scorecard`, `.score-row`, `.score-label`, `.score-value`, `.score-status`) and the leaderboard banner (`.scorebar`, `.leaderboard`, `.leaderboard-item`, `.leaderboard-item.winner`).
- [ ] Add the global control bar + empty leaderboard placeholder right above the submitted cards container:
  ```html
  <div class="scorebar">
    <button id="summarizeScores" class="primary-btn">Summarize scores</button>
    <button id="resetScores" class="ghost-btn">Reset votes</button>
  </div>
  <div id="leaderboard"></div>
  ```
- [ ] In `buildSubmittedCard`, insert a `.scorecard` block between the preview and download buttons containing three slider rows (with labels + value spans) and a status line (“Not scored yet”). Give each slider unique IDs based on the concept ID (e.g., `score-${card.id}-wanted`).

### Task 2: Wire slider state + sessionStorage

**Files:**
- Modify: `concept-card.html` (JS block)

- [ ] Introduce an in-memory map `const conceptScores = new Map();` and bootstrapping logic in `renderSubmitted()` that:
  - Reads any existing `sessionStorage.getItem('conceptScores')` payload and hydrates the map.
  - When rendering sliders, sets their `value` attributes from the stored scores if present.
- [ ] Add event listeners for the sliders (delegate off `submittedContainer`) that:
  - Update the corresponding entry in `conceptScores` with the latest 1–5 value.
  - Write the serialized map back to `sessionStorage`.
  - Update the per-card status text (“Saved locally” once all three sliders have values).
- [ ] Provide helper functions `loadScoresFromStorage()` and `saveScoresToStorage()` to keep the logic tidy.

### Task 3: Summarize + reset logic

**Files:**
- Modify: `concept-card.html` (JS block)

- [ ] Implement `summarizeScores()` that walks `submittedCards`, pulls each concept’s `conceptScores` entry (if complete), computes the `(wanted + understood + solves) / 3` average, sorts descending, and renders HTML into `#leaderboard`. Highlight the top row with the `.winner` class and scroll it into view. If no scores exist, show an inline warning instead.
- [ ] Hook the global “Summarize scores” button to this function and hide the leaderboard whenever any slider changes (forcing a re-summarize after adjustments).
- [ ] Implement `resetVotes()` that clears `conceptScores`, removes the storage entry, resets all sliders to 3, resets the status text, and clears the leaderboard. Wire it to the “Reset votes” button.
- [ ] Add a lightweight toast/notice mechanism (reuse `showStatus`) to announce “Votes cleared” and “No scores yet” events.

### Task 4: QA

**Commands:**
- [ ] `npx wrangler pages dev . --local --port 8788`
- [ ] In the browser, submit a dummy concept, adjust sliders, refresh (confirm values persist), hit Summarize (leaderboard renders), and Reset (everything clears). Verify no console errors.
- [ ] Stop the dev server (Ctrl+C).

### Task 5: Commit & ship

**Commands:**
- [ ] `git status` (expect changes to `concept-card.html` + new spec/plan files).
- [ ] `git commit -am "feat: add concept scorecards and leaderboard"` (include spec/plan via `git add`).
- [ ] `git push -u origin feature/<branch>` + open PR with summary/test plan, merge, and `npx wrangler pages deploy . --project-name norton-reimagined-sprint --branch main` to publish.
