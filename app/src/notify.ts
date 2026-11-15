import type { NotifySettings } from "./store";

export interface Notification {
  title: string;
  body: string;
  link?: string;
}

export interface NotifyEnv {
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  RESEND_API_KEY?: string;
  /** Optional. Without your own verified domain, Resend only allows onboarding@resend.dev. */
  EMAIL_FROM?: string;
}

export type Channel = "telegram" | "email";

export interface ChannelResult {
  channel: Channel;
  ok: boolean;
  detail?: string;
}

export interface NotifyResult {
  ok: boolean;
  results: ChannelResult[];
  /** Human-readable summary when ok is false */
  detail?: string;
}

/** Which channels have the secrets they need. */
export function configured(env: NotifyEnv) {
  return {
    telegram: Boolean(env.TELEGRAM_BOT_TOKEN?.trim() && env.TELEGRAM_CHAT_ID?.trim()),
    email: Boolean(env.RESEND_API_KEY?.trim()),
  };
}

/** Sends on every enabled channel. ok = at least one delivered. */
export async function notify(env: NotifyEnv, settings: NotifySettings, n: Notification): Promise<NotifyResult> {
  const ready = configured(env);
  const jobs: Promise<ChannelResult>[] = [];

  if (settings.telegram.enabled) {
    jobs.push(
      ready.telegram
        ? telegram(env.TELEGRAM_BOT_TOKEN!.trim(), env.TELEGRAM_CHAT_ID!.trim(), n)
        : Promise.resolve({ channel: "telegram", ok: false, detail: "TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID secrets not set" }),
    );
  }
  if (settings.email.enabled) {
    jobs.push(
      !ready.email
        ? Promise.resolve({ channel: "email", ok: false, detail: "RESEND_API_KEY secret not set" })
        : !settings.email.to
          ? Promise.resolve({ channel: "email", ok: false, detail: "no email address saved" })
          : email(env.RESEND_API_KEY!.trim(), env.EMAIL_FROM?.trim() || "classwatch <onboarding@resend.dev>", settings.email.to, n),
    );
  }

  if (!jobs.length) return { ok: false, results: [], detail: "no notification channel is ticked in Settings" };
  const results = await Promise.all(jobs);
  const ok = results.some((r) => r.ok);
  const detail = ok ? undefined : results.map((r) => `${r.channel}: ${r.detail}`).join("; ");
  return { ok, results, detail };
}

// ------------------------------------------------------------- telegram ---

async function telegram(token: string, chatId: string, n: Notification): Promise<ChannelResult> {
  const payload: Record<string, unknown> = {
    chat_id: chatId,
    text: `${n.title}\n${n.body}`,
    disable_web_page_preview: true,
  };
  if (n.link?.startsWith("https://")) payload.reply_markup = { inline_keyboard: [[{ text: "Book now", url: n.link }]] };
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res.ok) return { channel: "telegram", ok: true };
    const data = (await res.json().catch(() => ({}))) as { description?: string };
    console.error(`telegram ${res.status}: ${data.description ?? ""}`);
    return { channel: "telegram", ok: false, detail: `Telegram replied ${res.status}${data.description ? `: ${data.description}` : ""}` };
  } catch (e) {
    return { channel: "telegram", ok: false, detail: `Telegram unreachable: ${(e as Error).message}` };
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

// ---------------------------------------------------------------- email ---

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

async function email(apiKey: string, from: string, to: string, n: Notification): Promise<ChannelResult> {
  const html = `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5">
    <p style="margin:0 0 4px;font-weight:600">${esc(n.title)}</p>
    <p style="margin:0 0 16px">${esc(n.body)}</p>
    ${n.link ? `<a href="${esc(n.link)}" style="display:inline-block;background:#16a34a;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600">Book now</a>` : ""}
  </div>`;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        from,
        to: [to],
        subject: n.title,
        text: `${n.body}${n.link ? `\n\nBook: ${n.link}` : ""}`,
        html,
      }),
    });
    if (res.ok) return { channel: "email", ok: true };
    const data = (await res.json().catch(() => ({}))) as { message?: string };
    console.error(`resend ${res.status}: ${data.message ?? ""}`);
    return { channel: "email", ok: false, detail: `Resend replied ${res.status}${data.message ? `: ${data.message}` : ""}` };
  } catch (e) {
    return { channel: "email", ok: false, detail: `Resend unreachable: ${(e as Error).message}` };
  }
}
