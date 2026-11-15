"""Pace Club (bSport) class-space watcher.

Polls bSport's public timetable API and notifies you (push via ntfy and/or email)
the moment a full class you're watching gets a free spot.

Usage:
    python watcher.py list 2026-11-29      # show classes + IDs for a day
    python watcher.py watch                # run forever, watching config.json
    python watcher.py test-notify          # send a test notification

Standard library only - no pip install needed.
"""

import json
import os
import random
import smtplib
import sys
import time
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta
from email.message import EmailMessage
from pathlib import Path
from zoneinfo import ZoneInfo

COMPANY_ID = 4961  # Pace Club London
API = "https://api.production.bsport.io/book/v1/offer/"
BOOK_URL = "https://backoffice.bsport.io/booker-module-s/{company}/{offer_id}?membership={company}"
LONDON = ZoneInfo("Europe/London")
HERE = Path(__file__).resolve().parent


# ---------------------------------------------------------------- config ---

def load_env(path=HERE / ".env"):
    """Minimal .env loader (KEY=VALUE lines) so secrets stay out of config.json."""
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def load_config():
    cfg = json.loads((HERE / "config.json").read_text(encoding="utf-8"))
    cfg.setdefault("poll_seconds", 60)
    cfg.setdefault("watch", [])
    return cfg


def log(msg):
    print(f"[{datetime.now(LONDON):%Y-%m-%d %H:%M:%S}] {msg}", flush=True)


# ------------------------------------------------------------------- api ---

def fetch_offers(day_from: date, day_to: date):
    """All classes between two dates (inclusive). Public endpoint, no login."""
    params = {
        "company": COMPANY_ID,
        "min_date": day_from.isoformat(),
        "max_date": (day_to + timedelta(days=1)).isoformat(),
        "only_future_strict": "true",
        "available": "true",
        "page_size": 200,
    }
    url = API + "?" + urllib.parse.urlencode(params)
    results = []
    while url:
        req = urllib.request.Request(url, headers={
            "Accept": "application/json",
            "User-Agent": "Mozilla/5.0 (class-space-watcher)",
        })
        with urllib.request.urlopen(req, timeout=20) as r:
            data = json.load(r)
        results.extend(data.get("results", []))
        url = data.get("next_page") if isinstance(data.get("next_page"), str) else None
    return results


def summarise(o):
    start = datetime.fromisoformat(o["date_start"]).astimezone(LONDON)
    capacity = o.get("effectif") or 0
    booked = o.get("validated_booking_count") or 0
    return {
        "id": o["id"],
        "name": o.get("name_override") or o.get("activity_name", "?"),
        "start": start,
        "capacity": capacity,
        "booked": booked,
        "spots": max(capacity - booked, 0),
        "full": bool(o.get("full")),
    }


def matches(c, rule):
    """A watch rule is either {"id": 123} or {"name": "signature", "date": "2026-11-29", "time": "09:30"}."""
    if "id" in rule:
        return c["id"] == int(rule["id"])
    if rule.get("date") and c["start"].date().isoformat() != rule["date"]:
        return False
    if rule.get("time") and c["start"].strftime("%H:%M") != rule["time"]:
        return False
    if rule.get("name") and rule["name"].lower() not in c["name"].lower():
        return False
    return True


# --------------------------------------------------------- notifications ---

