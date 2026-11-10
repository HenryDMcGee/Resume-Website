# mcgeehenry.com

Live at <https://mcgeehenry.com>

Since November 2, 2026 this site is AI-HUB, Henry's project hub in its demo mode: a landing page, the channel grid with a walkthrough for each project, then About me, Video, AI fluency, Leadership and Get in touch.

The page is built in the [AI-Hub-channels](https://github.com/HenryDMcGee/AI-Hub-channels) repo. Edit it there, not here: `public/` is generated and overwritten on every deploy.

## Deploying

From an AI-Hub-channels checkout:

```sh
.build/deploy_site.sh /path/to/resume-website --push
```

That copies the built `index.html` and `demo/` into `public/`, records the hub commit in `public/version.txt`, commits and pushes. Pushing to `main` triggers the Cloudflare deploy (Worker `resume-website`, Workers Static Assets from `./public`, see `wrangler.jsonc`). Manually: `npx wrangler deploy`.

## Feedback page

- **mcgeehenry.com/feedback** is a blank page for user testers. They type their thoughts (name optional) and press Save. Drafts stay in their browser until saved. Not linked from the site; send testers the URL.
- **mcgeehenry.com/feedback/responses** is the private list of everything saved, newest first, with Copy all and Delete. Behind Cloudflare Access (see below).
- **mcgeehenry.com/insights** is the private visit report, also behind Cloudflare Access. The hub logs each visitor's decisions (screens, channels, walkthrough steps, demo apps, tutorial, Email/LinkedIn clicks, and whether they moved by bar, scroll, swipe or keys) to `POST /api/t`, and this page compares every visit with the seven-step happy path defined at the top of its script: a funnel with what people did instead at each step, walkthrough depth, input methods, common routes and a per-visit log. Two switches at the top: **Record visits** turns recording off or on for everyone (the hub and the Clarity tag check `GET /api/t/on`; the Worker also drops events while it is off), and **Count this browser** decides whether your own visits are logged. Opening the page leaves your browser out by default; `?notrack=1` / `?notrack=0` on any page sets the same thing on another device. Visits are kept in the tables `visits` and `visit_events` of the same D1 database; capped at 600 events per visit and 60 visits per address per day.
- **Microsoft Clarity** (heatmaps and replays) is added by the hub's `.build/deploy_site.sh` when `.build/clarity_id` holds the project id. The hub sends the same events to Clarity and sets the visit id as Clarity's custom user id, so a visit on /insights can be found in Clarity's recordings.

How it works: `worker/index.js` handles only `/api/*` (`run_worker_first` in `wrangler.jsonc`); every other path is served from `public/` as before. Responses are stored in the D1 database `mcgeehenry-feedback` (binding `DB`), which `wrangler deploy` creates on the first deploy (no `database_id` in the config); the table is created on first use. Saving has a hidden honeypot field, a 20,000-character cap and a limit of 20 saves per visitor per day (visitors are counted by a salted hash, never their address).

**Private pages: Cloudflare Access.** `/insights`, `/feedback/responses`, `/api/insights` and `/api/feedback/responses` sit behind a Cloudflare Access application (Zero Trust > Access > Applications, self-hosted, one-time PIN by email, policy allowing only Henry's address). Access shows its sign-in page before the private pages load and adds a signed token to every request. The Worker verifies that token itself (signature against the team's public keys, issuer, audience, expiry), so the workers.dev URL, which Access does not cover, gets nothing either. `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` under `vars` in `wrangler.jsonc` name the Access app; until both are filled in, the admin endpoints answer 503. Saving feedback and the visit log are public and unaffected.

Local test: the admin endpoints need a real Access token, so locally they answer 503 (or 401); the public pages and `/api/feedback`, `/api/t` work with `npx wrangler dev`.

## The old resume site

The previous single-page resume site is kept on the `classic-site` branch. To put it back, check out `public/` from that branch and push:

```sh
git fetch origin classic-site && git checkout origin/classic-site -- public && git commit -m "Restore classic site" && git push
```

## Still to do

**Add www.** Only the apex is attached as a Custom Domain. Add `www.mcgeehenry.com` under the Worker's Domains tab.

After the first deploy, prime LinkedIn's preview cache at <https://www.linkedin.com/post-inspector/>.
