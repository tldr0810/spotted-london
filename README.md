# Spotted London

**Pop-ups in London, added by locals and verified by the community.** Live at [spotted-london.zack11712.workers.dev](https://spotted-london.zack11712.workers.dev).

Anyone can add a pop-up. The community decides if it is real with weighted votes and check-ins, and admins can override. AI agents help find and check pop-ups, and people can ask their own AI assistant what is on. Mobile first.

## What is inside

- Map home with a bottom sheet list, filters, "near me" and a "For you" taste.
- Community verification: all rules in `src/lib/scoring.ts`.
- Paste a link, screenshot or text to add a pop-up (Workers AI fills the form).
- Agent fleet (Scout, Triage, Checker, Concierge) running on [Manyfold](https://manyfold.ai).
- MCP server at `/mcp` and `/llms.txt`, so ChatGPT, Claude or Gemini can search the list. Setup page: `/connect`.
- Free tiers only: one Cloudflare Worker (Hono), D1, KV, R2, Cron, Turnstile. Web app: Vite, React 19, MapLibre.

## Documents

- [CLAUDE.md](CLAUDE.md): architecture, code map and the rules that are easy to break.
- [SPEC.md](SPEC.md): product spec (Chinese) and decision log.
- [docs/DESIGN.md](docs/DESIGN.md): design system.
- [CONTRIBUTING.md](CONTRIBUTING.md): how to send a pull request.

## Quick start

You need Node.js 22+ and git. No Cloudflare account is needed.

```bash
git clone https://github.com/tldr0810/spotted-london.git
cd spotted-london
npm install
cp .dev.vars.example .dev.vars
npm run db:reset
npm run build:web
npm run dev:local      # Worker on :8787
```

Open `http://localhost:8787` and sign in at `/signin` as `new@spotted.dev` (the link shows on screen, no email is sent). For hot reload run `npm run dev:web` in a second terminal and open `http://localhost:5173`.

| Command | What it does |
|---|---|
| `npm run dev` | Same as `dev:local` but uses Workers AI (needs `npx wrangler login`) |
| `npm test` | Unit and API tests inside the Workers runtime |
| `npm run typecheck` | Type check the Worker (web: `cd web && npx tsc --noEmit`) |
| `npm run deploy` | Build web and deploy to production |

For scripts, act as a seeded user with the `x-dev-user: dev_zack` header (works only when `ENVIRONMENT=development`, set by `.dev.vars`). Seeded users: `dev_admin` (admin), `dev_zack` (member), `dev_new` (new account, votes weigh 0).

## AI agents and MCP

Agents run on Manyfold, not Cloudflare. Settings, keys and runs are at **/admin/agent**.

| Agent | Job |
|---|---|
| Scout | finds new pop-ups and sends pending drafts |
| Triage | checks the review queue, fixes small details, publishes or removes with proof |
| Checker | rechecks live pop-ups against their source |
| Concierge | answers the questions visitors type into Ask (read only, no key) |

- Spotted starts runs over A2A from the `*/10` cron. Agents talk back through `POST /mcp` with their own `spk_...` key.
- Public tools `search_popups` and `get_popup` need no key and are rate limited per visitor.
- Agent setup: follow the steps at the bottom of /admin/agent. Install the skill from `skills/spotted-london`, add the key with `mf mcp add ... --scope project`, press Connect with Manyfold, then Run now.
- Details (leases, auto-publish, limits, Ask, tags, Apify, insights) are in [CLAUDE.md](CLAUDE.md).

## Production

Live at **https://spotted-london.zack11712.workers.dev**.

| Resource | Name |
|---|---|
| Worker | `spotted-london` (cron: every 10 min, hourly, daily 04:00 UTC) |
| D1 | `spotted-db` |
| KV | `CACHE` |
| R2 | `spotted-images` |
| Analytics Engine | `spotted_events` (binding `EVENTS`) |

Secrets are set with `npx wrangler secret put NAME`, never in the repo: `IP_SALT`, `TURNSTILE_SECRET`, `AGENTS_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `APIFY_TOKEN`. Optional: `RESEND_API_KEY`, `EMAIL_FROM`, `CF_ACCOUNT_ID`, `CF_ANALYTICS_TOKEN`, `AGENT_ADMIN_TOKEN`.

### How deploys happen

Cloudflare Workers Builds is connected to this repo (no GitHub Actions).

- Push to `main` builds and deploys production.
- Other branches get a preview version. Previews share production D1, KV and R2, have no secrets, and read vars and bindings from the `previews` block in `wrangler.jsonc`, so add new ones in both places.
- The build token cannot touch D1. If a change adds a file to `migrations/`, run `npx wrangler d1 migrations apply spotted-db --remote` from a signed-in computer **before** merging.
- Build settings: build command `npm ci && npm run build:web`, deploy command `npx wrangler deploy`, `NODE_VERSION=22`.

### Still to switch on

- Email sign-in and reminders: add `RESEND_API_KEY` and `EMAIL_FROM`.
- Custom domain: add it to the Worker, update `APP_URL`, add it to Turnstile.

## Licence and credits

Code: [MIT](LICENSE). The icons in `web/src/components/Icon.tsx` are mostly from [Koboyo](https://koboyo.com/icons) under [their licence](https://koboyo.com/icons/license) and are not covered by MIT. Map tiles: [OpenFreeMap](https://openfreemap.org). Address search: [Photon](https://photon.komoot.io). Maps: [MapLibre](https://maplibre.org). Pop-up data in a running deployment is submitted by its users and is not part of this repository.
