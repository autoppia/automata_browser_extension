const state = {
  authenticated: false,
  localOperatorAvailable: false,
  executionProvider: "local_operator",
  currentRun: null,
  sessions: [],
  activeSessionId: "",
  pollTimer: null,
  history: [],
  automations: [],
  recording: { active: false },
  operatorBaseUrl: "http://127.0.0.1:18060",
  activeView: "runs",
  pendingUserInput: null,
  errorHint: null,
  lastErrorHintKey: ""
};
let healthPollTimer = null;

const els = {
  compactLogoutBtn: document.getElementById("compactLogoutBtn"),
  navRunsBtn: document.getElementById("navRunsBtn"),
  navAutomationsBtn: document.getElementById("navAutomationsBtn"),
  runsView: document.getElementById("runsView"),
  automationsView: document.getElementById("automationsView"),
  sessionsList: document.getElementById("sessionsList"),
  newSessionNameInput: document.getElementById("newSessionNameInput"),
  newSessionBtn: document.getElementById("newSessionBtn"),
  authCard: document.getElementById("authCard"),
  apiKeyInput: document.getElementById("apiKeyInput"),
  connectBtn: document.getElementById("connectBtn"),
  logoutBtn: document.getElementById("logoutBtn"),
  promptInput: document.getElementById("promptInput"),
  startUrlInput: document.getElementById("startUrlInput"),
  operatorBaseInput: document.getElementById("operatorBaseInput"),
  saveOperatorBaseBtn: document.getElementById("saveOperatorBaseBtn"),
  startRunBtn: document.getElementById("startRunBtn"),
  cancelRunBtn: document.getElementById("cancelRunBtn"),
  automationNameInput: document.getElementById("automationNameInput"),
  recordStartBtn: document.getElementById("recordStartBtn"),
  recordStopBtn: document.getElementById("recordStopBtn"),
  recordingBadge: document.getElementById("recordingBadge"),
  automationsList: document.getElementById("automationsList"),
  clearHistoryBtn: document.getElementById("clearHistoryBtn"),
  promptMeta: document.getElementById("promptMeta"),
  statusLine: document.getElementById("statusLine"),
  errorHintCard: document.getElementById("errorHintCard"),
  errorHintTitle: document.getElementById("errorHintTitle"),
  errorHintText: document.getElementById("errorHintText"),
  errorHintActionBtn: document.getElementById("errorHintActionBtn"),
  errorHintDismissBtn: document.getElementById("errorHintDismissBtn"),
  userInputCard: document.getElementById("userInputCard"),
  userInputPrompt: document.getElementById("userInputPrompt"),
  userInputAnswer: document.getElementById("userInputAnswer"),
  userInputSendBtn: document.getElementById("userInputSendBtn"),
  historyList: document.getElementById("historyList")
};

function setStatus(text) {
  if (els.statusLine) {
    els.statusLine.textContent = text;
  }
}

function inferFailureCodeFromMessage(message) {
  const text = String(message || "").trim();
  const lowered = text.toLowerCase();
  if (!text) {
    return "run_failed";
  }
  if (lowered.includes("local_operator_unreachable")) return "local_operator_unreachable";
  if (lowered.includes("unsupported_tab_url")) return "unsupported_tab_url";
  if (lowered.includes("active_tab_not_found")) return "active_tab_not_found";
  if (lowered.includes("snapshot_failed")) return "snapshot_failed";
  if (lowered.includes("operator_act_error")) return "operator_http_error";
  if (lowered.includes("operator_error:")) return "operator_error";
  if (lowered.includes("operator returned no actions")) return "operator_no_actions";
  if (lowered.includes("navigation_failed")) return "navigation_failed";
  if (lowered.includes("start url must begin")) return "invalid_start_url";
  if (lowered.includes("prompt is required")) return "invalid_prompt";
  if (lowered.includes("tab_create_failed")) return "tab_create_failed";
  if (lowered.includes("step limit reached")) return "max_steps_reached";
  if (lowered.includes("workflow_step_failed")) return "workflow_step_failed";
  if (lowered.includes("workflow_not_found_or_empty")) return "workflow_not_found_or_empty";
  return "run_failed";
}

function normalizeFailure(failureLike) {
  const payload = failureLike && typeof failureLike === "object" ? failureLike : {};
  const message = String(payload.message || payload.error || "").trim();
  const code = String(payload.code || "").trim() || inferFailureCodeFromMessage(message);
  return {
    code,
    message: message || "Run failed",
    status: payload.status ?? null
  };
}

function buildHintFromFailure(failureLike) {
  const failure = normalizeFailure(failureLike);
  const message = failure.message;

  if (failure.code === "local_operator_unreachable") {
    return {
      code: failure.code,
      title: "Local operator is not reachable",
      text: "Start autoppia_operator and verify Operator URL (127.0.0.1:18060 or your machine IP:18060), then retry.",
      action: { type: "copy_operator_cmd", label: "Copy Start Command" }
    };
  }
  if (failure.code === "unsupported_tab_url" || failure.code === "active_tab_not_found") {
    return {
      code: failure.code,
      title: "Open a regular website first",
      text: "The extension needs an http/https tab. Open one and run again.",
      action: { type: "open_safe_page", label: "Open Example Page" }
    };
  }
  if (failure.code === "invalid_start_url") {
    return {
      code: failure.code,
      title: "Start URL format is invalid",
      text: "Use a URL that starts with http:// or https://.",
      action: { type: "clear_start_url", label: "Clear Start URL" }
    };
  }
  if (failure.code === "snapshot_failed") {
    return {
      code: failure.code,
      title: "Could not capture page snapshot",
      text: "Reload the current page and try again.",
      action: { type: "reload_active_tab", label: "Reload Current Tab" }
    };
  }
  if (failure.code === "operator_http_error") {
    return {
      code: failure.code,
      title: "Operator returned an HTTP error",
      text: message,
      action: { type: "open_operator_health", label: "Open Operator Health" }
    };
  }
  if (failure.code === "operator_error") {
    return {
      code: failure.code,
      title: "Operator returned an internal error",
      text: message,
      action: { type: "retry_run", label: "Retry Run" }
    };
  }
  if (failure.code === "operator_no_actions") {
    return {
      code: failure.code,
      title: "Operator returned no next step",
      text: "Agent returned no action and no final result. Retry or rephrase the prompt with clearer objective.",
      action: { type: "retry_run", label: "Retry Run" }
    };
  }
  if (failure.code === "max_steps_reached") {
    return {
      code: failure.code,
      title: "Step limit reached",
      text: "Refine the prompt or run again from a clearer page state.",
      action: { type: "retry_run", label: "Retry Run" }
    };
  }
  if (failure.code === "tab_create_failed") {
    return {
      code: failure.code,
      title: "Could not open a browser tab",
      text: "Try opening a website manually, then run again.",
      action: { type: "open_safe_page", label: "Open Example Page" }
    };
  }
  if (failure.code === "workflow_not_found_or_empty") {
    return {
      code: failure.code,
      title: "Workflow not available",
      text: "The selected workflow is missing or empty. Re-record it and try again.",
      action: { type: "focus_automations", label: "Open Automations" }
    };
  }
  if (failure.code === "workflow_step_failed") {
    return {
      code: failure.code,
      title: "Workflow step failed",
      text: "Agent takeover can continue from the current browser state.",
      action: { type: "retry_run", label: "Continue With Agent" }
    };
  }
  return {
    code: failure.code,
    title: "Run failed",
    text: message,
    action: { type: "retry_run", label: "Retry Run" }
  };
}

