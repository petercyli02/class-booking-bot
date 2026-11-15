/**
 * KV layout (two keys so the UI and the cron never overwrite each other):
 *   "watches" - Watch[]                     written only by the UI (add/remove)
 *   "state"   - Record<key, {open:boolean}> written only by the cron, and only on change
 * Free KV allows 1,000 writes/day, so the cron must not write every minute.
 */

export const MAX_WATCHES = 50;

export interface Watch {
  key: string;
  providerId: string;
  externalId: string;
  name: string;
  start: string;
  bookUrl: string;
  addedAt: string;
}

export type WatchState = Record<string, { open: boolean; since: string }>;

export async function getWatches(kv: KVNamespace): Promise<Watch[]> {
  return (await kv.get<Watch[]>("watches", "json")) ?? [];
}

export async function putWatches(kv: KVNamespace, watches: Watch[]): Promise<void> {
  await kv.put("watches", JSON.stringify(watches));
}

export async function getState(kv: KVNamespace): Promise<WatchState> {
  return (await kv.get<WatchState>("state", "json")) ?? {};
}

export async function putState(kv: KVNamespace, state: WatchState): Promise<void> {
  await kv.put("state", JSON.stringify(state));
}

export const isUpcoming = (w: Watch) => new Date(w.start).getTime() > Date.now();

/** "settings" key - which notification channels are ticked in the UI. */
export interface NotifySettings {
  telegram: { enabled: boolean };
  email: { enabled: boolean; to: string };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Coerce untrusted input into valid settings. */
export function parseSettings(raw: unknown): NotifySettings {
  const r = (raw ?? {}) as { telegram?: { enabled?: unknown }; email?: { enabled?: unknown; to?: unknown } };
  const to = typeof r.email?.to === "string" ? r.email.to.trim().slice(0, 254) : "";
  return {
    telegram: { enabled: r.telegram?.enabled === true },
    email: { enabled: r.email?.enabled === true, to: EMAIL_RE.test(to) ? to : "" },
  };
}

/** Saved settings, or a default of "Telegram on" until the user saves their own. */
export async function getSettings(kv: KVNamespace): Promise<NotifySettings> {
  const saved = await kv.get("settings", "json");
  return saved ? parseSettings(saved) : { telegram: { enabled: true }, email: { enabled: false, to: "" } };
}

export async function putSettings(kv: KVNamespace, s: NotifySettings): Promise<void> {
  await kv.put("settings", JSON.stringify(s));
}
