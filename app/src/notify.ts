export interface Notification {
  title: string;
  body: string;
  link?: string;
}

export interface NotifyResult {
  ok: boolean;
  /** Human-readable reason(s) when ok is false */
  detail?: string;
}

export interface NotifyEnv {
  NTFY_TOPIC?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
}

/**
 * Sends via every configured channel. ok = at least one channel delivered.
 * Telegram is the recommended channel on Cloudflare (ntfy.sh can time out from Workers).
 */
export async function notify(env: NotifyEnv, n: Notification): Promise<NotifyResult> {
  const attempts: Promise<NotifyResult & { channel: string }>[] = [];
  if (env.TELEGRAM_BOT_TOKEN?.trim() && env.TELEGRAM_CHAT_ID?.trim())
    attempts.push(telegram(env.TELEGRAM_BOT_TOKEN.trim(), env.TELEGRAM_CHAT_ID.trim(), n).then((r) => ({ ...r, channel: "Telegram" })));
  if (env.NTFY_TOPIC?.trim()) attempts.push(ntfy(env.NTFY_TOPIC, n).then((r) => ({ ...r, channel: "ntfy" })));

  if (!attempts.length) {
    return { ok: false, detail: "no channel configured - set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID (or NTFY_TOPIC) as runtime secrets" };
  }
  const results = await Promise.all(attempts);
  if (results.some((r) => r.ok)) return { ok: true };
  return { ok: false, detail: results.map((r) => `${r.channel}: ${r.detail}`).join("; ") };
}

// ------------------------------------------------------------- telegram ---

async function telegram(token: string, chatId: string, n: Notification): Promise<NotifyResult> {
  const payload: Record<string, unknown> = {
    chat_id: chatId,
    text: `${n.title}\n${n.body}`,
    disable_web_page_preview: true,
  };
  if (n.link) payload.reply_markup = { inline_keyboard: [[{ text: "Book now", url: n.link }]] };
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res.ok) return { ok: true };
    const data = (await res.json().catch(() => ({}))) as { description?: string };
    console.error(`telegram ${res.status}: ${data.description ?? ""}`);
    return { ok: false, detail: `replied ${res.status}${data.description ? `: ${data.description}` : ""}` };
  } catch (e) {
    return { ok: false, detail: `unreachable: ${(e as Error).message}` };
  }
}

/** Chats that have messaged the bot recently - used to find your chat id during setup. */
export async function telegramChats(token: string): Promise<{ id: number; name: string }[]> {
  const res = await fetch(`https://api.telegram.org/bot${token.trim()}/getUpdates`);
  const data = (await res.json()) as {
    ok: boolean;
    description?: string;
    result?: { message?: { chat: { id: number; first_name?: string; username?: string; title?: string } } }[];
  };
  if (!data.ok) throw new Error(data.description ?? `Telegram replied ${res.status}`);
  const chats = new Map<number, string>();
  for (const u of data.result ?? []) {
    const c = u.message?.chat;
    if (c) chats.set(c.id, c.title ?? c.username ?? c.first_name ?? String(c.id));
  }
  return [...chats].map(([id, name]) => ({ id, name }));
}

// ----------------------------------------------------------------- ntfy ---

/** Accepts "topic", " topic ", "ntfy.sh/topic" or "https://ntfy.sh/topic". */
function cleanTopic(raw: string): string {
  return raw.trim().replace(/^https?:\/\//i, "").replace(/^ntfy\.sh\//i, "").replace(/\/+$/, "");
}

async function ntfy(rawTopic: string, n: Notification): Promise<NotifyResult> {
  const topic = cleanTopic(rawTopic);
  if (!/^[\w-]{1,64}$/.test(topic)) return { ok: false, detail: "topic has invalid characters" };
  const headers: Record<string, string> = { Title: n.title, Priority: "urgent", Tags: "runner" };
  if (n.link) {
    headers.Click = n.link;
    headers.Actions = `view, Book now, ${n.link}`;
  }
  try {
    const res = await fetch(`https://ntfy.sh/${topic}`, { method: "POST", body: n.body, headers });
    if (res.ok) return { ok: true };
    const text = (await res.text().catch(() => "")).slice(0, 120);
    console.error(`ntfy ${res.status}: ${text}`);
    return { ok: false, detail: `replied ${res.status}${text ? `: ${text}` : ""}` };
  } catch (e) {
    return { ok: false, detail: `unreachable: ${(e as Error).message}` };
  }
}