function setErrorHint(failureLike, source = "") {
  const hint = buildHintFromFailure(failureLike);
  const key = `${source}:${hint.code}:${hint.text}`;
  if (state.lastErrorHintKey === key) {
    return;
  }
  state.errorHint = hint;
  state.lastErrorHintKey = key;
  renderErrorHint();
}

function clearErrorHint(resetSignature = false) {
  state.errorHint = null;
  if (resetSignature) {
    state.lastErrorHintKey = "";
  }
  renderErrorHint();
}

function getFailureFromRun(run) {
  if (!run || String(run.status || "") !== "failed") {
    return null;
  }
  if (run.lastError && typeof run.lastError === "object") {
    return normalizeFailure(run.lastError);
  }
  const resultObj = run.result && typeof run.result === "object" ? run.result : {};
  return normalizeFailure({
    code: resultObj.error_code || "",
    message: String(resultObj.content || "Run failed")
  });
}

async function handleHintAction() {
  const hint = state.errorHint;
  const action = hint && hint.action ? hint.action : null;
  if (!action || !action.type) {
    return;
  }

  try {
    if (action.type === "copy_operator_cmd") {
      const cmd = "cd /home/usuario1/autoppia/operator/autoppia_operator && python -m uvicorn main:app --host 0.0.0.0 --port 18060";
      await navigator.clipboard.writeText(cmd);
      setStatus("Operator start command copied to clipboard");
      return;
    }
    if (action.type === "open_safe_page") {
      await chrome.tabs.create({ url: "https://example.com/", active: true });
      setStatus("Opened a regular website tab");
      return;
    }
    if (action.type === "clear_start_url") {
      if (els.startUrlInput) {
        els.startUrlInput.value = "";
        els.startUrlInput.focus();
      }
      setStatus("Start URL cleared");
      return;
    }
    if (action.type === "reload_active_tab") {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tab = tabs && tabs.length ? tabs[0] : null;
      if (tab && typeof tab.id === "number") {
        await chrome.tabs.reload(tab.id);
        setStatus("Reloaded active tab");
      }
      return;
    }
    if (action.type === "open_operator_health") {
      await chrome.tabs.create({ url: "http://127.0.0.1:18060/health", active: true });
      setStatus("Opened operator health endpoint");
      return;
    }
    if (action.type === "retry_run") {
      await startRun();
      return;
    }
    if (action.type === "focus_automations") {
      setActiveView("automations");
      if (els.automationNameInput) {
        els.automationNameInput.focus();
      }
      setStatus("Review or re-record workflows in Automations.");
    }
  } catch (error) {
    setStatus(`Hint action failed: ${error.message}`);
  }
}

function renderErrorHint() {
  if (!els.errorHintCard || !els.errorHintTitle || !els.errorHintText || !els.errorHintActionBtn) {
    return;
  }

  if (!state.errorHint) {
    els.errorHintCard.hidden = true;
    return;
  }

  els.errorHintTitle.textContent = String(state.errorHint.title || "Run failed");
  els.errorHintText.textContent = String(state.errorHint.text || "");
  const action = state.errorHint.action || null;
  if (!action || !action.label) {
    els.errorHintActionBtn.style.display = "none";
  } else {
    els.errorHintActionBtn.style.display = "";
    els.errorHintActionBtn.textContent = String(action.label);
  }
  els.errorHintCard.hidden = false;
}

function normalizeStatus(status) {
  const allowed = new Set(["running", "pending", "awaiting_input", "succeeded", "cancelled", "failed"]);
  return allowed.has(status) ? status : "pending";
}

function statusClass(status) {
  return `status-chip status-${normalizeStatus(status)}`;
}

function truncate(text, maxLen = 72) {
  if (!text) {
    return "";
  }
  return text.length > maxLen ? `${text.slice(0, maxLen)}...` : text;
}

