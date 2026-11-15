import {
  MAX_WATCHES_PER_USER,
  addWatch,
  allUpcomingWatches,
  createUser,
  ensureSchema,
  getOwner,
  getStates,
  listWatches,
  pruneOld,
  randomToken,
  removeWatch,
  setStates,
  updateUser,
  userByToken,
  type User,
  type Watch,
} from "./db";
import {
  botReady,
  chatIdFor,
  emailReady,
  findChatForCode,
  getBotUsername,
  notifyRecipient,
  sendText,
  type NotifyEnv,
} from "./notify";
import { providers } from "./providers";
import type { FitnessClass } from "./providers/types";

export interface Env extends NotifyEnv {
  ASSETS: Fetcher;
  DB: D1Database;
  /** Shared with everyone who may use the app. */
  ACCESS_KEY?: string;
  /** Only the owner knows this; it also grants normal access. */
  OWNER_KEY?: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const json = (data: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });
const error = (message: string, status: number, extra: object = {}) => json({ error: message, ...extra }, status);

function safeEqual(given: string, expected: string | undefined): boolean {
  if (!expected) return false;
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(expected);
  return a.byteLength === b.byteLength && crypto.subtle.timingSafeEqual(a, b);
}

const daysBetween = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / 86_400_000;
const localDay = (iso: string, timeZone: string) => new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date(iso));

// ----------------------------------------------------------------- auth ---

type Caller = { role: "none" } | { role: "access" } | { role: "owner" | "user"; user: User };

/**
 * Authorization: Bearer <ACCESS_KEY | OWNER_KEY>
 * X-User-Token:  <personal token>   (friends only; identifies whose watch list it is)
 */
async function identify(req: Request, env: Env): Promise<Caller> {
  const key = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!key) return { role: "none" };
  if (safeEqual(key, env.OWNER_KEY)) return { role: "owner", user: await getOwner(env.DB) };
  if (!safeEqual(key, env.ACCESS_KEY)) return { role: "none" };
  const user = await userByToken(env.DB, (req.headers.get("x-user-token") ?? "").trim());
  return user ? { role: "user", user } : { role: "access" };
}

function profile(env: Env, user: User) {
  const isOwner = user.is_owner === 1;
  return {
    user: { name: user.name, isOwner },
    telegram: {
      botReady: botReady(env),
      connected: Boolean(chatIdFor(env, user)),
      enabled: user.notify_telegram === 1,
    },
    // Owner-only. Never present for anyone else, so their UI can't even show it.
    ...(isOwner ? { email: { enabled: user.notify_email === 1, configured: emailReady(env) } } : {}),
    maxWatches: MAX_WATCHES_PER_USER,
  };
}

const watchOut = (w: Watch) => ({ key: w.class_key, providerId: w.provider_id, name: w.name, start: w.start, bookUrl: w.book_url });

// ------------------------------------------------------------------ API ---

