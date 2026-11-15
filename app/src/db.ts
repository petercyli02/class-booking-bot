/**
 * D1 storage. Tables are created on first use, so no migration step is needed.
 *
 *   users        one row per person (the owner row has id "owner")
 *   watches      which classes each user is watching
 *   class_state  last seen full/open state per class, written by the cron only on change
 */

export const MAX_USERS = 25;
export const MAX_WATCHES_PER_USER = 20;
export const OWNER_ID = "owner";

export interface User {
  id: string;
  name: string;
  is_owner: number;
  telegram_chat_id: string | null;
  notify_telegram: number;
  notify_email: number;
  link_code: string | null;
  created_at: string;
}

export interface Watch {
  user_id: string;
  class_key: string;
  provider_id: string;
  external_id: string;
  name: string;
  start: string;
  book_url: string;
  added_at: string;
}

let schemaReady: Promise<unknown> | null = null;

export function ensureSchema(db: D1Database) {
  schemaReady ??= db
    .batch([
      db.prepare(`CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        token_hash TEXT UNIQUE,
        is_owner INTEGER NOT NULL DEFAULT 0,
        telegram_chat_id TEXT,
        notify_telegram INTEGER NOT NULL DEFAULT 1,
        notify_email INTEGER NOT NULL DEFAULT 1,
        link_code TEXT,
        created_at TEXT NOT NULL
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS watches (
        user_id TEXT NOT NULL,
        class_key TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        external_id TEXT NOT NULL,
        name TEXT NOT NULL,
        start TEXT NOT NULL,
        book_url TEXT NOT NULL DEFAULT '',
        added_at TEXT NOT NULL,
        PRIMARY KEY (user_id, class_key)
      )`),
      db.prepare(`CREATE INDEX IF NOT EXISTS watches_start ON watches (start)`),
      db.prepare(`CREATE TABLE IF NOT EXISTS class_state (
        class_key TEXT PRIMARY KEY,
        open INTEGER NOT NULL,
        since TEXT NOT NULL
      )`),
    ])
    .catch((e) => {
      schemaReady = null; // retry on next request
      throw e;
    });
  return schemaReady;
}

const now = () => new Date().toISOString();

export function randomToken(bytes = 24): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

// ----------------------------------------------------------------- users ---

export async function getOwner(db: D1Database): Promise<User> {
  await db
    .prepare(`INSERT OR IGNORE INTO users (id, name, is_owner, created_at) VALUES (?, 'Owner', 1, ?)`)
    .bind(OWNER_ID, now())
    .run();
  return (await db.prepare(`SELECT * FROM users WHERE id = ?`).bind(OWNER_ID).first<User>())!;
}

export async function userByToken(db: D1Database, token: string): Promise<User | null> {
  if (!token) return null;
  return db.prepare(`SELECT * FROM users WHERE token_hash = ? AND is_owner = 0`).bind(await sha256(token)).first<User>();
}

export async function createUser(db: D1Database, name: string): Promise<{ user: User; token: string } | { error: string }> {
  const count = await db.prepare(`SELECT COUNT(*) AS n FROM users WHERE is_owner = 0`).first<number>("n");
  if ((count ?? 0) >= MAX_USERS) return { error: `this app is limited to ${MAX_USERS} people` };
  const token = randomToken();
  const id = randomToken(9);
  await db
    .prepare(`INSERT INTO users (id, name, token_hash, is_owner, notify_email, created_at) VALUES (?, ?, ?, 0, 0, ?)`)
    .bind(id, name, await sha256(token), now())
    .run();
  return { user: (await db.prepare(`SELECT * FROM users WHERE id = ?`).bind(id).first<User>())!, token };
}

export async function updateUser(
  db: D1Database,
  id: string,
  fields: Partial<Pick<User, "name" | "telegram_chat_id" | "notify_telegram" | "notify_email" | "link_code">>,
) {
  const keys = Object.keys(fields) as (keyof typeof fields)[];
  if (!keys.length) return;
  await db
    .prepare(`UPDATE users SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`)
    .bind(...keys.map((k) => fields[k] ?? null), id)
    .run();
}

// --------------------------------------------------------------- watches ---

export async function listWatches(db: D1Database, userId: string): Promise<Watch[]> {
  const { results } = await db
    .prepare(`SELECT * FROM watches WHERE user_id = ? AND start > ? ORDER BY start`)
    .bind(userId, now())
    .all<Watch>();
  return results;
}

export async function addWatch(db: D1Database, w: Omit<Watch, "added_at">): Promise<string | null> {
  const count = await db
    .prepare(`SELECT COUNT(*) AS n FROM watches WHERE user_id = ? AND start > ?`)
    .bind(w.user_id, now())
    .first<number>("n");
  if ((count ?? 0) >= MAX_WATCHES_PER_USER) return `you can watch up to ${MAX_WATCHES_PER_USER} classes`;
  await db
    .prepare(
      `INSERT OR IGNORE INTO watches (user_id, class_key, provider_id, external_id, name, start, book_url, added_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(w.user_id, w.class_key, w.provider_id, w.external_id, w.name, w.start, w.book_url, now())
    .run();
  return null;
}

export async function removeWatch(db: D1Database, userId: string, classKey: string) {
  await db.prepare(`DELETE FROM watches WHERE user_id = ? AND class_key = ?`).bind(userId, classKey).run();
}

/** All upcoming watches across users, joined with the watcher's notification settings. */
export async function allUpcomingWatches(db: D1Database) {
  const { results } = await db
    .prepare(
      `SELECT w.*, u.name AS user_name, u.is_owner, u.telegram_chat_id, u.notify_telegram, u.notify_email
       FROM watches w JOIN users u ON u.id = w.user_id
       WHERE w.start > ?`,
    )
    .bind(now())
    .all<Watch & Pick<User, "is_owner" | "telegram_chat_id" | "notify_telegram" | "notify_email"> & { user_name: string }>();
  return results;
}

/** Housekeeping: drop watches for classes that have started, and their state. */
export async function pruneOld(db: D1Database) {
  const cutoff = new Date(Date.now() - 6 * 3600_000).toISOString();
  await db.batch([
    db.prepare(`DELETE FROM watches WHERE start < ?`).bind(cutoff),
    db.prepare(`DELETE FROM class_state WHERE class_key NOT IN (SELECT DISTINCT class_key FROM watches)`),
  ]);
}

// ----------------------------------------------------------- class state ---

export async function getStates(db: D1Database, keys: string[]): Promise<Map<string, boolean>> {
  if (!keys.length) return new Map();
  const { results } = await db
    .prepare(`SELECT class_key, open FROM class_state WHERE class_key IN (${keys.map(() => "?").join(",")})`)
    .bind(...keys)
    .all<{ class_key: string; open: number }>();
  return new Map(results.map((r) => [r.class_key, r.open === 1]));
}

export async function setStates(db: D1Database, changes: [string, boolean][]) {
  if (!changes.length) return;
  const t = now();
  await db.batch(
    changes.map(([k, open]) =>
      db
        .prepare(`INSERT INTO class_state (class_key, open, since) VALUES (?, ?, ?)
                  ON CONFLICT (class_key) DO UPDATE SET open = excluded.open, since = excluded.since`)
        .bind(k, open ? 1 : 0, t),
    ),
  );
}