function escapeHtml(text) {
  return String(text || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function toLegacyEvents(run) {
  if (!run || !Array.isArray(run.timeline)) {
    return [];
  }
  return run.timeline.map((item, index) => ({
    id: item.id || `legacy_${index}`,
    type: "legacy_step",
    title: String(item.title || "Step"),
    detail: "",
    status: String(item.status || "pending"),
    createdAt: item.createdAt || run.updatedAt || run.createdAt || new Date().toISOString()
  }));
}

function getRunEvents(run) {
  if (!run) {
    return [];
  }
  if (Array.isArray(run.events) && run.events.length) {
    return run.events;
  }
  return toLegacyEvents(run);
}

function shouldRenderEvent(event) {
  const payload = event && typeof event === "object" ? event : {};
  const type = String(payload.type || "").trim().toLowerCase();
  // Hide loop-internal planning markers from end-user timeline.
  if (type === "planning") {
    return false;
  }
  return true;
}

function canShowCloudAuth() {
  return state.executionProvider === "cloud";
}

function isRunActive(run) {
  if (!run) {
    return false;
  }
  return ["running", "pending", "awaiting_input"].includes(String(run.status || ""));
}

function setActiveView(viewName) {
  state.activeView = String(viewName || "runs") === "automations" ? "automations" : "runs";
  renderView();
}

function renderView() {
  const runsActive = state.activeView !== "automations";
  if (els.runsView) {
    els.runsView.classList.toggle("active", runsActive);
  }
  if (els.automationsView) {
    els.automationsView.classList.toggle("active", !runsActive);
  }
  if (els.navRunsBtn) {
    els.navRunsBtn.classList.toggle("active", runsActive);
  }
  if (els.navAutomationsBtn) {
    els.navAutomationsBtn.classList.toggle("active", !runsActive);
  }
}

function eventIconMeta(event) {
  const payload = event && typeof event === "object" ? event : {};
  const type = String(payload.type || "").trim().toLowerCase();
  const actionType = String(payload.data && payload.data.type ? payload.data.type : "").trim().toLowerCase();
  if (type === "reasoning") return { icon: "brain", className: "icon-reasoning", label: "Thoughts" };
  if (type === "planning") return { icon: "route", className: "icon-planning", label: "Planning" };
  if (type === "run_result") return { icon: "check", className: "icon-result", label: "Result" };
  if (type.includes("failed") || type.includes("error")) return { icon: "alert", className: "icon-error", label: "Error" };
  if (type === "action") {
    if (actionType.includes("reportresult") || actionType.includes("report_result")) return { icon: "check", className: "icon-result", label: "Result" };
    if (actionType.includes("click")) return { icon: "pointer", className: "icon-action", label: "Click" };
    if (actionType.includes("type") || actionType.includes("fill")) return { icon: "type", className: "icon-action", label: "Type" };
    if (actionType.includes("navigate")) return { icon: "compass", className: "icon-action", label: "Navigate" };
    if (actionType.includes("scroll")) return { icon: "scroll", className: "icon-action", label: "Scroll" };
    if (actionType.includes("wait")) return { icon: "clock", className: "icon-action", label: "Wait" };
    if (actionType.includes("done") || actionType.includes("finish")) return { icon: "check", className: "icon-result", label: "Done" };
    if (actionType.includes("workflow")) return { icon: "workflow", className: "icon-action", label: "Workflow" };
    if (actionType.includes("requestuserinput") || actionType.includes("request_user_input")) return { icon: "user", className: "icon-action", label: "Input" };
    return { icon: "spark", className: "icon-action", label: "Action" };
  }
  if (type === "run_execution") return { icon: "play", className: "icon-action", label: "Execution" };
  if (type === "run_started") return { icon: "flag", className: "icon-planning", label: "Started" };
  return { icon: "spark", className: "icon-planning", label: "Event" };
}

function eventIconSvg(iconName) {
  const icon = String(iconName || "").trim().toLowerCase();
  const stroke = 'stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"';
  if (icon === "brain") return `<svg viewBox="0 0 20 20" aria-hidden="true"><path ${stroke} d="M8 4a3 3 0 0 0-5 2.2A2.7 2.7 0 0 0 4.7 11 3.2 3.2 0 0 0 8 16m4-12a3 3 0 0 1 5 2.2A2.7 2.7 0 0 1 15.3 11 3.2 3.2 0 0 1 12 16m-4-6h4M10 4v12"/></svg>`;
  if (icon === "route") return `<svg viewBox="0 0 20 20" aria-hidden="true"><circle ${stroke} cx="4" cy="4" r="2.2"/><circle ${stroke} cx="16" cy="16" r="2.2"/><path ${stroke} d="M6.2 4h2.4a2 2 0 0 1 2 2v2.6a2 2 0 0 0 2 2H14"/></svg>`;
  if (icon === "check") return `<svg viewBox="0 0 20 20" aria-hidden="true"><path ${stroke} d="M4 10.5 8.2 15 16 6.5"/></svg>`;
  if (icon === "alert") return `<svg viewBox="0 0 20 20" aria-hidden="true"><path ${stroke} d="M10 3 18 17H2L10 3Z"/><path ${stroke} d="M10 8v4"/><circle cx="10" cy="14.2" r="0.9" fill="currentColor"/></svg>`;
  if (icon === "pointer") return `<svg viewBox="0 0 20 20" aria-hidden="true"><path ${stroke} d="M5 3v10l3-2.2 2.2 4.2 2-1-2.2-4.2H14L5 3Z"/></svg>`;
  if (icon === "type") return `<svg viewBox="0 0 20 20" aria-hidden="true"><path ${stroke} d="M4 5h12M10 5v10M7 15h6"/></svg>`;
  if (icon === "compass") return `<svg viewBox="0 0 20 20" aria-hidden="true"><circle ${stroke} cx="10" cy="10" r="7"/><path ${stroke} d="m12.8 7.2-2 5.6-5.6 2 2-5.6 5.6-2Z"/></svg>`;
  if (icon === "scroll") return `<svg viewBox="0 0 20 20" aria-hidden="true"><path ${stroke} d="M7 3h6a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H8.5A2.5 2.5 0 0 1 6 14.5V5a2 2 0 1 0-4 0v7"/><path ${stroke} d="M9 8h4M9 11h4"/></svg>`;
  if (icon === "clock") return `<svg viewBox="0 0 20 20" aria-hidden="true"><circle ${stroke} cx="10" cy="10" r="7"/><path ${stroke} d="M10 6.5v4l2.5 1.8"/></svg>`;
  if (icon === "workflow") return `<svg viewBox="0 0 20 20" aria-hidden="true"><rect ${stroke} x="2.5" y="3" width="5" height="4" rx="1"/><rect ${stroke} x="12.5" y="6.5" width="5" height="4" rx="1"/><rect ${stroke} x="7.5" y="13" width="5" height="4" rx="1"/><path ${stroke} d="M7.5 5h2.5a2 2 0 0 1 2 2v.5M12.5 10.5v1a2 2 0 0 1-2 2H10"/></svg>`;
  if (icon === "user") return `<svg viewBox="0 0 20 20" aria-hidden="true"><circle ${stroke} cx="10" cy="7" r="3"/><path ${stroke} d="M4 16a6 6 0 0 1 12 0"/></svg>`;
  if (icon === "play") return `<svg viewBox="0 0 20 20" aria-hidden="true"><path ${stroke} d="M6 4.5v11l8-5.5-8-5.5Z"/></svg>`;
  if (icon === "flag") return `<svg viewBox="0 0 20 20" aria-hidden="true"><path ${stroke} d="M5 17V3m0 0h8l-1.3 2L13 7H5"/></svg>`;
  return `<svg viewBox="0 0 20 20" aria-hidden="true"><path ${stroke} d="M10 3v14M3 10h14"/></svg>`;
}

function renderConnection() {
  const cloudAuthEnabled = canShowCloudAuth();
  const showAuthCard = cloudAuthEnabled && !state.authenticated;

  if (els.authCard) {
    els.authCard.style.display = showAuthCard ? "" : "none";
  }
  if (els.compactLogoutBtn) {
    els.compactLogoutBtn.style.display = cloudAuthEnabled && state.authenticated ? "inline-flex" : "none";
  }
  if (els.connectBtn) {
    els.connectBtn.textContent = state.authenticated ? "Connected" : "Connect";
    els.connectBtn.disabled = !showAuthCard;
  }
  if (els.apiKeyInput) {
    els.apiKeyInput.disabled = !showAuthCard;
  }

  if (els.startRunBtn) {
    els.startRunBtn.disabled = isRunActive(state.currentRun);
  }
  if (els.cancelRunBtn) {
    els.cancelRunBtn.disabled = !isRunActive(state.currentRun);
  }
}

function renderTimeline() {
  const run = state.currentRun;
  els.timelineList.innerHTML = "";

  if (!run) {
    if (els.runMeta) {
      els.runMeta.textContent = "Idle";
    }
    const li = document.createElement("li");
    li.textContent = "No execution yet. Run a prompt to see live events.";
    els.timelineList.appendChild(li);
    return;
  }

  const events = getRunEvents(run).filter(shouldRenderEvent);
  if (els.runMeta) {
    const sessionInfo = run.session_id ? ` • ${String(run.session_id).slice(0, 10)}` : "";
    els.runMeta.textContent = `${run.id.slice(0, 8)} • ${normalizeStatus(String(run.status || "pending"))}${sessionInfo}`;
  }

  if (!events.length) {
    const li = document.createElement("li");
    li.textContent = run.waitingForUserInput
      ? "Waiting for your input to continue."
      : "Initializing local run session...";
    els.timelineList.appendChild(li);
  } else {
    events.forEach((event) => {
      const li = document.createElement("li");
      li.className = "log-item";
      const eventStatus = normalizeStatus(String(event.status || "pending"));
      const eventTime = event.createdAt ? new Date(event.createdAt).toLocaleTimeString() : "";
      const eventTypeRaw = String(event.type || "event");
      const eventType = escapeHtml(eventTypeRaw === "reasoning" ? "thoughts" : eventTypeRaw);
      const title = escapeHtml(truncate(event.title || "Event", 80));
      const icon = eventIconMeta(event);
      const iconHtml = `<span class="event-icon ${escapeHtml(icon.className)}" title="${escapeHtml(icon.label)}">${eventIconSvg(icon.icon)}</span>`;
      const stepIndex = Number.isFinite(Number(event.stepIndex))
        ? Number(event.stepIndex)
        : (
          event.data && Number.isFinite(Number(event.data.stepIndex))
            ? Number(event.data.stepIndex)
            : null
        );
      const stepLabel = Number.isFinite(stepIndex) ? `step ${stepIndex + 1}` : "";
      const reasoningText = event.data && typeof event.data.rationale === "string"
        ? String(event.data.rationale || "").trim()
        : "";
      const detailParts = [];
      if (typeof event.detail === "string" && event.detail.trim()) {
        detailParts.push(event.detail.trim());
      }
      if (reasoningText) {
        detailParts.push(`Thoughts: ${reasoningText}`);
      }
      const detail = detailParts.length
        ? `<p class="event-detail">${escapeHtml(truncate(detailParts.join("\n"), 420))}</p>`
        : "";
      li.innerHTML = `
        <div class="item-row">
          <div class="item-row-main">
            ${iconHtml}
            <strong class="item-title">${title}</strong>
          </div>
          <span class="${statusClass(eventStatus)}">${eventStatus}</span>
        </div>
        ${detail}
        <div class="item-meta event-meta">${eventType}${stepLabel ? ` • ${escapeHtml(stepLabel)}` : ""}${eventTime ? ` • ${escapeHtml(eventTime)}` : ""}</div>
      `;
      els.timelineList.appendChild(li);
    });
    if (isRunActive(run)) {
      requestAnimationFrame(() => {
        els.timelineList.scrollTop = els.timelineList.scrollHeight;
      });
    }
  }

}

function renderFinalResult() {
  if (!els.finalResultText) {
    return;
  }
  const run = state.currentRun;
  const text = run && run.result && typeof run.result === "object"
    ? String(run.result.content || "").trim()
    : "";
  els.finalResultText.textContent = text || "No final text yet.";
  if (els.copyFinalResultBtn) {
    els.copyFinalResultBtn.disabled = !text;
  }
}

function renderPendingUserInput() {
  const run = state.currentRun;
  const pending = run && run.waitingForUserInput && typeof run.waitingForUserInput === "object"
    ? run.waitingForUserInput
    : null;
  state.pendingUserInput = pending;

  if (!els.userInputCard) {
    return;
  }
  if (!pending) {
    els.userInputCard.style.display = "none";
    if (els.userInputPrompt) {
      els.userInputPrompt.textContent = "";
    }
    if (els.userInputAnswer) {
      els.userInputAnswer.value = "";
    }
    return;
  }

  const options = Array.isArray(pending.options) && pending.options.length
    ? ` Options: ${pending.options.slice(0, 6).join(", ")}`
    : "";
  if (els.userInputPrompt) {
    els.userInputPrompt.textContent = `${String(pending.prompt || "Input required.")}${options}`;
  }
  if (els.userInputCard) {
    els.userInputCard.style.display = "";
  }
}

function renderSessions() {
  if (!els.sessionsList) {
    return;
  }
  els.sessionsList.innerHTML = "";

  const sessions = Array.isArray(state.sessions) ? state.sessions : [];
  if (!sessions.length) {
    const empty = document.createElement("span");
    empty.className = "meta";
    empty.textContent = "No sessions yet.";
    els.sessionsList.appendChild(empty);
    return;
  }

  sessions.slice(0, 14).forEach((session) => {
    const id = String(session && session.id ? session.id : "");
    if (!id) {
      return;
    }
    const name = String(session && session.title ? session.title : "").trim() || id.slice(0, 10);
    const runCount = Number.isFinite(Number(session && session.runCount)) ? Number(session.runCount) : 0;
    const button = document.createElement("button");
    button.type = "button";
    button.className = `session-chip${id === state.activeSessionId ? " active" : ""}`;
    button.textContent = `${truncate(name, 26)}${runCount > 0 ? ` (${runCount})` : ""}`;
    button.title = `Open session ${name}`;
    button.addEventListener("click", () => {
      setActiveSession(id);
    });
    els.sessionsList.appendChild(button);
  });
}

function buildTurnEventWidgets(run, maxItems = 8) {
  const events = getRunEvents(run)
    .filter(shouldRenderEvent)
    .filter((event) => {
      const type = String(event && event.type ? event.type : "").toLowerCase();
      return !["run_started", "run_execution", "planning", "reasoning"].includes(type);
    });
  if (!events.length) {
    return "";
  }
  const rendered = events.slice(-maxItems).map((event) => {
    const icon = eventIconMeta(event);
    const iconHtml = `<span class="turn-event-icon ${escapeHtml(icon.className)}">${eventIconSvg(icon.icon)}</span>`;
    const title = String(event && event.title ? event.title : icon.label || "Event");
    const status = normalizeStatus(String(event && event.status ? event.status : "pending"));
    return `
      <div class="turn-event-chip">
        ${iconHtml}
        <span class="turn-event-label">${escapeHtml(truncate(title, 38))}</span>
        <span class="turn-event-status ${statusClass(status)}">${escapeHtml(status)}</span>
      </div>
    `;
  }).join("");
  return `<div class="turn-events">${rendered}</div>`;
}

function buildReasoningDetails(run) {
  const runStatus = normalizeStatus(String((run && run.status) || "pending"));
  const isTerminal = ["succeeded", "failed", "cancelled"].includes(runStatus);
  const events = getRunEvents(run).filter(shouldRenderEvent);
  const thoughts = [];
  const actionRationales = [];

  events.forEach((event) => {
    const type = String(event && event.type ? event.type : "").toLowerCase();
    const eventStatus = normalizeStatus(String(event && event.status ? event.status : "pending"));
    const effectiveStatus = type === "reasoning" && isTerminal && eventStatus === "pending"
      ? "succeeded"
      : eventStatus;
    const detail = String(event && event.detail ? event.detail : "").trim();
    if (type === "reasoning" && detail) {
      thoughts.push({
        text: detail,
        status: effectiveStatus,
        at: event.createdAt ? new Date(event.createdAt).toLocaleTimeString() : ""
      });
      return;
    }
    const rationale = String(event && event.data && event.data.rationale ? event.data.rationale : "").trim();
    if (type === "action" && rationale) {
      actionRationales.push({
        text: rationale,
        status: effectiveStatus,
        at: event.createdAt ? new Date(event.createdAt).toLocaleTimeString() : ""
      });
    }
  });

  let html = "";
  if (thoughts.length) {
    const rows = thoughts.slice(-8).map((item) => `
      <li>
        <span class="reasoning-text">${escapeHtml(truncate(item.text, 280))}</span>
        <span class="reasoning-meta">${item.at ? `${escapeHtml(item.at)} • ` : ""}${escapeHtml(item.status)}</span>
      </li>
    `).join("");
    html += `
      <details class="turn-details">
        <summary>Thoughts (${thoughts.length})</summary>
        <ul class="reasoning-list">${rows}</ul>
      </details>
    `;
  }
  if (actionRationales.length) {
    const rows = actionRationales.slice(-8).map((item) => `
      <li>
        <span class="reasoning-text">${escapeHtml(truncate(item.text, 280))}</span>
        <span class="reasoning-meta">${item.at ? `${escapeHtml(item.at)} • ` : ""}${escapeHtml(item.status)}</span>
      </li>
    `).join("");
    html += `
      <details class="turn-details">
        <summary>Action Rationales (${actionRationales.length})</summary>
        <ul class="reasoning-list">${rows}</ul>
      </details>
    `;
  }
  return html;
}

function renderHistory() {
  els.historyList.innerHTML = "";

  const turns = Array.isArray(state.history) ? [...state.history] : [];
  if (state.currentRun && state.currentRun.id && !turns.some((item) => item && item.id === state.currentRun.id)) {
    turns.unshift(state.currentRun);
  }

  if (!turns.length) {
    const li = document.createElement("li");
    li.textContent = "No turns yet in this session.";
    els.historyList.appendChild(li);
    return;
  }

  turns.slice(0, 12).forEach((run) => {
    const sessionShort = run.session_id ? String(run.session_id).slice(0, 10) : null;
    const runStatus = normalizeStatus(String(run.status || "pending"));
    const promptText = String(run.prompt || "").trim() || "No prompt";
    const resultText = run && run.result && typeof run.result === "object"
      ? String(run.result.content || "").trim()
      : "";
    const failText = run && run.lastError && typeof run.lastError === "object"
      ? String(run.lastError.message || "").trim()
      : "";
    const assistantText = resultText
      || (runStatus === "failed" ? (failText || "Run failed.") : "")
      || (runStatus === "running" ? "Working on it..." : "Completed without explicit final text.");
    const turnEvents = buildTurnEventWidgets(run, 8);
    const reasoningDetails = buildReasoningDetails(run);
    const updated = run.updatedAt ? new Date(run.updatedAt).toLocaleString() : "";
    const li = document.createElement("li");
    li.className = "log-item clickable";
    li.tabIndex = 0;
    li.innerHTML = `
      <div class="turn-head">
        <strong class="item-title">${escapeHtml(updated || "Session turn")}</strong>
        <span class="${statusClass(runStatus)}">${escapeHtml(runStatus)}</span>
      </div>
      <div class="turn-bubble turn-user">
        <div class="turn-role">You</div>
        <div class="turn-text">${escapeHtml(truncate(promptText, 260))}</div>
      </div>
      <div class="turn-bubble turn-assistant">
        <div class="turn-role">Automata</div>
        <div class="turn-text">${escapeHtml(truncate(assistantText, 360))}</div>
        ${reasoningDetails}
        ${turnEvents}
      </div>
      <div class="item-meta">${sessionShort ? `session ${escapeHtml(sessionShort)}` : ""}${run.id ? ` • ${escapeHtml(String(run.id).slice(0, 8))}` : ""}</div>
    `;
    li.title = "Open this turn";
    li.addEventListener("click", () => {
      state.currentRun = run;
      const failure = getFailureFromRun(run);
      if (failure) {
        setErrorHint(failure, `history:${run.id}`);
      } else {
        clearErrorHint();
      }
      renderAll();
      setStatus(`Loaded run ${run.id}`);
    });
    li.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        state.currentRun = run;
        const failure = getFailureFromRun(run);
        if (failure) {
          setErrorHint(failure, `history:${run.id}`);
        } else {
          clearErrorHint();
        }
        renderAll();
        setStatus(`Loaded run ${run.id}`);
      }
    });
    els.historyList.appendChild(li);
  });
}

