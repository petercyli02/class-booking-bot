import { notify } from "./notify";
import { providers } from "./providers";
import type { FitnessClass } from "./providers/types";
import {
  MAX_WATCHES,
  getState,
  getWatches,
  isUpcoming,
  putState,
  putWatches,
  type Watch,
  type WatchState,
} from "./store";

export interface Env {
  ASSETS: Fetcher;
  WATCH_KV: KVNamespace;
  ACCESS_KEY?: string;
  NTFY_TOPIC?: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const json = (data: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const error = (message: string, status: number) => json({ error: message }, status);

function authorised(req: Request, env: Env): boolean {
  if (!env.ACCESS_KEY) return false;
  const given = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(env.ACCESS_KEY);
  return a.byteLength === b.byteLength && crypto.subtle.timingSafeEqual(a, b);
}

function daysBetween(from: string, to: string): number {
  return (Date.parse(to) - Date.parse(from)) / 86_400_000;
}

function localDay(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date(iso));
}

// ------------------------------------------------------------------ API ---

async function handleApi(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "");

  if (path === "/api/providers" && req.method === "GET") {
    return json(
      [...providers.values()].map(({ id, name, location, timezone }) => ({ id, name, location, timezone })),
    );
  }

  if (path === "/api/classes" && req.method === "GET") {
    const provider = providers.get(url.searchParams.get("provider") ?? "");
    const from = url.searchParams.get("from") ?? "";
    const to = url.searchParams.get("to") ?? from;
    if (!provider) return error("unknown provider", 400);
    if (!DATE_RE.test(from) || !DATE_RE.test(to) || daysBetween(from, to) < 0 || daysBetween(from, to) > 13)
      return error("from/to must be YYYY-MM-DD, at most 14 days apart", 400);

    // Short edge cache so many page views don't hammer the studio's API.
    const cache = caches.default;
    const cacheKey = new Request(url.toString(), { method: "GET" });
    const hit = await cache.match(cacheKey);
    if (hit) return hit;

    try {
      const classes = await provider.listClasses(from, to);
      const res = json({ classes }, 200, { "cache-control": "public, max-age=30" });
      ctx.waitUntil(cache.put(cacheKey, res.clone()));
      return res;
    } catch (e) {
      console.error(e);
      return error("could not reach the studio's booking system", 502);
    }
  }

  // Everything below changes or reveals your watch list -> needs the access key.
  if (path.startsWith("/api/watches") || path === "/api/auth" || path === "/api/test-notify") {
    if (!authorised(req, env)) return error("invalid access key", 401);
  }

  if (path === "/api/auth" && req.method === "GET") return json({ ok: true, maxWatches: MAX_WATCHES });

  if (path === "/api/test-notify" && req.method === "POST") {
    const ok = await notify(env.NTFY_TOPIC, {
      title: "Class watch test",
      body: "Notifications are working.",
      link: url.origin,
    });
    return ok ? json({ ok }) : error("notification failed - is NTFY_TOPIC set?", 500);
  }

  if (path === "/api/watches" && req.method === "GET") {
    const [watches, state] = await Promise.all([getWatches(env.WATCH_KV), getState(env.WATCH_KV)]);
    return json({ watches: watches.filter(isUpcoming), state, maxWatches: MAX_WATCHES });
  }