def notify(title, body, link=None):
    sent = False
    topic = os.environ.get("NTFY_TOPIC")
    if topic:
        try:
            headers = {"Title": title.encode("utf-8"), "Priority": "urgent", "Tags": "runner"}
            if link:
                headers["Click"] = link
                headers["Actions"] = f"view, Book now, {link}"
            server = os.environ.get("NTFY_SERVER", "https://ntfy.sh").rstrip("/")
            req = urllib.request.Request(f"{server}/{topic}", data=body.encode("utf-8"), headers=headers)
            urllib.request.urlopen(req, timeout=15).read()
            sent = True
        except Exception as e:
            log(f"ntfy failed: {e}")

    if os.environ.get("SMTP_USER") and os.environ.get("EMAIL_TO"):
        try:
            msg = EmailMessage()
            msg["Subject"] = title
            msg["From"] = os.environ["SMTP_USER"]
            msg["To"] = os.environ["EMAIL_TO"]
            msg.set_content(body + (f"\n\nBook: {link}" if link else ""))
            host = os.environ.get("SMTP_HOST", "smtp.gmail.com")
            port = int(os.environ.get("SMTP_PORT", "465"))
            with smtplib.SMTP_SSL(host, port, timeout=20) as s:
                s.login(os.environ["SMTP_USER"], os.environ["SMTP_PASSWORD"])
                s.send_message(msg)
            sent = True
        except Exception as e:
            log(f"email failed: {e}")

    if not sent:
        log("WARNING: no notification channel worked - set NTFY_TOPIC and/or SMTP_* in .env")
    return sent


# -------------------------------------------------------------- commands ---

def cmd_list(day_str):
    day = date.fromisoformat(day_str) if day_str else datetime.now(LONDON).date()
    classes = sorted((summarise(o) for o in fetch_offers(day, day)), key=lambda c: c["start"])
    classes = [c for c in classes if c["start"].date() == day]
    if not classes:
        print(f"No classes found for {day}.")
        return
    print(f"Classes on {day:%A %d %b %Y}:\n")
    for c in classes:
        status = "FULL" if c["full"] else f"{c['spots']} left"
        print(f"  id={c['id']:<10} {c['start']:%H:%M}  {c['booked']:>2}/{c['capacity']:<3} {status:<8} {c['name']}")


def cmd_watch():
    cfg = load_config()
    if not cfg["watch"]:
        sys.exit("config.json has no 'watch' entries - add some (see README).")
    log(f"Watching {len(cfg['watch'])} rule(s), polling every ~{cfg['poll_seconds']}s")
    was_open = {}  # offer id -> bool, so we only alert on full -> open transitions

    while True:
        try:
            cfg = load_config()  # re-read each poll so edits apply without a restart
            today = datetime.now(LONDON).date()
            dates = [date.fromisoformat(r["date"]) for r in cfg["watch"] if r.get("date")]
            day_to = max(dates + [today + timedelta(days=14)])
            classes = [summarise(o) for o in fetch_offers(today, day_to)]
            now = datetime.now(LONDON)

            for c in classes:
                if c["start"] <= now or not any(matches(c, r) for r in cfg["watch"]):
                    continue
                is_open = not c["full"] and c["spots"] > 0
                if is_open and not was_open.get(c["id"], False):
                    link = BOOK_URL.format(company=COMPANY_ID, offer_id=c["id"])
                    title = f"Space at Pace Club: {c['name']}"
                    body = (f"{c['start']:%a %d %b %H:%M} - {c['spots']} spot(s) free "
                            f"({c['booked']}/{c['capacity']}). Book fast!")
                    log(f"OPEN  {c['id']} {body}")
                    notify(title, body, link)
                elif not is_open and was_open.get(c["id"]):
                    log(f"FULL again {c['id']} {c['start']:%a %d %b %H:%M} {c['name']}")
                was_open[c["id"]] = is_open
        except Exception as e:
            log(f"poll error: {e}")

        time.sleep(cfg["poll_seconds"] + random.uniform(0, 15))


def main():
    load_env()
    args = sys.argv[1:]
    if not args or args[0] in ("-h", "--help"):
        print(__doc__)
    elif args[0] == "list":
        cmd_list(args[1] if len(args) > 1 else None)
    elif args[0] == "watch":
        cmd_watch()
    elif args[0] == "test-notify":
        ok = notify("Pace Club watcher test", "If you can read this, notifications work.",
                    "https://backoffice.bsport.io/m/pace%20club%20London/4961/calendar/")
        print("sent" if ok else "nothing sent - check .env")
    else:
        sys.exit(f"unknown command: {args[0]}")


if __name__ == "__main__":
    main()
