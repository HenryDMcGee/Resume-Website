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

## The old resume site

The previous single-page resume site is kept on the `classic-site` branch. To put it back, check out `public/` from that branch and push:

```sh
git fetch origin classic-site && git checkout origin/classic-site -- public && git commit -m "Restore classic site" && git push
```

## Still to do

**Add www.** Only the apex is attached as a Custom Domain. Add `www.mcgeehenry.com` under the Worker's Domains tab.

After the first deploy, prime LinkedIn's preview cache at <https://www.linkedin.com/post-inspector/>.