  if (path === "/api/watches" && req.method === "POST") {
    const body = (await req.json().catch(() => null)) as Partial<FitnessClass> | null;
    if (!body || typeof body.externalId !== "string" || typeof body.providerId !== "string")
      return error("expected a class object", 400);
    if (!providers.has(body.providerId)) return error("unknown provider", 400);
    if (typeof body.start !== "string" || Number.isNaN(Date.parse(body.start))) return error("bad start", 400);

    const watches = (await getWatches(env.WATCH_KV)).filter(isUpcoming);
    const key = `${body.providerId}:${body.externalId}`;
    if (!watches.some((w) => w.key === key)) {
      if (watches.length >= MAX_WATCHES) return error(`you can watch up to ${MAX_WATCHES} classes`, 409);
      watches.push({
        key,
        providerId: body.providerId,
        externalId: body.externalId,
        name: String(body.name ?? "Class").slice(0, 120),
        start: new Date(body.start).toISOString(),
        bookUrl: typeof body.bookUrl === "string" && body.bookUrl.startsWith("https://") ? body.bookUrl : "",
        addedAt: new Date().toISOString(),
      });
      watches.sort((a, b) => a.start.localeCompare(b.start));
      await putWatches(env.WATCH_KV, watches);
    }
    return json({ watches });
  }

  const del = path.match(/^\/api\/watches\/(.+)$/);
  if (del && req.method === "DELETE") {
    const key = decodeURIComponent(del[1]);
    const watches = await getWatches(env.WATCH_KV);
    const kept = watches.filter((w) => w.key !== key && isUpcoming(w));
    if (kept.length !== watches.length) await putWatches(env.WATCH_KV, kept);
    return json({ watches: kept });
  }

  return error("not found", 404);
}

// ----------------------------------------------------------------- cron ---

/** Merge sorted days into fetch windows of at most `maxSpan` days. */
function windows(days: string[], maxSpan = 6): [string, string][] {
  const out: [string, string][] = [];
  for (const d of [...new Set(days)].sort()) {
    const last = out[out.length - 1];
    if (last && daysBetween(last[0], d) <= maxSpan) last[1] = d;
    else out.push([d, d]);
  }
  return out;
}

async function checkWatches(env: Env): Promise<void> {
  const watches = (await getWatches(env.WATCH_KV)).filter(isUpcoming);
  if (!watches.length) return;

  const prev = await getState(env.WATCH_KV);
  const next: WatchState = {};
  let changed = false;

  const byProvider = new Map<string, Watch[]>();
  for (const w of watches) byProvider.set(w.providerId, [...(byProvider.get(w.providerId) ?? []), w]);

  for (const [providerId, list] of byProvider) {
    const provider = providers.get(providerId);
    if (!provider) continue;

    const live = new Map<string, FitnessClass>();
    for (const [from, to] of windows(list.map((w) => localDay(w.start, provider.timezone)))) {
      try {
        for (const c of await provider.listClasses(from, to)) live.set(c.key, c);
      } catch (e) {
        console.error(`fetch failed for ${providerId} ${from}..${to}`, e);
      }
    }

    for (const w of list) {
      const c = live.get(w.key);
      const before = prev[w.key];
      if (!c) {
        if (before) next[w.key] = before; // keep last known state if the fetch missed it
        continue;
      }
      let open = !c.full && c.spots > 0 && c.bookable;

      // Alert only on a full -> open transition we actually observed.
      if (open && before && !before.open) {
        const when = new Intl.DateTimeFormat("en-GB", {
          timeZone: provider.timezone,
          weekday: "short",
          day: "numeric",
          month: "short",
          hour: "2-digit",
          minute: "2-digit",
        }).format(new Date(c.start));
        const sent = await notify(env.NTFY_TOPIC, {
          title: `Space at ${provider.name}: ${c.name}`,
          body: `${when} - ${c.spots} spot${c.spots === 1 ? "" : "s"} free. Book fast!`,
          link: c.bookUrl,
        });
        if (!sent) open = false; // retry on the next run
      }

      next[w.key] = before && before.open === open ? before : { open, since: new Date().toISOString() };
      if (!before || before.open !== open) changed = true;
    }
  }

  if (Object.keys(prev).some((k) => !(k in next))) changed = true; // prune removed watches
  if (changed) await putState(env.WATCH_KV, next);
}

// --------------------------------------------------------------- entry ---

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) return handleApi(req, env, ctx);
    return env.ASSETS.fetch(req);
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(checkWatches(env));
  },
} satisfies ExportedHandler<Env>;
