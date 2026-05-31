# @minsky/site

Marketing site for Minsky — the cyberbrain substrate. Deployed on Railway (separate service); serves at https://minsky-site-production.up.railway.app. A custom marketing domain is pending the brand-name decision (mt#2046) — do not assume `minsky.dev`, which is owned by a third party (verified 2026-05-31).

## Stack

- **Astro 5** — component composition, static output, first-class SEO
- **Tailwind v4** — design tokens via `@theme inline`; brand palette in `src/styles/global.css`
- **React 19** (islands only) — used sparingly for motion components
- **Motion** (formerly Framer Motion) — ambient identity motion per `docs/brand-system.md` §3

Stack chosen 2026-05-20 per mt#1934 spec; absorbed into the monorepo from the prior separate `~/Projects/minsky-site` scaffold the same day.

## Brand

All brand tokens, voice rules, and anti-patterns live in:

- [`docs/brand-system.md`](../../docs/brand-system.md) — operational reference (tokens, palette, vocabulary)
- [`.claude/skills/minsky-brand/SKILL.md`](../../.claude/skills/minsky-brand/SKILL.md) — agent-consumable brand foundation
- [`.claude/skills/marketing-site-design/SKILL.md`](../../.claude/skills/marketing-site-design/SKILL.md) — marketing-surface layer
- [`.claude/skills/pz-voice/SKILL.md`](../../.claude/skills/pz-voice/SKILL.md) — principal's literary voice register

Surface-level rules in short form:

- **Idiom B** (product-screenshot dominant, restrained). Never Idiom A.
- **Cyberbrain / Section 9** cultural code. References atmospheric, never literal.
- **Magilumière tonal lock** — serious B2B operational professionalism.
- **Sentence case. Present tense. No exclamation.** No SaaS hyperbole.

## Local dev

```bash
cd services/site
bun install
bun run dev
```

Default port 4321 (override with `PORT`).

## Build & preview

```bash
bun run build
bun run preview
```

Static output lands in `services/site/dist/`.

## Talk decks

Slidev talk decks (repo-root `talks/<name>/`) are published here under
`public/talks/<name>/` and served at `/talks/<name>/` on the site.

**Why a committed snapshot.** The Railway deploy uses `rootDirectory: services/site`,
so the build cannot reach repo-root `talks/` to build the deck during `astro build`.
The built deck is therefore committed under `public/talks/<name>/` (Astro copies
`public/` verbatim into `dist/`). Regenerate after editing slides:

```bash
cd services/site
bun run build:talks   # rebuilds talks/when-the-agent-is-wrong into public/talks/...
```

Then commit the regenerated `public/talks/...` output.

**SPA deep links.** Slidev decks are client-routed SPAs; `/talks/<deck>/5` has no
file on disk. `src/server.ts` has an SPA fallback that serves the deck's
`index.html` (200) for any unmatched `/talks/<deck>/*` path, so deep links to a
specific slide work.

**Also on GitHub Pages.** `.github/workflows/deploy-talks.yml` builds the same
decks and deploys them to GitHub Pages (`https://edobry.github.io/minsky/<deck>/`)
automatically on push to `main`. That GH Pages URL is the canonical advertised
link (e.g., on the deck's own closing slide); this site copy is a same-domain
mirror. The two can drift if you regenerate one but not the other — GH Pages
rebuilds automatically; the site snapshot is the manual `build:talks` step above.

## Deploy

Deployed to Railway as its own service. Configuration lives in:

- `infra/index.ts` — canonical IaC: Railway service definition + env vars (Pulumi + TF bridge, mt#2110)
- `services/site/deploy.config.ts` — platform declaration (Railway adapter); Railway project/service/environment IDs inlined here
- `services/site/nixpacks.toml` — build/install/start commands

The `minsky-site` Railway project + service already exist (pre-date this monorepo absorb — the prior Hono+static scaffold deployed here). The post-absorb deploy requires three Railway-side config flips on the service:

1. **Source repository:** `edobry/minsky` (was `edobry/minsky-site` pre-absorb).
2. **Root directory:** `services/site` (was repo root pre-absorb).
3. **Cleanup:** the project carries three leftover `Postgres*` services from the prior scaffold. The Astro static site needs no database; pruning them is a principal-authorized followup.

To manage Railway env vars via Pulumi (mt#2110):

```bash
cd infra
PULUMI_CONFIG_PASSPHRASE="" pulumi preview --refresh   # dry-run
PULUMI_CONFIG_PASSPHRASE="" pulumi up --refresh        # apply
```

## Phase progress (mt#1934)

- [x] Phase 1: Foundation — Astro scaffold, brand tokens, base Layout, SEO scaffold
- [ ] Phase 2: Hero — locked headline, left-caption + right-product-screenshot, two CTAs, co-product logo strip
- [ ] Phase 3: Substrate-walkthrough — 8 Minsky product scenes (4+ as real screenshots)
- [ ] Phase 4: Polish — sitemap, robots.txt, footer CTA, full SEO floor
- [ ] Phase 5: Railway service config + deploy
- [ ] Phase 6: Cleanup — remove `~/Projects/minsky-site` legacy scaffold

## Cross-references

- mt#1934 — this task
- mt#1929 — brand workstream umbrella
- mt#1933 — brand-foundation skill (dependency, DONE)
- `services/minsky-mcp/`, `services/reviewer/` — sibling Railway service patterns