async function handleApi(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "");
  const method = req.method;

  // Nothing is public: every API call needs the access key or the owner key.
  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!safeEqual(bearer, env.ACCESS_KEY) && !safeEqual(bearer, env.OWNER_KEY)) return error("invalid access key", 401);

  // ----- timetable (any valid key) -----
  if (path === "/api/providers" && method === "GET") {
    return json([...providers.values()].map(({ id, name, location, timezone }) => ({ id, name, location, timezone })));
  }

  if (path === "/api/classes" && method === "GET") {
    const provider = providers.get(url.searchParams.get("provider") ?? "");
    const from = url.searchParams.get("from") ?? "";
    const to = url.searchParams.get("to") ?? from;
    if (!provider) return error("unknown provider", 400);
    if (!DATE_RE.test(from) || !DATE_RE.test(to) || daysBetween(from, to) < 0 || daysBetween(from, to) > 13)
      return error("from/to must be YYYY-MM-DD, at most 14 days apart", 400);

    const cache = caches.default;
    const cacheKey = new Request(url.toString(), { method: "GET" });
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
    try {
      const res = json({ classes: await provider.listClasses(from, to) }, 200, { "cache-control": "private, max-age=30" });
      ctx.waitUntil(cache.put(cacheKey, res.clone()));
      return res;
    } catch (e) {
      console.error(e);
      return error("could not reach the studio's booking system", 502);
    }
  }

  // ----- everything else needs a key -----
  await ensureSchema(env.DB);
  const caller = await identify(req, env);
  if (caller.role === "none") return error("invalid access key", 401);

  if (path === "/api/me" && method === "GET") {
    if (caller.role === "access") return json({ needsProfile: true });
    return json(profile(env, caller.user));
  }

  if (path === "/api/profile" && method === "POST") {
    if (caller.role === "owner") return error("the owner doesn't need a profile", 400);
    const body = (await req.json().catch(() => ({}))) as { name?: unknown };
    const name = typeof body.name === "string" ? body.name.trim().slice(0, 40) : "";
    if (!name) return error("enter your name", 400);
    const created = await createUser(env.DB, name);
    if ("error" in created) return error(created.error, 409);
    return json({ token: created.token, ...profile(env, created.user) });
  }

  if (caller.role === "access") return error("create a profile first", 401, { needsProfile: true });
  const user = caller.user;
  const isOwner = caller.role === "owner";

  if (path === "/api/settings" && method === "PUT") {
    const body = (await req.json().catch(() => ({}))) as { telegram?: { enabled?: unknown }; email?: { enabled?: unknown } };
    const fields: Parameters<typeof updateUser>[2] = {};
    if (typeof body.telegram?.enabled === "boolean") fields.notify_telegram = body.telegram.enabled ? 1 : 0;
    if (isOwner && typeof body.email?.enabled === "boolean") fields.notify_email = body.email.enabled ? 1 : 0;
    await updateUser(env.DB, user.id, fields);
    return json(profile(env, { ...user, ...fields }));
  }

  if (path === "/api/test-notify" && method === "POST") {
    const body = (await req.json().catch(() => ({}))) as { telegram?: { enabled?: unknown }; email?: { enabled?: unknown } };
    const result = await notifyRecipient(
      env,
      {
        ...user,
        notify_telegram: typeof body.telegram?.enabled === "boolean" ? (body.telegram.enabled ? 1 : 0) : user.notify_telegram,
        notify_email: isOwner && typeof body.email?.enabled === "boolean" ? (body.email.enabled ? 1 : 0) : user.notify_email,
      },
      { title: "classwatch test", body: `Hi ${user.name}, notifications are working.`, link: url.origin },
    );
    return json(result, result.ok ? 200 : 502);
  }

  // ----- Telegram linking: open t.me/<bot>?start=<code>, press Start, app picks up the chat -----
  if (path === "/api/telegram/link" && method === "POST") {
    if (!botReady(env)) return error("the app's Telegram bot isn't set up yet (TELEGRAM_BOT_TOKEN)", 400);
    try {
      const code = randomToken(12);
      await updateUser(env.DB, user.id, { link_code: code });
      const bot = await getBotUsername(env.TELEGRAM_BOT_TOKEN!);
      return json({ url: `https://t.me/${bot}?start=${code}`, bot, message: `/start ${code}` });
    } catch (e) {
      return error(`Telegram: ${(e as Error).message}`, 502);
    }
  }

  if (path === "/api/telegram/check" && method === "POST") {
    if (!user.link_code || !botReady(env)) return json({ connected: Boolean(chatIdFor(env, user)) });
    try {
      const chatId = await findChatForCode(env.TELEGRAM_BOT_TOKEN!, user.link_code);
      if (!chatId) return json({ connected: false });
      await updateUser(env.DB, user.id, { telegram_chat_id: chatId, link_code: null, notify_telegram: 1 });
      ctx.waitUntil(sendText(env.TELEGRAM_BOT_TOKEN!, chatId, `Connected to classwatch as ${user.name}. You'll get alerts here.`));
      return json({ connected: true });
    } catch (e) {
      return error(`Telegram: ${(e as Error).message}`, 502);
    }
  }

  if (path === "/api/telegram/disconnect" && method === "POST") {
    await updateUser(env.DB, user.id, { telegram_chat_id: null, link_code: null });
    return json(profile(env, { ...user, telegram_chat_id: null }));
  }

  // ----- watches (per user) -----
  if (path === "/api/watches" && method === "GET") {
    const watches = await listWatches(env.DB, user.id);
    const states = await getStates(env.DB, watches.map((w) => w.class_key));
    return json({
      watches: watches.map(watchOut),
      state: Object.fromEntries([...states].map(([k, open]) => [k, { open }])),
      maxWatches: MAX_WATCHES_PER_USER,
    });
  }

  if (path === "/api/watches" && method === "POST") {
    const c = (await req.json().catch(() => null)) as Partial<FitnessClass> | null;
    if (!c || typeof c.externalId !== "string" || typeof c.providerId !== "string") return error("expected a class object", 400);
    if (!providers.has(c.providerId)) return error("unknown provider", 400);
    if (typeof c.start !== "string" || Number.isNaN(Date.parse(c.start))) return error("bad start", 400);
    const problem = await addWatch(env.DB, {
      user_id: user.id,
      class_key: `${c.providerId}:${c.externalId}`,
      provider_id: c.providerId,
      external_id: c.externalId,
      name: String(c.name ?? "Class").slice(0, 120),
      start: new Date(c.start).toISOString(),
      book_url: typeof c.bookUrl === "string" && c.bookUrl.startsWith("https://") ? c.bookUrl : "",
    });
    if (problem) return error(problem, 409);
    return json({ watches: (await listWatches(env.DB, user.id)).map(watchOut) });
  }

  const del = path.match(/^\/api\/watches\/(.+)$/);
  if (del && method === "DELETE") {
    await removeWatch(env.DB, user.id, decodeURIComponent(del[1]));
    return json({ watches: (await listWatches(env.DB, user.id)).map(watchOut) });
  }

  return error("not found", 404);
}

