export interface Notification {
  title: string;
  body: string;
  link?: string;
}

export interface NotifyEnv {
  TELEGRAM_BOT_TOKEN?: string;
  /** Optional fallback for the owner if they haven't connected Telegram in the app. */
  TELEGRAM_CHAT_ID?: string;
  RESEND_API_KEY?: string;
  /** Owner's address. A secret so it never reaches any browser. */
  EMAIL_TO?: string;
  /** Optional. Without your own verified domain, Resend only allows onboarding@resend.dev. */
  EMAIL_FROM?: string;
}

/** Who to notify and how. Email is only ever used for the owner. */
export interface Recipient {
  is_owner: number;
  telegram_chat_id: string | null;
  notify_telegram: number;
  notify_email: number;
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
  detail?: string;
}

export const botReady = (env: NotifyEnv) => Boolean(env.TELEGRAM_BOT_TOKEN?.trim());
export const emailReady = (env: NotifyEnv) => Boolean(env.RESEND_API_KEY?.trim() && env.EMAIL_TO?.trim());

export function chatIdFor(env: NotifyEnv, r: Recipient): string | null {
  return r.telegram_chat_id || (r.is_owner ? env.TELEGRAM_CHAT_ID?.trim() || null : null);
}

/** Sends on each of the recipient's enabled channels. ok = at least one delivered. */
export async function notifyRecipient(env: NotifyEnv, r: Recipient, n: Notification): Promise<NotifyResult> {
  const jobs: Promise<ChannelResult>[] = [];

  if (r.notify_telegram) {
    const chatId = chatIdFor(env, r);
    jobs.push(
      !botReady(env)
        ? Promise.resolve({ channel: "telegram", ok: false, detail: "the app's Telegram bot isn't set up yet" })
        : !chatId
          ? Promise.resolve({ channel: "telegram", ok: false, detail: "Telegram isn't connected - tap Connect" })
          : telegram(env.TELEGRAM_BOT_TOKEN!.trim(), chatId, n),
    );
  }
  // Owner-only.
  if (r.is_owner && r.notify_email) {
    jobs.push(
      emailReady(env)
        ? email(env.RESEND_API_KEY!.trim(), env.EMAIL_FROM?.trim() || "classwatch <onboarding@resend.dev>", env.EMAIL_TO!.trim(), n)
        : Promise.resolve({ channel: "email", ok: false, detail: "RESEND_API_KEY and EMAIL_TO secrets aren't both set on the Worker" }),
    );
  }

  if (!jobs.length) return { ok: false, results: [], detail: "no notification channel is turned on" };
  const results = await Promise.all(jobs);
  const ok = results.some((x) => x.ok);
  return { ok, results, detail: ok ? undefined : results.map((x) => `${x.channel}: ${x.detail}`).join("; ") };
}

// ------------------------------------------------------------- telegram ---

async function telegram(token: string, chatId: string, n: Notification): Promise<ChannelResult> {
  const payload: Record<string, unknown> = { chat_id: chatId, text: `${n.title}\n${n.body}`, disable_web_page_preview: true };
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

let botUsername: string | null = null;

export async function getBotUsername(token: string): Promise<string> {
  if (botUsername) return botUsername;
  const res = await fetch(`https://api.telegram.org/bot${token.trim()}/getMe`);
  const data = (await res.json()) as { ok: boolean; description?: string; result?: { username: string } };
  if (!data.ok || !data.result) throw new Error(data.description ?? "couldn't reach the Telegram bot");
  return (botUsername = data.result.username);
}

/** Looks for "/start <code>" (or just the code) sent to the bot and returns that chat's id. */
export async function findChatForCode(token: string, code: string): Promise<string | null> {
  const res = await fetch(`https://api.telegram.org/bot${token.trim()}/getUpdates?allowed_updates=%5B%22message%22%5D`);
  const data = (await res.json()) as {
    ok: boolean;
    description?: string;
    result?: { message?: { text?: string; chat: { id: number } } }[];
  };
  if (!data.ok) throw new Error(data.description ?? "Telegram error");
  for (const u of (data.result ?? []).reverse()) {
    const text = (u.message?.text ?? "").trim().replace(/^\/start(@\w+)?\s+/i, "");
    if (u.message && text === code) return String(u.message.chat.id);
  }
  return null;
}

export async function sendText(token: string, chatId: string, text: string) {
  await fetch(`https://api.telegram.org/bot${token.trim()}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  }).catch(() => {});
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
      body: JSON.stringify({ from, to: [to], subject: n.title, text: `${n.body}${n.link ? `\n\nBook: ${n.link}` : ""}`, html }),
    });
    if (res.ok) return { channel: "email", ok: true };
    const data = (await res.json().catch(() => ({}))) as { message?: string };
    console.error(`resend ${res.status}: ${data.message ?? ""}`);
    return { channel: "email", ok: false, detail: `Resend replied ${res.status}${data.message ? `: ${data.message}` : ""}` };
  } catch (e) {
    return { channel: "email", ok: false, detail: `Resend unreachable: ${(e as Error).message}` };
  }
}
