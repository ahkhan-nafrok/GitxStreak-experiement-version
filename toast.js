// toast.js
// A single shared toast, used across views for non-blocking notices — most
// notably "your GitHub token stopped working" from Pulse's Update button
// and Projects' Check-for-Updates button. Deliberately a toast, not a
// modal: the underlying cached data is still fully usable when this fires,
// so blocking interaction with a modal would overstate the severity.
//
// This pass: added an optional `key` per call. If a caller fires the same
// key while that toast is still visible, the call is now a no-op instead
// of restarting the fade-in and resetting the auto-dismiss timer. Without
// this, hammering the Update button on a dead token (an entirely plausible
// thing to do) made the toast flicker on every click and could keep its
// countdown from ever actually reaching zero.

let toastEl, msgEl, actionEl, hideTimer;
let activeKey = null;

export function initToast() {
  toastEl = document.getElementById("app-toast");
  msgEl = document.getElementById("app-toast-msg");
  actionEl = document.getElementById("app-toast-action");
}

/**
 * @param {string} message
 * @param {{ actionLabel?: string, onAction?: () => void, duration?: number, key?: string }} [opts]
 */
export function showToast(message, opts = {}) {
  if (!toastEl) return;

  const isVisible = toastEl.classList.contains("is-visible");
  if (opts.key && isVisible && opts.key === activeKey) {
    // Same notice, already on screen — leave it exactly as it is rather
    // than restarting the animation/timer on every repeat trigger.
    return;
  }
  activeKey = opts.key || null;

  clearTimeout(hideTimer);

  msgEl.textContent = message;
  if (opts.actionLabel) {
    actionEl.textContent = opts.actionLabel;
    actionEl.hidden = false;
    actionEl.onclick = () => {
      opts.onAction?.();
      hideToast();
    };
  } else {
    actionEl.hidden = true;
    actionEl.onclick = null;
  }

  toastEl.hidden = false;
  requestAnimationFrame(() => toastEl.classList.add("is-visible"));
  hideTimer = setTimeout(hideToast, opts.duration ?? 6000);
}

function hideToast() {
  if (!toastEl) return;
  clearTimeout(hideTimer);
  activeKey = null;
  toastEl.classList.remove("is-visible");
  setTimeout(() => {
    if (!toastEl.classList.contains("is-visible")) toastEl.hidden = true;
  }, 220);
}