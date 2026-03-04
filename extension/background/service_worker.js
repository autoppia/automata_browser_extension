import {
  exchangeApiKey,
  refreshAccessToken,
  revokeRefreshToken,
  buildMockRunSteps
} from "./mock_cloud_api.js";
import { createTokenManager } from "./token_manager.js";

const HISTORY_KEY = "run_history";
const MAX_HISTORY = 50;

const tokenManager = createTokenManager({
  exchangeApiKey,
  refreshAccessToken,
  revokeRefreshToken
});

const runs = new Map();
const runTimers = new Map();

function randomId(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

function nowIso() {
  return new Date().toISOString();
}

async function getActiveTabContext() {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const active = tabs && tabs.length ? tabs[0] : null;
    return {
      tabId: active ? active.id : null,
      title: active ? active.title || "" : "",
      url: active ? active.url || "" : ""
    };
  } catch (_error) {
    return { tabId: null, title: "", url: "" };
  }
}

function clearRunTimer(runId) {
  const timer = runTimers.get(runId);
  if (timer) {
    clearTimeout(timer);
    runTimers.delete(runId);
  }
}

async function loadHistory() {
  const data = await chrome.storage.local.get(HISTORY_KEY);
  return Array.isArray(data[HISTORY_KEY]) ? data[HISTORY_KEY] : [];
}

async function saveRunToHistory(run) {
  const history = await loadHistory();
  const filtered = history.filter((item) => item.id !== run.id);
  filtered.unshift(run);
  await chrome.storage.local.set({ [HISTORY_KEY]: filtered.slice(0, MAX_HISTORY) });
}

function copyRun(run) {
  return JSON.parse(JSON.stringify(run));
}

function updateRun(runId, patch) {
  const existing = runs.get(runId);
  if (!existing) {
    return null;
  }
  const merged = {
    ...existing,
    ...patch,
    updatedAt: nowIso()
  };
  runs.set(runId, merged);
  return merged;
}

function buildResultMessage(run) {
  const successCount = run.timeline.filter((item) => item.status === "succeeded").length;
  return `Mock run completed. ${successCount} steps done for prompt: "${run.prompt}"`;
}

function scheduleRunProgress(runId, index = 0) {
  clearRunTimer(runId);

  const run = runs.get(runId);
  if (!run) {
    return;
  }

  if (run.status === "cancelled") {
    return;
  }

  const timer = setTimeout(async () => {
    const current = runs.get(runId);
    if (!current || current.status === "cancelled") {
      return;
    }

    const timeline = current.timeline.map((item, itemIndex) => {
      if (itemIndex < index) {
        return { ...item, status: "succeeded", completedAt: item.completedAt || nowIso() };
      }
      if (itemIndex === index) {
        return { ...item, status: "succeeded", completedAt: nowIso() };
      }
      if (itemIndex === index + 1) {
        return { ...item, status: "running" };
      }
      return item;
    });

    let nextStatus = "running";
    let result = current.result;

    if (index >= timeline.length - 1) {
      nextStatus = "succeeded";
      result = {
        content: buildResultMessage({ ...current, timeline }),
        success: true,
        finishedAt: nowIso()
      };
    }

    const updated = updateRun(runId, {
      status: nextStatus,
      timeline,
      result
    });

    if (!updated) {
      return;
    }

    await saveRunToHistory(copyRun(updated));

    if (nextStatus === "running") {
      scheduleRunProgress(runId, index + 1);
    } else {
      clearRunTimer(runId);
    }
  }, 900 + Math.floor(Math.random() * 500));

  runTimers.set(runId, timer);
}

async function startRun(payload) {
  await tokenManager.getValidAccessToken();

  const prompt = String(payload.prompt || "").trim();
  if (!prompt) {
    const error = new Error("Prompt is required");
    error.code = "invalid_prompt";
    throw error;
  }

  const tabCtx = await getActiveTabContext();
  const startUrl = String(payload.startUrl || tabCtx.url || "").trim();

  const steps = buildMockRunSteps(prompt, startUrl);
  const timeline = steps.map((title, index) => ({
    id: `${index + 1}`,
    title,
    status: index === 0 ? "running" : "pending",
    createdAt: nowIso(),
    completedAt: null
  }));

  const run = {
    id: randomId("run"),
    prompt,
    startUrl,
    tabContext: tabCtx,
    status: "running",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    timeline,
    result: null
  };

  runs.set(run.id, run);
  await saveRunToHistory(copyRun(run));

  scheduleRunProgress(run.id, 0);

  return copyRun(run);
}

async function cancelRun(runId) {
  const existing = runs.get(runId);
  if (!existing) {
    return null;
  }

  clearRunTimer(runId);

  const timeline = existing.timeline.map((item) => {
    if (item.status === "running") {
      return { ...item, status: "cancelled" };
    }
    return item;
  });

  const updated = updateRun(runId, {
    status: "cancelled",
    timeline,
    result: {
      content: "Run cancelled by user",
      success: false,
      finishedAt: nowIso()
    }
  });

  if (updated) {
    await saveRunToHistory(copyRun(updated));
  }

  return updated ? copyRun(updated) : null;
}

async function handleMessage(message) {
  switch (message.type) {
    case "AUTH_STATUS":
      return { ok: true, status: await tokenManager.getStatus() };

    case "AUTH_CONNECT_API_KEY": {
      const status = await tokenManager.connectWithApiKey(message.apiKey || "");
      return { ok: true, status };
    }

    case "AUTH_LOGOUT": {
      const status = await tokenManager.logout();
      return { ok: true, status };
    }

    case "RUN_START": {
      const run = await startRun(message.payload || {});
      return { ok: true, run };
    }

    case "RUN_GET": {
      const runId = String(message.runId || "");
      const run = runs.get(runId);
      if (!run) {
        return { ok: false, error: "run_not_found" };
      }
      return { ok: true, run: copyRun(run) };
    }

    case "RUN_CANCEL": {
      const runId = String(message.runId || "");
      const run = await cancelRun(runId);
      if (!run) {
        return { ok: false, error: "run_not_found" };
      }
      return { ok: true, run };
    }

    case "RUN_HISTORY": {
      const history = await loadHistory();
      return { ok: true, history };
    }

    default:
      return { ok: false, error: "unsupported_message_type" };
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then((response) => sendResponse(response))
    .catch((error) => {
      sendResponse({
        ok: false,
        error: error && error.message ? error.message : "unknown_error",
        code: error && error.code ? error.code : "unknown_error"
      });
    });
  return true;
});

chrome.runtime.onInstalled.addListener(() => {
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  }
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!chrome.sidePanel || !tab || typeof tab.id !== "number") {
    return;
  }
  try {
    await chrome.sidePanel.open({ tabId: tab.id });
  } catch (_error) {
    // no-op
  }
});
