# Idea Grouping Beta Page — Design Spec (2026-04-08)

## Overview
A new "Idea Grouping" beta experience inside the Norton Reimagined sprint microsite. Teams can submit ideas (title, description, two alignment prompts), then drag cards into four customizable groups. The board supports real-time collaboration via WebSockets, persists state in Cloudflare KV, and includes lock/unlock + password-protected deletions for facilitation control.

## Goals & Requirements
- Live at `/idea-grouping.html` with a nav entry under Sprint Tools.
- Capture idea submissions with four inputs: title, description, "How does this align to Norton’s vision?", "What problems does this solve for Laura?".
- Display four grouping sections with editable titles (default "Untitled group #").
- Support drag/drop of cards between columns; update persists immediately and propagates to every connected browser.
- Provide a password-protected lock toggle (`dagim`) that makes the board fully read-only.
- Provide password-protected delete buttons (`norton`) for each idea. Deletes are disabled while the board is locked.
- Persist entire board state server-side and restore on refresh.
- Broadcast changes to active viewers via WebSocket so ideas appear in real time.

## Data model & storage
- Store the board under key `idea-grouping::board` in Cloudflare KV.
- Column order is **fixed** (col-1 → col-4, left to right). Only the title is editable. Columns are always rendered in this fixed order; the spec does not support re-ordering.
- JSON structure:
  ```json
  {
    "version": 7,
    "locked": false,
    "lockTimestamp": null,
    "columns": [
      { "id": "col-1", "title": "Untitled group 1" },
      ... (4 total, order fixed)
    ],
    "ideas": [
      {
        "id": "uuid",
        "title": "…",
        "description": "…",
        "visionAlignment": "…",
        "lauraProblem": "…",
        "columnId": "col-1",
        "createdAt": 1712500000000
      }
    ]
  }
  ```
- Every mutation increments `version` and writes the whole blob back to KV. Simple optimistic retry: read current blob, if version changed between read/write, re-run mutation up to 3 times.

## REST API (`functions/api/idea-grouping.js`)
- `GET /api/idea-grouping` → returns board JSON (+ `lastModified`).
- `POST /api/idea-grouping/idea` → body `{ title, description, visionAlignment, lauraProblem }`. Reject if locked or any field empty. Respond with new card.
- `PATCH /api/idea-grouping/idea/:id` → update card’s `columnId` and optionally text (future). Reject if locked.
- `DELETE /api/idea-grouping/idea/:id` → body `{ password }`. Require `password === "norton"` and board unlocked. Removes card.
- `PATCH /api/idea-grouping/column/:id` → body `{ title }`. Reject if locked.
- `POST /api/idea-grouping/lock` → body `{ password }`; accept only `dagim`, set `locked=true`, `lockTimestamp=Date.now()`.
- `POST /api/idea-grouping/unlock` → same but sets `locked=false`.
- Every mutating route emits a broadcast event via the WebSocket worker (see below).

## Real-time worker
- A Cloudflare **Durable Object** (`IdeaGroupingHub`) is required to ensure all connected sockets are managed in a single instance, regardless of how many Worker instances CF spins up. The DO exposes two surfaces:
  1. `GET /ws/idea-grouping` — upgrades to WebSocket on the DO; sockets are stored in the DO's in-memory set for the lifetime of the object.
  2. `POST /broadcast` — accepts JSON event from Pages Functions; DO loops through its connected sockets and forwards the event.
- The DO is named `IDEA_GROUPING_HUB` and bound in `wrangler.toml`.
- Supported event types: `idea:created`, `idea:updated`, `idea:deleted`, `column:updated`, `board:lock`, `board:unlock`, `board:sync`.
- Clients subscribe on page load: fetch baseline state via REST, open socket, handle events to patch local store. If socket closes, retry with exponential backoff and fall back to polling GET every 15 seconds until the socket returns.

## Frontend UI
- **Layout:** Beta badge, brief copy, submission form on the left, lock status + buttons on the right.
- **Form:** Title (input), Description (textarea), Vision alignment (textarea), Laura problem (textarea). Submit button disabled while locked. After submit, form clears and shows confirmation.
- **Columns:** Four column containers rendered as a CSS grid on desktop; stack vertically on mobile. Each column header has an `<input>` to rename the group (blur or Enter to save). Show counts (e.g., “Group name · 3 ideas”).
- **Cards:** Display title, truncated description with “View details” toggle, both answers, timestamp. Delete icon opens modal/password prompt; action disabled when locked. Cards are draggable via HTML5 drag/drop; on mobile we provide a “Move” button that opens a popover to pick a target column.
- **Lock controls:** Shows current status (Locked/Unlocked) with timestamp and who performed the action (just the timestamp for now). Buttons require password input; display toast on success/failure.
- **Notifications:** Lightweight toast component for submission success/failure, drag errors, password errors.

## Security & password handling
- Passwords (`dagim`, `norton`) are hardcoded as constants server-side. Frontend sends plaintext to the API over HTTPS; server does a constant-time equality check (`timingSafeEqual` equivalent) against the stored constant. No hashing required — these are shared sprint passwords, not user credentials.
- While locked, API returns HTTP 423 for any mutation; frontend already disables UI but we rely on the API for enforcement.
- Delete endpoint re-validates both lock state and password even if the UI is tricked.

## Testing plan
1. **Unit tests** for the KV mutation helper (apply changes, handle concurrent version bumps).
2. **Manual QA**
   - Submit ideas, rename columns, drag between all four columns.
   - Attempt to submit/drag/delete while locked (should be blocked) and while unlocked (should succeed).
   - Delete with incorrect password (error) vs correct password (success + broadcast).
3. **Multi-client real-time test**: Open two browser tabs. Submit/drag/delete in tab A and verify tab B receives socket events within ~1s. Lock from tab A and confirm tab B flips to read-only instantly.