function renderAutomations() {
  if (!els.automationsList) {
    return;
  }
  els.automationsList.innerHTML = "";

  const recording = state.recording && typeof state.recording === "object" ? state.recording : { active: false };
  if (els.recordingBadge) {
    if (recording.active) {
      const steps = Number(recording.step_count || 0);
      els.recordingBadge.className = "meta recording-on";
      els.recordingBadge.textContent = `Recording • ${steps} steps`;
    } else {
      els.recordingBadge.className = "meta recording-off";
      els.recordingBadge.textContent = "Idle";
    }
  }
  if (els.recordStartBtn) {
    els.recordStartBtn.disabled = Boolean(recording.active);
  }
  if (els.recordStopBtn) {
    els.recordStopBtn.disabled = !Boolean(recording.active);
  }

  const automations = Array.isArray(state.automations) ? state.automations : [];
  if (!automations.length) {
    const li = document.createElement("li");
    li.textContent = "No automations yet. Start recording to capture a workflow.";
    els.automationsList.appendChild(li);
    return;
  }

  automations.slice(0, 10).forEach((automation) => {
    const id = String(automation.id || "");
    const name = String(automation.name || "Workflow");
    const stepCount = Array.isArray(automation.steps) ? automation.steps.length : 0;
    const updated = automation.updated_at ? new Date(automation.updated_at).toLocaleString() : "";

    const li = document.createElement("li");
    li.className = "log-item";
    li.innerHTML = `
      <div class="automation-item-row">
        <strong class="item-title">${escapeHtml(truncate(name, 42))}</strong>
        <div class="automation-actions">
          <button class="btn ghost btn-mini" data-action="replay" data-id="${escapeHtml(id)}">Run</button>
          <button class="btn ghost btn-mini" data-action="delete" data-id="${escapeHtml(id)}">Delete</button>
        </div>
      </div>
      <div class="item-meta">${stepCount} steps${updated ? ` • ${escapeHtml(updated)}` : ""}</div>
    `;
    els.automationsList.appendChild(li);
  });
}

