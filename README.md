# Henry McGee — personal site

Live at <https://mcgeehenry.com>

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

## Deploying

Pushing to `main` triggers the deploy. Manually: `npx wrangler deploy`

## Still to do

**Set the domain in the meta tags.** `REPLACE-WITH-YOUR-DOMAIN.com`
appears 5 times near the top of `public/index.html`. Change each to
`mcgeehenry.com`. Until then, pasting your link shows a bare URL
instead of a preview card — social previews need an absolute URL.

After that, prime the cache at
<https://www.linkedin.com/post-inspector/>. LinkedIn caches hard.

**Add www.** Only the apex is attached as a Custom Domain. Add
`www.mcgeehenry.com` under the Worker's Domains tab.

**Content worth a second look:**

- "As a project manager, I hope to bridge…" in About me probably
  wants to read *product* manager
- the Wells Fargo role has no date range; every other entry has one,
  and the resume shows 2022–2026
- MBA date reads "Expected 2028"; the resume says August 2028

## Hero sizing

The banner caps at `min(100svh, 920px)` and the portrait fills it at
`height: 100%`. Both matter together: the old rule let the hero grow
with the viewport while capping the photo at 1000px, so on a large
monitor the leftover space collected as an empty band above the
photo. Past 1600px wide the hero also gets side padding so its
content stays near the 1180px column the rest of the page uses.

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
