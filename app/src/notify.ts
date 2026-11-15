export interface Notification {
  title: string;
  body: string;
  link?: string;
}

export interface NotifyResult {
  ok: boolean;
  /** Human-readable reason when ok is false */
  detail?: string;
}

/** Accepts "topic", " topic ", "ntfy.sh/topic" or "https://ntfy.sh/topic". */
function cleanTopic(raw: string | undefined): string {
  return (raw ?? "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/^ntfy\.sh\//i, "")
    .replace(/\/+$/, "");
}

/** Push via ntfy (https://ntfy.sh). */
export async function notify(rawTopic: string | undefined, n: Notification): Promise<NotifyResult> {
  const topic = cleanTopic(rawTopic);
  if (!topic) {
    console.warn("NTFY_TOPIC not set - skipping notification");
    return { ok: false, detail: "NTFY_TOPIC is not set on the Worker (runtime secret)" };
  }
  if (!/^[\w-]{1,64}$/.test(topic)) {
    return { ok: false, detail: "NTFY_TOPIC has invalid characters - use only letters, numbers, - and _" };
  }

  const headers: Record<string, string> = {
    Title: n.title,
    Priority: "urgent",
    Tags: "runner",
  };
  if (n.link) {
    headers.Click = n.link;
    headers.Actions = `view, Book now, ${n.link}`;
  }
  try {
    const res = await fetch(`https://ntfy.sh/${topic}`, { method: "POST", body: n.body, headers });
    if (res.ok) return { ok: true };
    const text = (await res.text().catch(() => "")).slice(0, 200);
    console.error(`ntfy ${res.status}: ${text}`);
    return { ok: false, detail: `ntfy.sh replied ${res.status}${text ? `: ${text}` : ""}` };
  } catch (e) {
    console.error("ntfy failed", e);
    return { ok: false, detail: `could not reach ntfy.sh: ${(e as Error).message}` };
  }
}
