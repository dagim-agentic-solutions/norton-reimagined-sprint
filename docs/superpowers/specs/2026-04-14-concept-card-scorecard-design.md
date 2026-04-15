# Concept Card Scorecards & Leaderboard — Design (2026-04-14)

## Background
- Facilitators want to collect quick 1–5 ratings (Laura wanted it / understood it / solves a real problem) for each submitted concept without leaving the Concept 1-Pager.
- Scores should be session-scoped: each browser remembers its own votes, they remain private until the team summarizes, and a reset wipes both the leaderboard and all sliders.

## Requirements
1. **Per-card scoring UI**
   - Three labeled sliders (1–5) under each submitted concept card (“Laura wanted it”, “Laura understood it”, “Solves a real problem”).
   - Inline badge showing the current value; default to 3 until the user changes it.
   - Votes persist in `sessionStorage` so refreshes don’t erase them.
2. **Global controls**
   - A utility bar above the feed with two buttons: **Summarize scores** (primary) and **Reset votes** (outline).
   - Summarize computes each scored concept’s average (equal weighting across the three questions), sorts descending, and renders a leaderboard banner that everyone sees immediately.
   - Reset clears the leaderboard output and returns all sliders to the default state, wiping the backing `sessionStorage` entries.
3. **Per-card save button**
   - Sliders behave like drafts until the user clicks **Save score**, which locks the values (stored in sessionStorage with a `saved` flag) and flips the status to “Saved locally.”
   - Leaderboard calculations only include cards whose scores were explicitly saved.
4. **Winner highlight**
   - The leaderboard clearly calls out the top concept (e.g., accent color / badge) while still listing the other averages.
   - If fewer than two concepts have scores, still show the single entry but note that more votes are needed.

## UI Design
- **Scorecard panel:** lives below the download buttons. Layout:
  - Section heading (“Score this concept”) + subtle status (“Not scored yet”, “Unsaved changes”, “Saved locally”).
  - Three slider rows with labels, helper text (1 = weak, 5 = strong), value badge, plus a **Save score** button that commits the current values.
- **Leaderboard:** after Summarize, insert a card at the top of the submitted section showing a numbered list (`1. Concept Name — 4.3 avg`). Highlight the winning row (background tint + “Winning concept” tag).
- **Buttons:** Summarize triggers the leaderboard and scrolls into view; Reset clears everything and displays a transient confirmation toast.

## Data & Interaction
- Scores live exclusively in `sessionStorage` (`conceptScores:{conceptId}` → `{ wanted, understood, solves, saved }`). Slider changes update the draft values and mark `saved = false`.
- Clicking **Save score** flips `saved = true` (if all three sliders have values) so the leaderboard can count the concept.
- Summarize iterates over cards, filters to entries with `saved = true`, computes `avg = (wanted + understood + solves) / 3`, sorts descending, and renders the leaderboard.
- The leaderboard hides automatically when a slider changes post-summary; users must click Summarize again to refresh the ranking.
- Reset removes the `conceptScores:*` keys, clears the in-memory map, resets sliders to 3, hides the leaderboard, and emits a “Votes cleared” toast.
- If Summarize is invoked with zero saved concepts, display an inline warning (“Score at least one concept before summarizing”).

## Testing Notes
- Verify sliders persist across refresh (sessionStorage contains values and rehydrates UI).
- Summarize with multiple concepts produces the correct ordering + winner badge.
- Reset wipes sliders, leaderboard, and storage entries.
- Ensure no backend calls are fired (purely front-end state) and existing download buttons still work.
