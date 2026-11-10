/** Shared client helpers. No framework, no build step. */

export const GLYPHS = ["▲", "◆", "●", "■", "★", "✚"];

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function show(el, visible = true) {
  if (el) el.hidden = !visible;
}

export function text(el, value) {
  if (el && el.textContent !== String(value)) el.textContent = String(value);
}

export async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

/** Renders the shared passcode treatment one digit per flap. */
export function renderPasscode(el, code) {
  if (!el) return;
  el.innerHTML = "";
  for (const ch of String(code)) {
    const span = document.createElement("span");
    span.textContent = ch;
    el.append(span);
  }
}

/**
 * The segmented shot-clock. Driven by the server's absolute `endsAt` so every
 * screen in the room agrees, and so a tab that was backgrounded catches up
 * instead of drifting.
 */
export function createClock(root) {
  const track = $(".clock-track", root);
  const digits = $(".clock-digits", root);
  const SEGMENTS = 20;
  let frame = null;

  track.innerHTML = "";
  for (let i = 0; i < SEGMENTS; i++) {
    const seg = document.createElement("div");
    seg.className = "clock-seg";
    track.append(seg);
  }
  const segs = [...track.children];

  function paint(remaining, total) {
    const ratio = total > 0 ? Math.max(0, Math.min(1, remaining / total)) : 0;
    const lit = Math.ceil(ratio * SEGMENTS);
    segs.forEach((seg, i) => {
      seg.dataset.spent = i < SEGMENTS - lit ? "true" : "false";
    });
    const seconds = Math.max(0, Math.ceil(remaining / 1000));
    text(digits, seconds);
    root.classList.toggle("is-urgent", remaining <= 5000);
  }

  return {
    start(endsAt, totalSeconds) {
      this.stop();
      const total = totalSeconds * 1000;
      const tick = () => {
        paint(endsAt - Date.now(), total);
        frame = requestAnimationFrame(tick);
      };
      tick();
    },
    stop() {
      if (frame) cancelAnimationFrame(frame);
      frame = null;
    },
    freeze(remaining, totalSeconds) {
      this.stop();
      paint(remaining, totalSeconds * 1000);
    },
  };
}

/**
 * A reconnecting WebSocket. Games outlive flaky phone wifi, so a drop is
 * treated as normal and retried with a backoff rather than surfaced as a fault.
 */
export function connect(path, { onState, onMessage, onStatus } = {}) {
  let ws = null;
  let attempt = 0;
  let closed = false;
  const queue = [];

  function open() {
    const scheme = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${scheme}//${location.host}${path}`);

    ws.addEventListener("open", () => {
      attempt = 0;
      onStatus?.("open");
      while (queue.length) ws.send(queue.shift());
    });

    ws.addEventListener("message", (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.type === "state") onState?.(msg.state);
      else onMessage?.(msg);
    });

    ws.addEventListener("close", () => {
      if (closed) return;
      onStatus?.("reconnecting");
      attempt += 1;
      setTimeout(open, Math.min(8000, 400 * 2 ** attempt));
    });

    ws.addEventListener("error", () => ws.close());
  }

  open();

  return {
    send(msg) {
      const raw = JSON.stringify(msg);
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(raw);
      else queue.push(raw);
    },
    close() {
      closed = true;
      ws?.close();
    },
  };
}
