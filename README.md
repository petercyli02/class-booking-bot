# classwatch

Get a push notification the moment a full fitness class has a free spot.

- **Web app** (`app/`): browse a studio's timetable, tap the bell on the classes you want, and a
  Cloudflare cron job checks them every minute and alerts you by Telegram and/or email
  with a "Book now" link. Runs entirely on Cloudflare's free plan.
- **CLI** (`watcher.py`): the original single-file Python version, handy for `list`-ing classes.

Studios supported: **Pace Club (London Bridge)**, which uses bSport. Any other bSport studio is
one config entry; other platforms need an adapter (see *Adding studios*).

## Web app

### Architecture
One Cloudflare Worker that:
- serves the static UI from `app/public/` (plain HTML, CSS and JS, no build step)
- exposes `/api/*`: `providers`, `classes` (proxied and normalised, with a 30s edge cache), `watches` (behind an access key)
- runs a **cron every minute**: reads your watches from KV, fetches those classes, and alerts you on a *full → open* transition

KV stores three keys. `watches` and `settings` (which channels are ticked) are written only by the UI, and `state` is written
only by the cron, and only when a class flips between full and open. This keeps it well inside the free 1,000 writes/day.

### Limits
Up to **50 watched classes** (`MAX_WATCHES` in `src/store.ts`). The cron fetches one request per week of
watched dates rather than one per class, so the real constraint is the free plan's 50 outbound requests
per run. 50 watches stays comfortably inside that.

### Deploy (free)
```bash
cd app
npm install
npx wrangler login
npx wrangler kv namespace create WATCH_KV     # paste the id into wrangler.toml
npx wrangler deploy
```
Then add secrets in the dashboard (Worker > Settings > Variables and Secrets, type **Secret**), or with `npx wrangler secret put <NAME>`:

| Secret | Needed for |
|---|---|
| `ACCESS_KEY` | Always. Any long passphrase; the UI asks for it |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Telegram alerts |
| `RESEND_API_KEY` | Email alerts |
| `EMAIL_FROM` | Optional. Only if you've verified your own domain in Resend |

Open the app, go to ⚙️ Settings, enter the access key, tick **Telegram** and/or **Email**, and tap **Send test**.

### Notifications
Pick the channels in Settings; an alert counts as sent if any ticked channel succeeds.
- **Telegram:** message @BotFather, send `/newbot`, and put the token in `TELEGRAM_BOT_TOKEN`. Send your new bot any
  message, then tap **Find chat ID** in Settings and put that number in `TELEGRAM_CHAT_ID`.
- **Email (Resend):** create a free account at resend.com and an API key, and put it in `RESEND_API_KEY`. Without your own
  domain, Resend sends from `onboarding@resend.dev` and **only to the address you signed up with**, so enter that
  address in Settings.

### Local dev
```bash
cd app
# .dev.vars (gitignored):  ACCESS_KEY=...  TELEGRAM_BOT_TOKEN=...  TELEGRAM_CHAT_ID=...  RESEND_API_KEY=...
npm run dev                                   # http://localhost:8787
curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"   # trigger the cron by hand
```

### Adding studios
- **Another bSport studio:** add an entry to `app/src/providers/index.ts` with its `companyId`
  (the number in its `backoffice.bsport.io/m/<name>/<companyId>/...` booking URL).
- **Another platform** (Mindbody, Glofox, TeamUp...): write an adapter implementing `Provider`
  from `app/src/providers/types.ts` that returns `FitnessClass[]`, and register it.

## CLI (`watcher.py`)
Standard library only.
```bash
python watcher.py list 2026-11-29     # classes + ids for a day
python watcher.py watch               # poll the classes in config.json
python watcher.py test-notify         # sends a test email
```
Copy `.env.example` to `.env` for Gmail SMTP settings.

## bSport API notes
- `GET https://api.production.bsport.io/book/v1/offer/?company=<id>&min_date=..&max_date=..&with_booking_window=true` (public, no auth)
- capacity `effectif`, taken `validated_booking_count`, `full`, `booking_window_status` (`not_yet_open`), pagination via `links.next`
- booking page: `https://backoffice.bsport.io/booker-module-s/<company>/<offer_id>?membership=<company>`
- Auto-booking would need an authenticated booking POST (not implemented yet).
