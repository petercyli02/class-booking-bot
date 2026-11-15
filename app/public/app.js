// classwatch - front end (no build step)

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
};

const state = {
  providers: [],
  provider: null,
  weekStart: null,     // "YYYY-MM-DD" (Monday, provider-local)
  day: null,           // selected "YYYY-MM-DD"
  classes: new Map(),  // weekKey -> FitnessClass[]
  watches: new Map(),  // key -> Watch
  watchState: {},
  maxWatches: 50,
  filter: "all",
  query: "",
  key: store.get("cw:key"),
  pending: null,       // action to resume after entering access key
};

// ---------------------------------------------------------------- dates ---

const tz = () => state.provider?.timezone ?? "Europe/London";
const localDay = (d = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: tz() }).format(d);
const addDays = (day, n) => {
  const d = new Date(day + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const mondayOf = (day) => addDays(day, -((new Date(day + "T12:00:00Z").getUTCDay() + 6) % 7));
const fmt = (iso, opts) => new Intl.DateTimeFormat("en-GB", { timeZone: tz(), ...opts }).format(new Date(iso));
const fmtTime = (iso) => fmt(iso, { hour: "2-digit", minute: "2-digit" });
const fmtDayShort = (day) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" }).format(new Date(day + "T12:00:00Z"));

// ------------------------------------------------------------------ api ---

async function api(path, { method = "GET", body, auth = false } = {}) {
  const headers = {};
  if (body) headers["content-type"] = "application/json";
  if (auth && state.key) headers.authorization = `Bearer ${state.key}`;
  const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// --------------------------------------------------------------- toasts ---

let toastTimer;
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2800);
}

// ---------------------------------------------------------------- data ---

const weekKey = () => `${state.provider.id}:${state.weekStart}`;

async function loadWeek() {
  const key = weekKey();
  if (state.classes.has(key)) return render();
  renderSkeleton();
  try {
    const { classes } = await api(
      `/api/classes?provider=${encodeURIComponent(state.provider.id)}&from=${state.weekStart}&to=${addDays(state.weekStart, 6)}`,
    );
    state.classes.set(key, classes);
  } catch (e) {
    state.classes.delete(key);
    $("#list").innerHTML = `<div class="empty"><strong>Couldn't load classes</strong>${escapeHtml(e.message)}</div>`;
    return;
  }
  if (key === weekKey()) render();
}

async function loadWatches() {
  if (!state.key) return renderWatchCount();
  try {
    const data = await api("/api/watches", { auth: true });
    state.watches = new Map(data.watches.map((w) => [w.key, w]));
    state.watchState = data.state || {};
    state.maxWatches = data.maxWatches || 50;
  } catch (e) {
    if (e.status === 401) {
      state.key = null;
      store.set("cw:key", null);
    }
  }
  render();
}

// --------------------------------------------------------------- render ---

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const BELL = `<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 0 1-3.46 0"/></svg>`;
const X = `<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>`;

function status(c) {
  if (!c.bookable) return { cls: "soon", label: c.opensAt ? `Opens ${fmt(c.opensAt, { weekday: "short", hour: "2-digit", minute: "2-digit" })}` : "Opens soon" };
  if (c.full) return { cls: "full", label: "Full" };
  if (c.spots <= 3) return { cls: "low", label: `${c.spots} left` };
  return { cls: "open", label: `${c.spots} left` };
}

function renderWeekHeader() {
  const today = localDay();
  const thisWeek = mondayOf(today);
  const diff = Math.round((Date.parse(state.weekStart) - Date.parse(thisWeek)) / 604800000);
  $("#week-label").textContent =
    diff === 0 ? "This week" : diff === 1 ? "Next week" : diff === -1 ? "Last week" : `Week of ${fmtDayShort(state.weekStart)}`;
  $("#prev-week").disabled = diff <= 0;

  const watchedDays = new Set([...state.watches.values()].map((w) => localDay(new Date(w.start))));
  $("#days").innerHTML = Array.from({ length: 7 }, (_, i) => {
    const day = addDays(state.weekStart, i);
    const d = new Date(day + "T12:00:00Z");
    const dow = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short" }).format(d);
    const cls = ["day", day === today && "today", day < today && "past"].filter(Boolean).join(" ");
    return `<button class="${cls}" role="tab" data-day="${day}" aria-selected="${day === state.day}">
      <span class="dow">${dow}</span><span class="num">${d.getUTCDate()}</span>
      ${watchedDays.has(day) ? '<span class="dot" aria-label="watching a class"></span>' : ""}
    </button>`;
  }).join("");
}

function renderSkeleton() {
  renderWeekHeader();
  $("#list").innerHTML = Array.from({ length: 5 }, () => '<div class="skeleton"></div>').join("");
}

function render() {
  if (!state.provider) return;
  renderWeekHeader();
  renderWatchCount();
  renderDrawer();

  const all = state.classes.get(weekKey());
  if (!all) return;
  const q = state.query.trim().toLowerCase();
  const now = Date.now();
  const list = all
    .filter((c) => localDay(new Date(c.start)) === state.day)
    .filter((c) => !q || c.name.toLowerCase().includes(q))
    .filter((c) => state.filter === "all" || (state.filter === "full" ? c.full : !c.full && c.bookable));

  if (!list.length) {
    const msg = all.some((c) => localDay(new Date(c.start)) === state.day)
      ? ["No matches", "Try a different search or filter."]
      : ["No classes", `Nothing scheduled on ${fmtDayShort(state.day)}.`];
    $("#list").innerHTML = `<div class="empty"><strong>${msg[0]}</strong>${msg[1]}</div>`;
    return;
  }

  $("#list").innerHTML = list.map((c) => {
    const s = status(c);
    const past = new Date(c.start).getTime() <= now;
    const watched = state.watches.has(c.key);
    const pct = c.capacity ? Math.min(100, Math.round((c.booked / c.capacity) * 100)) : 0;
    const barCls = c.full ? "full" : s.cls === "low" ? "low" : "";
    return `<article class="card${watched ? " watched" : ""}${past ? " past" : ""}">
      <div class="time"><strong>${fmtTime(c.start)}</strong><span>${c.durationMin} min</span></div>
      <div class="info">
        <div class="name" title="${escapeHtml(c.name)}">${escapeHtml(c.name)}</div>
        <div class="meta">
          <span class="bar ${barCls}"><i style="width:${pct}%"></i></span>
          <span class="cap">${c.booked}/${c.capacity} booked</span>
        </div>
      </div>
      <div class="right">
        <span class="chip ${s.cls}">${s.label}</span>
        <button class="watch" data-key="${escapeHtml(c.key)}" aria-pressed="${watched}"
          aria-label="${watched ? "Stop watching" : "Watch"} ${escapeHtml(c.name)} at ${fmtTime(c.start)}"
          title="${watched ? "Watching - tap to stop" : c.full ? "Notify me when a spot opens" : "Watch this class"}"
          ${past ? "disabled" : ""}>${BELL}</button>
      </div>
    </article>`;
  }).join("");
}

function renderWatchCount() {
  const n = state.watches.size;
  const el = $("#watch-count");
  el.textContent = n;
  el.classList.toggle("has", n > 0);
}

function liveClass(key) {
  for (const list of state.classes.values()) {
    const c = list.find((x) => x.key === key);
    if (c) return c;
  }
  return null;
}

function renderDrawer() {
  const items = [...state.watches.values()].sort((a, b) => a.start.localeCompare(b.start));
  $("#drawer-sub").textContent = !state.key
    ? "Add your access key in Settings to start watching."
    : `${items.length} of ${state.maxWatches} - you'll get a push the moment a spot opens.`;
  $("#watch-list").innerHTML = items.length
    ? items.map((w) => {
        const c = liveClass(w.key);
        const s = c ? status(c) : state.watchState[w.key] ? (state.watchState[w.key].open ? { cls: "open", label: "Open" } : { cls: "full", label: "Full" }) : null;
        return `<li class="watch-item">
          <div class="name">${escapeHtml(w.name)}</div>
          <div class="actions">
            ${s ? `<span class="chip ${s.cls}">${s.label}</span>` : ""}
            ${w.bookUrl ? `<a href="${escapeHtml(w.bookUrl)}" target="_blank" rel="noopener">Book</a>` : ""}
            <button class="btn icon ghost" data-unwatch="${escapeHtml(w.key)}" aria-label="Stop watching ${escapeHtml(w.name)}">${X}</button>
          </div>
          <div class="when">${fmt(w.start, { weekday: "short", day: "numeric", month: "short" })} · ${fmtTime(w.start)}</div>
        </li>`;
      }).join("")
    : `<li class="empty"><strong>Nothing yet</strong>Tap the bell on a full class.</li>`;
}

// -------------------------------------------------------------- actions ---

function findClass(key) {
  return (state.classes.get(weekKey()) || []).find((c) => c.key === key) || liveClass(key);
}

async function toggleWatch(key) {
  if (!state.key) {
    state.pending = () => toggleWatch(key);
    return openSettings();
  }
  const watching = state.watches.has(key);
  const c = findClass(key);
  try {
    let data;
    if (watching) {
      data = await api(`/api/watches/${encodeURIComponent(key)}`, { method: "DELETE", auth: true });
      toast("Stopped watching");
    } else {
      if (!c) return;
      data = await api("/api/watches", { method: "POST", auth: true, body: c });
      toast(c.full ? "Watching - we'll ping you when a spot opens" : "Watching - we'll ping you if it fills and a spot frees up");
    }
    state.watches = new Map(data.watches.map((w) => [w.key, w]));
    render();
  } catch (e) {
    if (e.status === 401) {
      state.key = null;
      store.set("cw:key", null);
      state.pending = () => toggleWatch(key);
      return openSettings("That access key didn't work.");
    }
    toast(e.message);
  }
}

// ------------------------------------------------------------- settings ---

function openSettings(msg = "") {
  $("#access-key").value = state.key || "";
  setMsg(msg, msg ? "err" : "");
  $("#settings").showModal();
  $("#access-key").focus();
}

function setMsg(text, cls = "") {
  const el = $("#settings-msg");
  el.textContent = text;
  el.className = `form-msg ${cls}`;
}

async function saveKey(e) {
  e.preventDefault();
  const key = $("#access-key").value.trim();
  if (!key) return;
  const prev = state.key;
  state.key = key;
  try {
    await api("/api/auth", { auth: true });
  } catch (err) {
    state.key = prev;
    return setMsg(err.status === 401 ? "That access key didn't work." : err.message, "err");
  }
  store.set("cw:key", key);
  $("#settings").close();
  await loadWatches();
  const next = state.pending;
  state.pending = null;
  if (next) next();
  else toast("Saved");
}

async function testNotify() {
  const key = $("#access-key").value.trim();
  if (!key) return setMsg("Enter your access key first.", "err");
  const prev = state.key;
  state.key = key;
  try {
    await api("/api/test-notify", { method: "POST", auth: true });
    setMsg("Sent - check your phone.", "ok");
  } catch (err) {
    setMsg(err.message, "err");
  } finally {
    state.key = prev;
  }
}

// --------------------------------------------------------------- drawer ---

function openDrawer() {
  renderDrawer();
  $("#scrim").hidden = false;
  $("#drawer").hidden = false;
  $("#drawer [data-close]").focus();
}
function closeDrawer() {
  $("#scrim").hidden = true;
  $("#drawer").hidden = true;
}

// ----------------------------------------------------------------- init ---

function setWeek(weekStart, day) {
  state.weekStart = weekStart;
  const today = localDay();
  state.day = day || (weekStart === mondayOf(today) ? today : weekStart);
  loadWeek();
}

function bind() {
  $("#days").addEventListener("click", (e) => {
    const b = e.target.closest("[data-day]");
    if (!b) return;
    state.day = b.dataset.day;
    render();
  });
  $("#prev-week").addEventListener("click", () => setWeek(addDays(state.weekStart, -7)));
  $("#next-week").addEventListener("click", () => setWeek(addDays(state.weekStart, 7)));
  $("#today").addEventListener("click", () => setWeek(mondayOf(localDay())));

  $("#search").addEventListener("input", (e) => {
    state.query = e.target.value;
    render();
  });
  $$(".segmented button").forEach((b) =>
    b.addEventListener("click", () => {
      state.filter = b.dataset.filter;
      $$(".segmented button").forEach((x) => x.setAttribute("aria-checked", String(x === b)));
      render();
    }),
  );

  $("#list").addEventListener("click", (e) => {
    const b = e.target.closest(".watch");
    if (b && !b.disabled) toggleWatch(b.dataset.key);
  });
  $("#watch-list").addEventListener("click", (e) => {
    const b = e.target.closest("[data-unwatch]");
    if (b) toggleWatch(b.dataset.unwatch);
  });

  $("#provider").addEventListener("change", (e) => {
    state.provider = state.providers.find((p) => p.id === e.target.value);
    store.set("cw:provider", state.provider.id);
    setWeek(mondayOf(localDay()));
  });

  $("#open-watching").addEventListener("click", openDrawer);
  $("#scrim").addEventListener("click", closeDrawer);
  $("#drawer [data-close]").addEventListener("click", closeDrawer);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("#drawer").hidden) closeDrawer();
  });

  $("#open-settings").addEventListener("click", () => openSettings());
  $("#settings-form").addEventListener("submit", saveKey);
  $("#settings-cancel").addEventListener("click", () => {
    state.pending = null;
    $("#settings").close();
  });
  $("#test-notify").addEventListener("click", testNotify);

  // Refresh availability when coming back to the tab.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && state.provider) {
      state.classes.delete(weekKey());
      loadWeek();
    }
  });
}

async function init() {
  bind();
  try {
    state.providers = await api("/api/providers");
  } catch (e) {
    $("#list").innerHTML = `<div class="empty"><strong>Couldn't start</strong>${escapeHtml(e.message)}</div>`;
    return;
  }
  const saved = store.get("cw:provider");
  state.provider = state.providers.find((p) => p.id === saved) || state.providers[0];
  $("#provider").innerHTML = state.providers
    .map((p) => `<option value="${p.id}" ${p.id === state.provider.id ? "selected" : ""}>${escapeHtml(p.name)} · ${escapeHtml(p.location)}</option>`)
    .join("");
  setWeek(mondayOf(localDay()));
  loadWatches();
}

init();
