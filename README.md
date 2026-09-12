# Henry McGee — personal site

Static site served by Cloudflare Workers Static Assets. No build step.

## Layout

```
wrangler.jsonc     Cloudflare config — tells the Worker what to serve
public/            everything that gets published
  index.html       the page; all CSS and JS are inline
  henry-*.jpg/webp photos (webp for modern browsers, jpg fallback)
  favicon*         tab icons
  og-image.jpg     1200x630 link-preview card
```

Keep both the `.webp` and `.jpg` of each photo — the page picks one
per browser via a `<picture>` element.

## Before this deploys

**Check the Worker name.** The `name` field in `wrangler.jsonc` must
exactly match the Worker already in your Cloudflare dashboard. If it
doesn't, `wrangler deploy` creates a second Worker instead of
updating yours, and you'll be looking at the wrong URL.

## Deploying

Pushing to `main` triggers the deploy. Manually:

```sh
npx wrangler deploy
```

## Still to do

**Set your domain.** `REPLACE-WITH-YOUR-DOMAIN.com` appears 5 times
near the top of `public/index.html`. Until it's real, pasting your
link anywhere shows a bare URL instead of a preview card — social
previews require an absolute URL.

After the domain is live, prime the preview cache at
<https://www.linkedin.com/post-inspector/>. LinkedIn caches hard.

**Content worth a second look:**

- "As a project manager, I hope to bridge…" in About me probably
  wants to read *product* manager
- the Wells Fargo role has no date range; every other entry has one,
  and the resume shows 2022–2026
- MBA date reads "Expected 2028"; the resume says August 2028

## Contact links

Your email and LinkedIn are **not** in the page source. They're
base64-encoded and assembled by JavaScript on load, which blocks bots
that scan HTML for an email pattern. It does not stop a scraper
running a real browser.

To change the address:

```sh
python3 -c "import base64;print(base64.b64encode(b'you@example.com').decode())"
```

Paste the result into the `data-mail` attribute.

## Local preview

Don't open `index.html` by double-clicking — over `file://` the
YouTube embed fails with error 153, because the browser sends no
origin.

```sh
cd public && python3 -m http.server 8000
```

Then visit <http://localhost:8000>.