function renderAll() {
  renderView();
  renderConnection();
  renderSessions();
  renderPendingUserInput();
  renderHistory();
  renderAutomations();
  renderErrorHint();
}

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

async function loadAuthStatus() {
  const previousHealth = state.localOperatorAvailable;
  const response = await sendMessage({ type: "AUTH_STATUS" });
  if (!response.ok) {
    throw new Error(response.error || "Failed to load auth status");
  }
  const status = response.status || {};
  state.authenticated = Boolean(status.authenticated);
  state.localOperatorAvailable = Boolean(status.localOperatorAvailable);
  state.executionProvider = String(status.executionProvider || "local_operator");
  renderConnection();
  return previousHealth !== state.localOperatorAvailable;
}

async function loadOperatorBase() {
  const response = await sendMessage({ type: "OPERATOR_BASE_GET" });
  if (!response.ok) {
    throw new Error(response.error || "Failed to load operator URL");
  }
  const baseUrl = String(response.baseUrl || "").trim() || "http://127.0.0.1:18060";
  state.operatorBaseUrl = baseUrl;
  if (els.operatorBaseInput) {
    els.operatorBaseInput.value = baseUrl;
  }
}

async function saveOperatorBase(silent = false) {
  if (!els.operatorBaseInput) {
    return true;
  }
  const baseUrl = els.operatorBaseInput.value.trim();
  if (!baseUrl) {
    if (!silent) {
      setStatus("Operator URL required");
    }
    return false;
  }
  try {
    const response = await sendMessage({ type: "OPERATOR_BASE_SET", baseUrl });
    if (!response.ok) {
      throw new Error(response.error || "Invalid operator URL");
    }
    state.operatorBaseUrl = String(response.baseUrl || baseUrl);
    els.operatorBaseInput.value = state.operatorBaseUrl;
    if (!silent) {
      setStatus(`Operator URL set: ${state.operatorBaseUrl}`);
    }
    return true;
  } catch (error) {
    if (!silent) {
      setStatus(`Operator URL invalid: ${error.message}`);
    }
    setErrorHint({ code: "invalid_operator_base_url", message: String(error.message || "Invalid operator URL") }, "operator_url");
    return false;
  }
}

