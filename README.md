# classwatch

Get an alert the moment a full fitness class has a free spot.

- **Web app** (`app/`): browse a studio's timetable, tap the bell on the classes you want, and a
  Cloudflare cron job checks them every minute. When a spot opens, everyone watching that class gets a
  Telegram message with a **Book now** link (the owner can also get email). Runs on Cloudflare's free plan.
- **CLI** (`watcher.py`): the original single-file Python version, handy for `list`-ing classes.

Studios supported: **Pace Club (London Bridge)**, which uses bSport. Any other bSport studio is
one config entry; other platforms need an adapter (see *Adding studios*).

## Web app

### Architecture
One Cloudflare Worker that:
- serves the static UI from `app/public/` (plain HTML, CSS and JS, no build step)
- exposes `/api/*`, **all of which require a key** (the page shows a lock screen until one is entered)
- runs a **cron every minute**: loads every upcoming watch across all users, fetches each class once, and
  alerts everyone watching it on a *full → open* transition

Storage is **D1** (`users`, `watches`, `class_state`); tables are created automatically on first request.

### Roles and keys
Each deployment has one **owner** (whoever deploys it and manages its secrets) and any number of **users**.

| Key | Held by | Gives |
|---|---|---|
| `ACCESS_KEY` | Everyone allowed to use the app | Unlocks the app. Each user creates a profile (just a name) and gets their own watch list and Telegram alerts. |
| `OWNER_KEY` | The owner only | Signs in as the owner. Email alerts are owner-only; the server never offers the email option to anyone else. |

Keep `OWNER_KEY` private: anyone with it can act as the owner. Share `ACCESS_KEY` only with people you want using
the app; changing it locks everyone out until they enter the new one.

Each user's device stores a random **personal key** (Settings → **Copy personal key**) so the same profile can be
used on another device. **Lock** in Settings signs a device out and forgets its keys; watches and alerts keep working.
Limits: 25 users, 20 watches each (`app/src/db.ts`).

### Deploy (free)
```bash
cd app
npm install
npx wrangler login
npx wrangler d1 create classwatch            # paste the database_id into wrangler.toml
npx wrangler deploy
```
Or connect the repo in the Cloudflare dashboard (Workers & Pages → Import a repository, root directory `app`,
deploy command `npx wrangler deploy`) to deploy on every push.

Then add secrets (Worker → Settings → Variables and Secrets, type **Secret**):

| Secret | Needed for |
|---|---|
| `ACCESS_KEY` | Always. Shared with the app's users |
| `OWNER_KEY` | Always. Known only to the owner |
| `TELEGRAM_BOT_TOKEN` | Telegram alerts (one bot for all users) |
| `RESEND_API_KEY`, `EMAIL_TO` | Optional owner-only email |
| `EMAIL_FROM` | Optional. Only with a domain verified in Resend |

### Using the app
- **Owner:** open the app, unlock with `OWNER_KEY`, then in Settings connect Telegram and (optionally) tick Email.
- **Users:** unlock with `ACCESS_KEY`, create a profile, tap **Connect** next to Telegram and press **Start** in
  Telegram, then tap 🔔 on any full class.
- **Send test** in Settings sends a test alert and shows the exact error if a channel fails.

### Notifications
- **Telegram:** create one bot with @BotFather and set `TELEGRAM_BOT_TOKEN`. Each user taps **Connect** in Settings
  and presses **Start** in Telegram; the app links their chat automatically. If the Start button does nothing (no
  Telegram app on that computer), Settings shows a Telegram Web link and the exact `/start` message to send.
- **Email (owner only):** set `RESEND_API_KEY` and `EMAIL_TO`. Without a verified domain, Resend only sends to the
  address the Resend account was created with, so `EMAIL_TO` must be that address (or verify a domain and set
  `EMAIL_FROM`).

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
