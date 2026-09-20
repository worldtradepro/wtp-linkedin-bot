# World Trade Pro · LinkedIn queue

Generates the day's LinkedIn posts for two accounts and renders their images. Nothing is published by this code.

| account | posts/day | source |
|---|---|---|
| `main` — World Trade Pro | 3 single news posts | Trade Flow, score >= 10, all sectors, de-duplicated, one per lane |
| `infra` — World Trade Pro · Infrastructure | 2 single project posts | Infrastructure free window (7–15 days back), early stages first |

## Run

```
npm install                      # once
npx playwright install chromium  # once
node generate.mjs                # picks posts  -> queue/YYYY-MM-DD/*.json
node render.mjs                  # opens each source article: description + screenshot -> images/*.png, preview.md
```

Options: `--date YYYY-MM-DD`, `generate.mjs --dry` (print only), `render.mjs --only main-1`.

## How a post is built

- Text: flag + sector emoji + original headline · 2–3 opening sentences of the article (publisher's own summary line first) ·
  "Why it matters" (trade lane it sits on) or "Who it's for" (project) · outlet name · hashtags.
- The **source link and the tracked map link go in the first comment** (`firstComment` in each JSON), not in the body.
- Image: screenshot of the article's headline area on a branded frame, cookie pop-ups dismissed (Reject preferred).
  If the page is blocked / is the wrong page, an own-design card is used instead (`imageKind: "card"`).

## Not done yet

- Push to Buffer (API key from the user, stored as a GitHub secret) and the daily GitHub Actions schedule.
- Own-artwork posts (daily flash, weekly summary, weekly projects card): they come from the map's Share button.
- Public image URLs for Buffer (images are only local files for now).

## Config

`config.json`: posts per day, minimum score, posting slots (UTC), blocked words.
`state/used.json` remembers source URLs already posted.
