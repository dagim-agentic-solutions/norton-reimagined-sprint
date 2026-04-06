# Norton Reimagined Sprint — Frontend Files

This is the frontend microsite for the Norton Reimagined design sprint. It
deploys on top of the existing `norton-reimagined-sprint` Cloudflare Pages
project (which already hosts the `/api/pressure-test` and `/api/prototypes`
Pages Functions).

## What's in this bundle

```
/
├── index.html              Home page (sprint overview, objectives, agenda)
├── laura.html              Persona cheat sheet + Claude-powered pressure tester
├── where-is-norton.html    Current state: products, brand health, gaps
├── prototypes.html         Shared prototype submission log
├── resources.html          Reference material (placeholders for now)
├── styles.css              Shared stylesheet for index/where/prototypes/resources
└── sprint/                 Screenshots from the sprint planning deck
    ├── day1.png
    ├── day2.png
    ├── day3.png
    ├── objectives.png
    ├── business-objectives.png
    ├── team-roles.png
    ├── prototyping-approach.png
    └── ground-rules.png
```

## Backend dependencies

Two pages call backend endpoints that must already be deployed in the same
Cloudflare Pages project:

- **`laura.html`** calls `POST /api/pressure-test` with `{ concept }` and
  expects a JSON verdict back. The Laura persona context lives in that
  Pages Function, not in the browser.

- **`prototypes.html`** calls `GET /api/prototypes` (list) and `POST
  /api/prototypes` (submit). Expects a KV-backed Pages Function at
  `functions/api/prototypes.js` with a `PROTOTYPES` KV namespace binding.

If either endpoint is missing, the affected page will show a graceful
error state — the rest of the microsite still works.

## Deployment steps

1. Drop all six files into the project root, replacing any placeholder
   `index.html` that was there before.
2. Create the `sprint/` subdirectory in the project root and place the
   8 PNG files inside it with the exact lowercase filenames above.
3. Do NOT modify anything in `functions/`, `wrangler.toml`, or any
   existing backend code.
4. Deploy:
   ```
   wrangler pages deploy . --project-name norton-reimagined-sprint
   ```
5. Visit `https://norton-reimagined-sprint.pages.dev/` — the home page
   should load, and the nav bar should link to every sub-page.

## Verification checklist

After deploy, confirm each of these loads correctly:

- [ ] `https://norton-reimagined-sprint.pages.dev/`
- [ ] `https://norton-reimagined-sprint.pages.dev/laura.html`
- [ ] `https://norton-reimagined-sprint.pages.dev/where-is-norton.html`
- [ ] `https://norton-reimagined-sprint.pages.dev/prototypes.html`
- [ ] `https://norton-reimagined-sprint.pages.dev/resources.html`
- [ ] Nav bar links work between all pages
- [ ] Sprint screenshots render on the home page
- [ ] Laura pressure-tester returns a verdict when given a concept
- [ ] Prototype submission form persists a test entry across page reloads

## File details

**All HTML files are self-contained** — they include their own inline CSS
where needed, reference the shared `styles.css`, and load Inter Tight from
Google Fonts. No JS frameworks, no npm dependencies, no build step.

**All links are relative** (`laura.html`, not `/laura.html` or full URLs),
so the site works identically at any path prefix or custom domain you
point at it later.

**The design language** is locked to Norton Reimagined: Inter Tight font,
`#242424` ink, `#FFE800` yellow accent, `#F8F8F7` paper, 8px card radius.