async function loadHistory() {
  const response = await sendMessage({
    type: "RUN_HISTORY",
    sessionId: state.activeSessionId || ""
  });
  if (response.ok) {
    state.history = Array.isArray(response.history) ? response.history : [];
    renderHistory();
  }
}

async function loadSessions() {
  const response = await sendMessage({ type: "SESSION_LIST" });
  if (!response.ok) {
    throw new Error(response.error || "Failed to load sessions");
  }
  state.sessions = Array.isArray(response.sessions) ? response.sessions : [];
  state.activeSessionId = String(response.activeSessionId || "");
  state.history = Array.isArray(response.history) ? response.history : [];
  if (state.currentRun && state.currentRun.session_id && state.currentRun.session_id !== state.activeSessionId) {
    const latest = state.history.length ? state.history[0] : null;
    state.currentRun = latest || null;
  }
  if (!state.currentRun && state.history.length) {
    state.currentRun = state.history[0];
  }
  renderSessions();
  renderHistory();
}

async function setActiveSession(sessionId) {
  const id = String(sessionId || "").trim();
  if (!id) {
    return;
  }
  try {
    const response = await sendMessage({ type: "SESSION_SET_ACTIVE", sessionId: id });
    if (!response.ok) {
      throw new Error(response.error || "Could not switch session");
    }
    state.sessions = Array.isArray(response.sessions) ? response.sessions : state.sessions;
    state.activeSessionId = String(response.activeSessionId || id);
    state.history = Array.isArray(response.history) ? response.history : [];
    state.currentRun = state.history.length ? state.history[0] : null;
    clearErrorHint();
    renderAll();
    setStatus("Session switched");
  } catch (error) {
    setStatus(`Session switch failed: ${error.message}`);
  }
}

async function createSession() {
  const name = els.newSessionNameInput ? String(els.newSessionNameInput.value || "").trim() : "";
  try {
    const response = await sendMessage({ type: "SESSION_CREATE", name });
    if (!response.ok) {
      throw new Error(response.error || "Could not create session");
    }
    state.sessions = Array.isArray(response.sessions) ? response.sessions : state.sessions;
    state.activeSessionId = String(response.activeSessionId || "");
    state.history = Array.isArray(response.history) ? response.history : [];
    state.currentRun = null;
    if (els.newSessionNameInput) {
      els.newSessionNameInput.value = "";
    }
    clearErrorHint(true);
    renderAll();
    setStatus("New session created");
  } catch (error) {
    setStatus(`Session create failed: ${error.message}`);
  }
}

async function loadAutomations() {
  const response = await sendMessage({ type: "AUTOMATION_LIST" });
  if (response.ok) {
    state.automations = Array.isArray(response.automations) ? response.automations : [];
    state.recording = response.recording && typeof response.recording === "object"
      ? response.recording
      : { active: false };
    renderAutomations();
  }
}

function updatePromptMeta() {
  if (!els.promptMeta || !els.promptInput) {
    return;
  }
  const size = String(els.promptInput.value || "").trim().length;
  els.promptMeta.textContent = `${size} chars`;
}

