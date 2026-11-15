# classwatch

Get a push notification the moment a full fitness class has a free spot.

- **Web app** (`app/`): browse a studio's timetable, tap the bell on the classes you want, and a
  Cloudflare cron job checks them every minute and alerts each person on Telegram (plus email for the owner)
  with a "Book now" link. Runs entirely on Cloudflare's free plan.
- **CLI** (`watcher.py`): the original single-file Python version, handy for `list`-ing classes.

Studios supported: **Pace Club (London Bridge)**, which uses bSport. Any other bSport studio is
one config entry; other platforms need an adapter (see *Adding studios*).

## Web app

### Architecture
One Cloudflare Worker that:
- serves the static UI from `app/public/` (plain HTML, CSS and JS, no build step)
- exposes `/api/*`: `providers` and `classes` are public; everything else needs a key
- runs a **cron every minute**: loads every upcoming watch across all users, fetches each class once, and
  alerts everyone watching it on a *full → open* transition

Storage is **D1** (`users`, `watches`, `class_state`); tables are created automatically on first request.

### Who can do what
| Key | Who | Gets |
|---|---|---|
| `ACCESS_KEY` | You and friends | Opens the app. Each person creates a profile (just a name) and gets their own watch list and Telegram alerts. |
| `OWNER_KEY` | Only you | Signs you in as the owner. Email alerts exist only for the owner; the server never sends the email option to anyone else. |

A friend's device stores a random personal key (shown as **Copy personal key** in Settings) so they can use the same
profile on another device. Limits: 25 people, 20 watches each (`app/src/db.ts`).

### Deploy (free)
```bash
cd app
npm install
npx wrangler login
npx wrangler d1 create classwatch            # paste the database_id into wrangler.toml
npx wrangler deploy
```
Then add secrets (Worker > Settings > Variables and Secrets, type **Secret**):

| Secret | Needed for |
|---|---|
| `ACCESS_KEY` | Always. Share it with friends |
| `OWNER_KEY` | Always. Keep it to yourself |
| `TELEGRAM_BOT_TOKEN` | Telegram alerts (one bot for everyone) |
| `RESEND_API_KEY`, `EMAIL_TO` | Optional owner-only email |
| `EMAIL_FROM` | Optional. Only if you've verified your own domain in Resend |

### Notifications
- **Telegram:** create one bot with @BotFather and set `TELEGRAM_BOT_TOKEN`. Each person taps **Connect** in Settings,
  presses **Start** in Telegram, and the app links their chat automatically.
- **Email (owner only):** Resend API key in `RESEND_API_KEY`, your address in `EMAIL_TO`. Without your own domain, Resend
  only sends to the address you signed up with.

### Local dev
```bash
cd app
# .dev.vars (gitignored):  ACCESS_KEY=...  OWNER_KEY=...  TELEGRAM_BOT_TOKEN=...
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
