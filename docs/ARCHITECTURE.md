# System Architecture

```mermaid
flowchart TD
    subgraph Client
        Browser["Sprint team browsers"]
    end

    subgraph CloudflarePages["Cloudflare Pages Project"]
        StaticSite["Static microsite\n(index, laura, prototypes, etc.)"]
        PagesFunctions["Pages Functions\n/api/* endpoints"]
    end

    subgraph DataPlane
        KV[("PROTOTYPES_KV\nCloudflare KV namespace")]
    end

    subgraph ExternalAPIs["External Services"]
        VercelAPI["Vercel Deploy API\n(one-off prototype hosting)"]
        AnthropicAPI["Anthropic Claude\n(Laura scoring / pressure test)"]
        GammaAPI["Gamma Deck API\n(Pitch deck generation)"]
        Microlink["Microlink Screenshot API\n(Prototype captures)"]
    end

    Browser -->|HTTPS| StaticSite
    StaticSite -->|XHR| PagesFunctions
    PagesFunctions -->|CRUD prototypes, votes, comments| KV
    PagesFunctions -->|Deploy uploaded ZIP/HTML| VercelAPI
    PagesFunctions -->|Score concepts & briefs| AnthropicAPI
    PagesFunctions -->|Generate decks| GammaAPI
    PagesFunctions -->|Fetch screenshots| Microlink

    note right of StaticSite
      index.html, laura.html, prototypes.html, etc.
      load Inter Tight + nav.js directly from
      Cloudflare Pages. admin.js injects the
      sprint admin key for privileged calls.
    end note

    note right of PagesFunctions
      Functions power prototype CRUD,
      pressure testing, pricing strategy,
      deck generation, and clone prompts.
      Admin key enforcement lives here.
    end note
```

- **Static UI**: Pure HTML/CSS/JS pages served from Cloudflare Pages (no client build step). `nav.js` + `admin.js` handle navigation and admin authentication.
- **Pages Functions**: Handle prototype submissions, rescores, comments, voting, pricing pressure tests, and Gamma deck requests.
- **State**: Prototype metadata, votes, and comments reside in the `PROTOTYPES_KV` namespace. Large uploads are written to KV as `file:*` blobs.
- **Integrations**:
  - **Vercel Deploy API** — hosts uploaded prototypes by creating temporary one-file projects.
  - **Anthropic Claude** — evaluates prototypes (Laura scoring) and runs the pricing pressure test prompt.
  - **Gamma** — produces shareable pitch decks for any prototype.
  - **Microlink** — captures screenshots of remote prototypes when rescoring.
- **Security**: `admin.js` persists the sprint admin key locally; Cloudflare Pages Functions verify it via `x-admin-key` headers before allowing mutations.