function clearPolling() {
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

function startPolling(runId) {
  clearPolling();
  state.pollTimer = setInterval(async () => {
    try {
      const response = await sendMessage({ type: "RUN_GET", runId });
      if (!response.ok) {
        clearPolling();
        setStatus("Run not found");
        return;
      }

      state.currentRun = response.run;
      renderAll();

      const status = response.run.status;
      if (status === "awaiting_input") {
        setStatus(`Run ${runId}: waiting for your input`);
      } else {
        setStatus(`Run ${runId}: ${status}`);
      }

      if (["succeeded", "failed", "cancelled"].includes(status)) {
        clearPolling();
        if (status === "failed") {
          const failure = getFailureFromRun(response.run);
          if (failure) {
            setErrorHint(failure, `run:${runId}`);
          }
        } else {
          clearErrorHint();
        }
        await loadSessions();
      }
    } catch (error) {
      clearPolling();
      setStatus(`Polling error: ${error.message}`);
    }
  }, 1000);
}

async function connectApiKey() {
  if (!els.apiKeyInput) {
    setStatus("Cloud auth UI is unavailable");
    return;
  }
  const apiKey = els.apiKeyInput.value.trim();
  if (!apiKey) {
    setStatus("API key required");
    return;
  }

  setStatus("Connecting...");

  try {
    const response = await sendMessage({ type: "AUTH_CONNECT_API_KEY", apiKey });
    if (!response.ok) {
      throw new Error(response.error || "Connect failed");
    }

    state.authenticated = true;
    els.apiKeyInput.value = "";
    setStatus("Connected");
    renderConnection();
  } catch (error) {
    setStatus(`Connect failed: ${error.message}`);
  } finally {
    renderConnection();
  }
}

async function clearHistory() {
  try {
    const response = await sendMessage({ type: "RUN_HISTORY_CLEAR" });
    if (!response.ok) {
      throw new Error(response.error || "Clear history failed");
    }
    state.history = [];
    if (state.currentRun && !isRunActive(state.currentRun)) {
      state.currentRun = null;
    }
    clearErrorHint(true);
    renderAll();
    await loadSessions();
    setStatus("Session history cleared");
  } catch (error) {
    setStatus(`Could not clear history: ${error.message}`);
  }
}

async function startRecording() {
  const name = els.automationNameInput ? els.automationNameInput.value.trim() : "";
  let response = null;
  try {
    response = await sendMessage({
      type: "AUTOMATION_RECORD_START",
      payload: { name }
    });
    if (!response.ok) {
      throw new Error(response.error || "Could not start recording");
    }
    state.recording = response.recording || { active: true };
    renderAutomations();
    setStatus("Recording started. Perform your workflow in the current tab.");
  } catch (error) {
    setStatus(`Record start failed: ${error.message}`);
    setErrorHint({ code: response && response.code ? response.code : "", message: error.message }, "record_start");
  }
}

async function stopRecordingAndSave() {
  const name = els.automationNameInput ? els.automationNameInput.value.trim() : "";
  try {
    const response = await sendMessage({
      type: "AUTOMATION_RECORD_STOP",
      payload: { name, save: true }
    });
    if (!response.ok) {
      throw new Error(response.error || "Could not stop recording");
    }
    state.recording = response.recording || { active: false };
    state.automations = Array.isArray(response.automations) ? response.automations : state.automations;
    if (els.automationNameInput) {
      els.automationNameInput.value = "";
    }
    renderAutomations();
    const savedName = response.automation && response.automation.name ? response.automation.name : "workflow";
    setStatus(`Recording saved: ${savedName}`);
  } catch (error) {
    setStatus(`Record stop failed: ${error.message}`);
  }
}

async function replayAutomation(automationId) {
  const startUrl = els.startUrlInput ? els.startUrlInput.value.trim() : "";
  setActiveView("runs");
  setStatus("Starting workflow replay...");
  try {
    const response = await sendMessage({
      type: "AUTOMATION_REPLAY",
      payload: { automationId, startUrl, sessionId: state.activeSessionId || "" }
    });
    if (!response.ok) {
      throw new Error(response.error || "Could not replay automation");
    }
    state.currentRun = response.run;
    clearErrorHint();
    renderAll();
    setStatus(`Workflow replay started: ${response.run.id}`);
    await loadSessions();
    startPolling(response.run.id);
  } catch (error) {
    setStatus(`Workflow replay failed to start: ${error.message}`);
    setErrorHint({ code: "", message: error.message }, "replay_start");
  }
}

async function removeAutomation(automationId) {
  try {
    const response = await sendMessage({ type: "AUTOMATION_DELETE", automationId });
    if (!response.ok) {
      throw new Error(response.error || "Could not delete automation");
    }
    state.automations = Array.isArray(response.automations) ? response.automations : [];
    renderAutomations();
    setStatus("Automation deleted");
  } catch (error) {
    setStatus(`Delete automation failed: ${error.message}`);
  }
}

async function logout() {
  setStatus("Logging out...");
  try {
    const response = await sendMessage({ type: "AUTH_LOGOUT" });
    if (!response.ok) {
      throw new Error(response.error || "Logout failed");
    }

    state.authenticated = false;
    state.currentRun = null;
    clearPolling();
    setStatus("Disconnected");
    renderAll();
  } catch (error) {
    setStatus(`Logout failed: ${error.message}`);
  }
}

async function startRun() {
  if (isRunActive(state.currentRun)) {
    setStatus("A run is already in progress");
    return;
  }

  const prompt = els.promptInput.value.trim();
  const startUrl = els.startUrlInput.value.trim();
  const operatorBaseUrl = els.operatorBaseInput ? els.operatorBaseInput.value.trim() : "";
  if (!prompt) {
    setStatus("Prompt required");
    setErrorHint({ code: "invalid_prompt", message: "Prompt is required." }, "start");
    return;
  }
  if (operatorBaseUrl && operatorBaseUrl !== state.operatorBaseUrl) {
    const saved = await saveOperatorBase(true);
    if (!saved) {
      setStatus("Operator URL invalid");
      return;
    }
  }

  setActiveView("runs");
  els.startRunBtn.disabled = true;
  clearErrorHint();
  setStatus("Starting run...");

  try {
    const response = await sendMessage({
      type: "RUN_START",
      payload: { prompt, startUrl, sessionId: state.activeSessionId || "" }
    });

    if (!response.ok) {
      setErrorHint(
        { code: response.code || "", message: response.error || "Run failed to start" },
        "start"
      );
      throw new Error(response.error || "Run failed to start");
    }

    state.currentRun = response.run;
    if (response.run && response.run.session_id) {
      state.activeSessionId = String(response.run.session_id);
    }
    renderAll();
    const sessionShort = response.run && response.run.session_id ? ` (${String(response.run.session_id).slice(0, 10)})` : "";
    setStatus(`Run started: ${response.run.id}${sessionShort}`);
    await loadSessions();
    startPolling(response.run.id);
  } catch (error) {
    setErrorHint({ code: "", message: error.message || "Run failed to start" }, "start");
    setStatus(`Run start failed: ${error.message}`);
  } finally {
    renderAll();
  }
}

async function cancelRun() {
  if (!state.currentRun) {
    setStatus("No active run");
    return;
  }

  const runId = state.currentRun.id;
  setStatus(`Cancelling ${runId}...`);

  try {
    const response = await sendMessage({ type: "RUN_CANCEL", runId });
    if (!response.ok) {
      throw new Error(response.error || "Cancel failed");
    }

    state.currentRun = response.run;
    clearPolling();
    clearErrorHint();
    renderAll();
    setStatus(`Run ${runId} cancelled`);
    await loadSessions();
  } catch (error) {
    setStatus(`Cancel failed: ${error.message}`);
  }
}

async function submitUserInput() {
  if (!state.currentRun || !state.pendingUserInput) {
    setStatus("No pending input request");
    return;
  }
  if (!els.userInputAnswer) {
    setStatus("Input box is unavailable");
    return;
  }

  const answer = els.userInputAnswer.value.trim();
  const required = state.pendingUserInput.required !== false;
  if (!answer && required) {
    setStatus("Response required to continue");
    return;
  }

  try {
    const response = await sendMessage({
      type: "RUN_SUBMIT_USER_INPUT",
      runId: state.currentRun.id,
      answer
    });
    if (!response.ok) {
      throw new Error(response.error || "Could not submit input");
    }
    if (response.run) {
      state.currentRun = response.run;
    }
    els.userInputAnswer.value = "";
    renderAll();
    setStatus("Input submitted. Replanning next action...");
  } catch (error) {
    setStatus(`Input submit failed: ${error.message}`);
  }
}

function bindEvents() {
  if (els.navRunsBtn) {
    els.navRunsBtn.addEventListener("click", () => setActiveView("runs"));
  }
  if (els.navAutomationsBtn) {
    els.navAutomationsBtn.addEventListener("click", () => setActiveView("automations"));
  }
  if (els.connectBtn) {
    els.connectBtn.addEventListener("click", connectApiKey);
  }
  if (els.logoutBtn) {
    els.logoutBtn.addEventListener("click", logout);
  }
  if (els.compactLogoutBtn) {
    els.compactLogoutBtn.addEventListener("click", logout);
  }
  if (els.startRunBtn) {
    els.startRunBtn.addEventListener("click", startRun);
  }
  if (els.newSessionBtn) {
    els.newSessionBtn.addEventListener("click", createSession);
  }
  if (els.newSessionNameInput) {
    els.newSessionNameInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        createSession();
      }
    });
  }
  if (els.saveOperatorBaseBtn) {
    els.saveOperatorBaseBtn.addEventListener("click", () => {
      saveOperatorBase(false);
    });
  }
  if (els.cancelRunBtn) {
    els.cancelRunBtn.addEventListener("click", cancelRun);
  }
  if (els.recordStartBtn) {
    els.recordStartBtn.addEventListener("click", startRecording);
  }
  if (els.recordStopBtn) {
    els.recordStopBtn.addEventListener("click", stopRecordingAndSave);
  }
  if (els.userInputSendBtn) {
    els.userInputSendBtn.addEventListener("click", submitUserInput);
  }
  if (els.clearHistoryBtn) {
    els.clearHistoryBtn.addEventListener("click", clearHistory);
  }
  if (els.errorHintActionBtn) {
    els.errorHintActionBtn.addEventListener("click", handleHintAction);
  }
  if (els.errorHintDismissBtn) {
    els.errorHintDismissBtn.addEventListener("click", () => clearErrorHint(true));
  }
  if (els.automationsList) {
    els.automationsList.addEventListener("click", (event) => {
      const target = event.target && event.target.closest ? event.target.closest("button[data-action][data-id]") : null;
      if (!target) {
        return;
      }
      const action = String(target.getAttribute("data-action") || "");
      const id = String(target.getAttribute("data-id") || "");
      if (!id) {
        return;
      }
      if (action === "replay") {
        replayAutomation(id);
      } else if (action === "delete") {
        removeAutomation(id);
      }
    });
  }

  els.promptInput.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      startRun();
    }
  });
  els.promptInput.addEventListener("input", updatePromptMeta);
  if (els.userInputAnswer) {
    els.userInputAnswer.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        submitUserInput();
      }
    });
  }
}

