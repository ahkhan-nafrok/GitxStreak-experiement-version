// popup.js — entry point. Wires up tab switching (including the Settings
// gear toggle) and initializes all three views.
//
// This pass: added first-run/degraded-token awareness at the shell level.
// popup.js itself does NOT lock any tab — Pulse and Settings already own
// their own empty/degraded states. What lives here is the shared stuff:
//   - a badge dot on the gear when there's no token OR the saved token is
//     failing auth, so it's visible before the user even opens a tab
//   - listening for 'gitstreak:open-settings' (dispatched by Pulse's CTA)
//     to open Settings and focus the token input
//   - listening for 'gitstreak:token-saved' (dispatched by settingsView.js)
//     to force the return-from-Settings destination to Pulse specifically,
//     regardless of whichever tab was active before Settings was opened
//   - listening for 'gitstreak:auth-changed' (dispatched by settingsView.js
//     and, on a 401, by pulseView.js/projectsView.js) to refresh the badge
import { initPulseView } from "./pulseView.js";
import { initProjectsView } from "./projectsView.js";
import { initSettingsView } from "./settingsView.js";
import { initToast } from "./toast.js";
import { getToken } from "./lib/tokenVault.js";
import { getAuthFailed } from "./lib/authState.js";
import { chromeStorageAdapter } from "./lib/storageAdapter.js";

function initTabs() {
  const tabBtns = document.querySelectorAll(".tab-btn");
  const panels = document.querySelectorAll(".tab-panel");
  const tabsMain = document.getElementById("tabs-main");
  const settingsNavLabel = document.getElementById("settings-nav-label");
  const settingsToggleBtn = document.getElementById("settings-toggle-btn");
  const settingsBadgeDot = document.getElementById("settings-badge-dot");
  const tokenInput = document.getElementById("settings-token-input");

  let lastMainTab = "pulse";

  function activatePanel(tabName) {
    panels.forEach((p) => p.classList.remove("active"));
    const panel = document.getElementById(`tab-${tabName}`);
    if (panel) panel.classList.add("active");
  }

  function setActiveTabBtn(tabName) {
    tabBtns.forEach((b) => {
      const isActive = b.dataset.tab === tabName;
      b.classList.toggle("active", isActive);
      b.setAttribute("aria-selected", String(isActive));
    });
  }

  function isInSettings() {
    return settingsToggleBtn.classList.contains("is-back");
  }

  function openSettings() {
    if (isInSettings()) return;
    const currentActive = document.querySelector(".tab-btn.active");
    lastMainTab = currentActive ? currentActive.dataset.tab : "pulse";
    settingsToggleBtn.classList.add("is-back");
    settingsToggleBtn.setAttribute("aria-label", "Back");
    settingsToggleBtn.title = "Back";
    tabsMain.hidden = true;
    settingsNavLabel.hidden = false;
    activatePanel("settings");
  }

  function closeSettings(destinationTab = lastMainTab) {
    if (!isInSettings()) return;
    settingsToggleBtn.classList.remove("is-back");
    settingsToggleBtn.setAttribute("aria-label", "Settings");
    settingsToggleBtn.title = "Settings";
    tabsMain.hidden = false;
    settingsNavLabel.hidden = true;
    setActiveTabBtn(destinationTab);
    activatePanel(destinationTab);
  }

  tabBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      const tabName = btn.dataset.tab;
      lastMainTab = tabName;
      setActiveTabBtn(tabName);
      activatePanel(tabName);
    });
  });

  settingsToggleBtn.addEventListener("click", () => {
    if (isInSettings()) closeSettings();
    else openSettings();
  });

  // Pulse's "Connect GitHub" CTA (and any future one) dispatches this
  // instead of reaching into popup.js's internals directly.
  window.addEventListener("gitstreak:open-settings", () => {
    openSettings();
    tokenInput?.focus();
  });

  // A successful save always lands back on Pulse — the default/home tab —
  // regardless of which tab was active when Settings was opened. Simplest
  // possible rule for a first-run user, and no-op for anyone who was
  // already on Pulse anyway.
  window.addEventListener("gitstreak:token-saved", () => {
    lastMainTab = "pulse";
    closeSettings("pulse");
  });

  async function refreshBadge() {
    const [token, authFailed] = await Promise.all([
      getToken(chromeStorageAdapter),
      getAuthFailed(chromeStorageAdapter),
    ]);
    const needsAttention = !token || authFailed;
    if (settingsBadgeDot) settingsBadgeDot.hidden = !needsAttention;
  }

  window.addEventListener("gitstreak:auth-changed", refreshBadge);
  refreshBadge();
}

initToast();
initTabs();
initPulseView();
initProjectsView();
initSettingsView();