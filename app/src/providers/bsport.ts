import type { FitnessClass, Provider } from "./types";

/** Adapter for studios using bSport (public timetable API, no login needed). */
export interface BsportConfig {
  id: string;
  name: string;
  location: string;
  companyId: number;
  timezone: string;
}

const API = "https://api.production.bsport.io/book/v1/offer/";

interface BsportOffer {
  id: number;
  activity_name?: string;
  name_override?: string;
  date_start: string;
  duration_minute?: number;
  effectif?: number;
  validated_booking_count?: number;
  full?: boolean;
  available?: boolean;
  booking_window_status?: string;
  booking_window_start_datetime?: string | null;
}

/** "class - HYROX signature [50 min]" -> "HYROX signature" */
function cleanName(raw: string): string {
  return raw
    .replace(/^\s*class\s*-\s*/i, "")
    .replace(/\s*\[[^\]]*\]\s*$/, "")
    .trim();
}

function addDays(day: string, n: number): string {
  const d = new Date(day + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function bsport(cfg: BsportConfig): Provider {
  return {
    id: cfg.id,
    name: cfg.name,
    location: cfg.location,
    timezone: cfg.timezone,

    async listClasses(from, to) {
      const params = new URLSearchParams({
        company: String(cfg.companyId),
        min_date: from,
        max_date: addDays(to, 1),
        only_future_strict: "true",
        available: "true",
        with_booking_window: "true",
        page_size: "200",
      });
      let url: string | null = `${API}?${params}`;
      const offers: BsportOffer[] = [];
      for (let page = 0; url && page < 5; page++) {
        const res = await fetch(url, { headers: { Accept: "application/json" } });
        if (!res.ok) throw new Error(`bSport ${res.status}`);
        const data = (await res.json()) as { results?: BsportOffer[]; links?: { next?: string | null } };
        offers.push(...(data.results ?? []));
        url = data.links?.next ?? null;
      }

      const localDate = new Intl.DateTimeFormat("en-CA", { timeZone: cfg.timezone });
      return offers
        .map((o): FitnessClass => {
          const capacity = o.effectif ?? 0;
          const booked = o.validated_booking_count ?? 0;
          const start = new Date(o.date_start);
          const notOpenYet = o.booking_window_status === "not_yet_open";
          return {
            key: `${cfg.id}:${o.id}`,
            providerId: cfg.id,
            externalId: String(o.id),
            name: cleanName(o.name_override || o.activity_name || "Class"),
            start: start.toISOString(),
            durationMin: o.duration_minute ?? 0,
            capacity,
            booked,
            spots: Math.max(capacity - booked, 0),
            full: Boolean(o.full) || (capacity > 0 && booked >= capacity),
            bookable: !notOpenYet,
            opensAt: notOpenYet ? o.booking_window_start_datetime ?? null : null,
            bookUrl: `https://backoffice.bsport.io/booker-module-s/${cfg.companyId}/${o.id}?membership=${cfg.companyId}`,
          };
        })
        .filter((c) => {
          const d = localDate.format(new Date(c.start));
          return d >= from && d <= to;
        })
        .sort((a, b) => a.start.localeCompare(b.start));
    },
  };
}