async function bootstrap() {
  bindEvents();
  renderAll();
  updatePromptMeta();
  setStatus("Enter a prompt and press Run.");
  try {
    await loadAutomations();
  } catch (_error) {
    // ignore startup automation read errors
  }

  try {
    await loadOperatorBase();
    await loadAuthStatus();
    await loadSessions();
    setStatus(
      state.localOperatorAvailable
        ? "Local operator detected."
        : "Local operator not reachable. Start autoppia_operator and verify Operator URL."
    );
    if (!state.localOperatorAvailable && !state.currentRun) {
      setErrorHint(
        {
          code: "local_operator_unreachable",
          message: "Local operator unreachable. Start autoppia_operator and verify Operator URL."
        },
        "health"
      );
    }
  } catch (error) {
    setErrorHint({ code: "", message: error.message || "Initialization failed" }, "init");
    setStatus(`Initialization failed: ${error.message}`);
  }

  if (healthPollTimer) {
    clearInterval(healthPollTimer);
  }
  healthPollTimer = setInterval(async () => {
    try {
      const healthChanged = await loadAuthStatus();
      if (healthChanged && !state.currentRun) {
        setStatus(
          state.localOperatorAvailable
            ? "Local operator detected."
            : "Local operator not reachable. Start autoppia_operator and verify Operator URL."
        );
        if (!state.localOperatorAvailable) {
          setErrorHint(
            {
              code: "local_operator_unreachable",
              message: "Local operator unreachable. Start autoppia_operator and verify Operator URL."
            },
            "health"
          );
        } else {
          clearErrorHint();
        }
      }
      await loadSessions();
      await loadAutomations();
    } catch (_error) {
      // ignore periodic status errors
    }
  }, 4000);
}

bootstrap();
