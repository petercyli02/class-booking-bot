export interface Notification {
  title: string;
  body: string;
  link?: string;
}

/** Push via ntfy (https://ntfy.sh). Returns true if delivered to the ntfy server. */
export async function notify(topic: string | undefined, n: Notification): Promise<boolean> {
  if (!topic) {
    console.warn("NTFY_TOPIC not set - skipping notification");
    return false;
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
    const res = await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
      method: "POST",
      body: n.body,
      headers,
    });
    if (!res.ok) console.error(`ntfy ${res.status}`);
    return res.ok;
  } catch (e) {
    console.error("ntfy failed", e);
    return false;
  }
}
