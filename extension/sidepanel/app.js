const state = {
  authenticated: false,
  localOperatorAvailable: false,
  executionProvider: "local_operator",
  currentRun: null,
  pollTimer: null,
  history: []
};
let healthPollTimer = null;

const els = {
  connectionBadge: document.getElementById("connectionBadge"),
  providerBadge: document.getElementById("providerBadge"),
  compactLogoutBtn: document.getElementById("compactLogoutBtn"),
  authCard: document.getElementById("authCard"),
  runMeta: document.getElementById("runMeta"),
  apiKeyInput: document.getElementById("apiKeyInput"),
  connectBtn: document.getElementById("connectBtn"),
  logoutBtn: document.getElementById("logoutBtn"),
  promptInput: document.getElementById("promptInput"),
  startUrlInput: document.getElementById("startUrlInput"),
  startRunBtn: document.getElementById("startRunBtn"),
  cancelRunBtn: document.getElementById("cancelRunBtn"),
  statusLine: document.getElementById("statusLine"),
  timelineList: document.getElementById("timelineList"),
  historyList: document.getElementById("historyList")
};

function setStatus(text) {
  els.statusLine.textContent = text;
}

function normalizeStatus(status) {
  const allowed = new Set(["running", "pending", "succeeded", "cancelled", "failed"]);
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

function canShowCloudAuth() {
  return state.executionProvider === "cloud";
}

function renderConnection() {
  if (state.localOperatorAvailable) {
    els.connectionBadge.textContent = "Operator Ready";
    els.connectionBadge.className = "badge badge-online";
  } else {
    els.connectionBadge.textContent = "Operator Offline";
    els.connectionBadge.className = "badge badge-offline";
  }

  els.providerBadge.textContent = state.executionProvider === "local_operator" ? "Autoppia Operator" : "Cloud";

  const cloudAuthEnabled = canShowCloudAuth();
  const showAuthCard = cloudAuthEnabled && !state.authenticated;

  els.authCard.style.display = showAuthCard ? "" : "none";
  els.compactLogoutBtn.style.display = cloudAuthEnabled && state.authenticated ? "inline-flex" : "none";
  els.connectBtn.textContent = state.authenticated ? "Connected" : "Connect";
  els.apiKeyInput.disabled = !showAuthCard;
  els.connectBtn.disabled = !showAuthCard;

  els.startRunBtn.disabled = !state.localOperatorAvailable;
  els.cancelRunBtn.disabled = !state.currentRun;
}

function renderTimeline() {
  const run = state.currentRun;
  els.timelineList.innerHTML = "";

  if (!run) {
    els.runMeta.textContent = "Idle";
    const li = document.createElement("li");
    li.textContent = "No execution yet. Run a prompt to see step-by-step actions.";
    els.timelineList.appendChild(li);
    return;
  }

  els.runMeta.textContent = `${run.id.slice(0, 8)} • ${run.status}`;

  if (!run.timeline.length) {
    const li = document.createElement("li");
    li.textContent = "Planning first action...";
    els.timelineList.appendChild(li);
  } else {
    run.timeline.forEach((item) => {
      const li = document.createElement("li");
      li.className = "log-item";
      li.innerHTML = `
        <div class="item-row">
          <strong class="item-title">${truncate(item.title, 72)}</strong>
          <span class="${statusClass(item.status)}">${item.status}</span>
        </div>
      `;
      els.timelineList.appendChild(li);
    });
  }

  if (run.result && run.result.content) {
    const li = document.createElement("li");
    li.className = "log-item result-item";
    li.innerHTML = `<strong>Result</strong><p class="result-text">${truncate(run.result.content, 240)}</p>`;
    els.timelineList.appendChild(li);
  }
}

function renderHistory() {
  els.historyList.innerHTML = "";

  if (!state.history.length) {
    const li = document.createElement("li");
    li.textContent = "No runs yet";
    els.historyList.appendChild(li);
    return;
  }

  state.history.slice(0, 8).forEach((run) => {
    const li = document.createElement("li");
    li.className = "log-item clickable";
    li.innerHTML = `
      <div class="item-row">
        <strong class="item-title">${truncate(run.prompt, 58)}</strong>
        <span class="${statusClass(run.status)}">${run.status}</span>
      </div>
      <div class="item-meta">${new Date(run.updatedAt).toLocaleString()}</div>
    `;
    li.title = "Open this run in execution steps";
    li.addEventListener("click", () => {
      state.currentRun = run;
      renderTimeline();
      renderConnection();
      setStatus(`Loaded run ${run.id}`);
    });
    els.historyList.appendChild(li);
  });
}

function renderAll() {
  renderConnection();
  renderTimeline();
  renderHistory();
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

async function loadHistory() {
  const response = await sendMessage({ type: "RUN_HISTORY" });
  if (response.ok) {
    state.history = Array.isArray(response.history) ? response.history : [];
    renderHistory();
  }
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
      renderTimeline();

      const status = response.run.status;
      setStatus(`Run ${runId}: ${status}`);

      if (["succeeded", "failed", "cancelled"].includes(status)) {
        clearPolling();
        await loadHistory();
      }
    } catch (error) {
      clearPolling();
      setStatus(`Polling error: ${error.message}`);
    }
  }, 1000);
}

async function connectApiKey() {
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
  if (!state.localOperatorAvailable) {
    setStatus("Local operator offline. Start autoppia_operator at 127.0.0.1:5060");
    return;
  }

  const prompt = els.promptInput.value.trim();
  const startUrl = els.startUrlInput.value.trim();
  if (!prompt) {
    setStatus("Prompt required");
    return;
  }

  els.startRunBtn.disabled = true;
  setStatus("Starting run...");

  try {
    const response = await sendMessage({
      type: "RUN_START",
      payload: { prompt, startUrl }
    });

    if (!response.ok) {
      throw new Error(response.error || "Run failed to start");
    }

    state.currentRun = response.run;
    renderTimeline();
    renderConnection();
    setStatus(`Run started: ${response.run.id}`);
    startPolling(response.run.id);
  } catch (error) {
    setStatus(`Run start failed: ${error.message}`);
  } finally {
    els.startRunBtn.disabled = !state.localOperatorAvailable;
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
    renderTimeline();
    renderConnection();
    setStatus(`Run ${runId} cancelled`);
    await loadHistory();
  } catch (error) {
    setStatus(`Cancel failed: ${error.message}`);
  }
}

function bindEvents() {
  els.connectBtn.addEventListener("click", connectApiKey);
  els.logoutBtn.addEventListener("click", logout);
  els.compactLogoutBtn.addEventListener("click", logout);
  els.startRunBtn.addEventListener("click", startRun);
  els.cancelRunBtn.addEventListener("click", cancelRun);

  els.promptInput.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      startRun();
    }
  });
}

async function bootstrap() {
  bindEvents();
  renderAll();
  setStatus("Loading...");

  try {
    await loadAuthStatus();
    await loadHistory();
    setStatus(
      state.localOperatorAvailable
        ? "Ready: local operator connected"
        : "Operator offline: start autoppia_operator"
    );
  } catch (error) {
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
            ? "Ready: local operator connected"
            : "Operator offline: start autoppia_operator"
        );
      }
    } catch (_error) {
      // ignore periodic status errors
    }
  }, 4000);
}

bootstrap();