// ----------------------------------------------------------------- cron ---

function windows(days: string[], maxSpan = 6): [string, string][] {
  const out: [string, string][] = [];
  for (const d of [...new Set(days)].sort()) {
    const last = out[out.length - 1];
    if (last && daysBetween(last[0], d) <= maxSpan) last[1] = d;
    else out.push([d, d]);
  }
  return out;
}

async function checkWatches(env: Env, scheduledTime: number): Promise<void> {
  await ensureSchema(env.DB);
  if (new Date(scheduledTime).getUTCMinutes() % 30 === 0) await pruneOld(env.DB);

  const rows = await allUpcomingWatches(env.DB);
  if (!rows.length) return;

  // One entry per class, with everyone watching it.
  const byClass = new Map<string, typeof rows>();
  for (const r of rows) byClass.set(r.class_key, [...(byClass.get(r.class_key) ?? []), r]);
  const before = await getStates(env.DB, [...byClass.keys()]);

  // Fetch each provider once per week-window of watched dates.
  const live = new Map<string, FitnessClass>();
  const byProvider = new Map<string, string[]>();
  for (const watchers of byClass.values()) {
    const w = watchers[0];
    const p = providers.get(w.provider_id);
    if (p) byProvider.set(p.id, [...(byProvider.get(p.id) ?? []), localDay(w.start, p.timezone)]);
  }
  for (const [providerId, days] of byProvider) {
    const provider = providers.get(providerId)!;
    for (const [from, to] of windows(days)) {
      try {
        for (const c of await provider.listClasses(from, to)) live.set(c.key, c);
      } catch (e) {
        console.error(`fetch failed for ${providerId} ${from}..${to}`, e);
      }
    }
  }

  const changes: [string, boolean][] = [];
  for (const [key, watchers] of byClass) {
    const c = live.get(key);
    if (!c) continue;
    const provider = providers.get(c.providerId)!;
    const was = before.get(key);
    let open = !c.full && c.spots > 0 && c.bookable;

    // Alert only on a full -> open transition we actually observed.
    if (open && was === false) {
      const when = new Intl.DateTimeFormat("en-GB", {
        timeZone: provider.timezone, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
      }).format(new Date(c.start));
      const message = {
        title: `Space at ${provider.name}: ${c.name}`,
        body: `${when} - ${c.spots} spot${c.spots === 1 ? "" : "s"} free. Book fast!`,
        link: c.bookUrl,
      };
      const results = await Promise.all(watchers.map((w) => notifyRecipient(env, w, message)));
      if (!results.some((r) => r.ok)) open = false; // nobody reached - retry next run
    }
    if (was !== open) changes.push([key, open]);
  }
  await setStates(env.DB, changes);
}

// --------------------------------------------------------------- entry ---

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(req, env, ctx);
      } catch (e) {
        console.error(e);
        return error("server error", 500);
      }
    }
    return env.ASSETS.fetch(req);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(checkWatches(env, event.scheduledTime));
  },
} satisfies ExportedHandler<Env>;
