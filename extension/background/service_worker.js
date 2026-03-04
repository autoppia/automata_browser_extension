import {
  exchangeApiKey,
  refreshAccessToken,
  revokeRefreshToken
} from "./mock_cloud_api.js";
import { createTokenManager } from "./token_manager.js";

const HISTORY_KEY = "run_history";
const MAX_HISTORY = 50;
const MAX_STEPS = 12;
const LOCAL_OPERATOR_BASE_URL = "http://127.0.0.1:5060";
const LOCAL_OPERATOR_ACT_URL = `${LOCAL_OPERATOR_BASE_URL}/act`;
const LOCAL_OPERATOR_HEALTH_URL = `${LOCAL_OPERATOR_BASE_URL}/health`;
const DEFAULT_FALLBACK_START_URL = "https://example.com/";

const tokenManager = createTokenManager({
  exchangeApiKey,
  refreshAccessToken,
  revokeRefreshToken
});

const runs = new Map();
const runControllers = new Map();

function randomId(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url, init = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function isLocalOperatorHealthy() {
  try {
    const response = await fetchWithTimeout(LOCAL_OPERATOR_HEALTH_URL, {}, 2000);
    return response.ok;
  } catch (_error) {
    return false;
  }
}

async function getActiveTabContext() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const active = tabs && tabs.length ? tabs[0] : null;
  return {
    tabId: active ? active.id : null,
    title: active ? active.title || "" : "",
    url: active ? active.url || "" : ""
  };
}

async function getTabContext(tabId) {
  const tab = await chrome.tabs.get(tabId);
  return {
    tabId,
    title: tab.title || "",
    url: tab.url || ""
  };
}

function isSupportedTabUrl(url) {
  if (!url || typeof url !== "string") {
    return false;
  }
  const blockedPrefixes = ["chrome://", "chrome-extension://", "edge://", "about:"];
  return !blockedPrefixes.some((prefix) => url.startsWith(prefix));
}

function isHttpUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch (_error) {
    return false;
  }
}

async function waitForTabComplete(tabId, timeoutMs = 15000) {
  const tab = await chrome.tabs.get(tabId);
  if (tab.status === "complete") {
    return;
  }

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("tab_load_timeout"));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(onUpdated);
    }

    function onUpdated(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        cleanup();
        resolve();
      }
    }

    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

async function navigateTab(tabId, url) {
  await chrome.tabs.update(tabId, { url });
  await waitForTabComplete(tabId);
}

async function executeScriptOnTab(tabId, func, args = []) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func,
    args
  });

  if (!results || !results.length) {
    return null;
  }

  return results[0].result;
}

async function captureSnapshot(tabId) {
  const result = await executeScriptOnTab(
    tabId,
    (maxHtmlLength) => {
      const html = document.documentElement ? document.documentElement.outerHTML || "" : "";
      return {
        url: window.location.href,
        snapshot_html: html.length > maxHtmlLength ? html.slice(0, maxHtmlLength) : html,
        truncated: html.length > maxHtmlLength
      };
    },
    [1_200_000]
  );

  if (!result || !result.url) {
    throw new Error("snapshot_failed");
  }

  return result;
}

async function executeDomAction(tabId, action) {
  return executeScriptOnTab(
    tabId,
    (rawAction) => {
      function byXPath(xpath) {
        try {
          const first = document.evaluate(
            xpath,
            document,
            null,
            XPathResult.FIRST_ORDERED_NODE_TYPE,
            null
          ).singleNodeValue;
          return first || null;
        } catch (_err) {
          return null;
        }
      }

      function firstByText(text) {
        const needle = String(text || "").trim().toLowerCase();
        if (!needle) {
          return null;
        }
        const nodes = Array.from(document.querySelectorAll("a,button,[role='button'],input,textarea,select,div,span"));
        return (
          nodes.find((node) => {
            const content = String(node.textContent || "").trim().toLowerCase();
            return content.includes(needle);
          }) || null
        );
      }

      function resolveElement(selector) {
        if (!selector || typeof selector !== "object") {
          return null;
        }

        const type = String(selector.type || "");
        const value = String(selector.value || "");
        const attr = String(selector.attribute || "");

        if (type === "xpathSelector" && value) {
          return byXPath(value);
        }

        if (type === "tagContainsSelector" && value) {
          return firstByText(value);
        }

        if (type === "attributeValueSelector") {
          if (attr === "custom" && value) {
            return document.querySelector(value);
          }

          if (attr && value) {
            const escaped = CSS.escape(value);
            if (attr === "href") {
              return (
                document.querySelector(`[href='${escaped}']`) ||
                document.querySelector(`a[href*='${escaped}']`) ||
                null
              );
            }
            return document.querySelector(`[${attr}='${escaped}']`);
          }
        }

        if (type === "cssSelector" && value) {
          return document.querySelector(value);
        }

        return null;
      }

      function fillElement(element, text) {
        element.focus();
        if ("value" in element) {
          element.value = text;
          element.dispatchEvent(new Event("input", { bubbles: true }));
          element.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        }
        return false;
      }

      const action = rawAction || {};
      const actionType = String(action.type || "");

      try {
        if (actionType === "ClickAction") {
          const element = resolveElement(action.selector);
          if (!element) {
            return { success: false, error: "click_selector_not_found" };
          }
          element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
          element.click();
          return { success: true };
        }

        if (actionType === "TypeAction" || actionType === "FillAction") {
          const element = resolveElement(action.selector);
          const text = String(action.text || action.value || "");
          if (!element) {
            return { success: false, error: "type_selector_not_found" };
          }
          const ok = fillElement(element, text);
          return ok ? { success: true } : { success: false, error: "type_target_not_fillable" };
        }

        if (actionType === "ScrollAction") {
          const direction = String(action.direction || "").toLowerCase();
          const amount = Number(action.amount || 600);
          let dx = 0;
          let dy = amount;

          if (direction === "up" || action.up) {
            dy = -amount;
          } else if (direction === "down" || action.down) {
            dy = amount;
          } else if (direction === "left") {
            dx = -amount;
            dy = 0;
          } else if (direction === "right") {
            dx = amount;
            dy = 0;
          }

          window.scrollBy(dx, dy);
          return { success: true };
        }

        if (actionType === "SendKeysAction") {
          const keys = String(action.keys || "");
          if (!keys) {
            return { success: false, error: "sendkeys_missing_keys" };
          }
          const target = document.activeElement || document.body;
          const event = new KeyboardEvent("keydown", {
            key: keys,
            bubbles: true,
            cancelable: true
          });
          target.dispatchEvent(event);
          return { success: true };
        }

        if (actionType === "NavigateAction") {
          const url = String(action.url || "");
          if (!url) {
            return { success: false, error: "navigate_missing_url" };
          }
          window.location.href = url;
          return { success: true };
        }

        return { success: false, error: `unsupported_dom_action:${actionType}` };
      } catch (error) {
        return {
          success: false,
          error: error && error.message ? error.message : "dom_action_error"
        };
      }
    },
    [action]
  );
}

function copyRun(run) {
  return JSON.parse(JSON.stringify(run));
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

async function persistRun(runId) {
  const run = runs.get(runId);
  if (!run) {
    return;
  }
  await saveRunToHistory(copyRun(run));
}

function appendTimelineItem(runId, title, status = "pending") {
  const run = runs.get(runId);
  if (!run) {
    return null;
  }

  const item = {
    id: `${run.timeline.length + 1}`,
    title,
    status,
    createdAt: nowIso(),
    completedAt: status === "succeeded" ? nowIso() : null
  };

  updateRun(runId, { timeline: [...run.timeline, item] });
  return item.id;
}

function patchTimelineItem(runId, itemId, patch) {
  const run = runs.get(runId);
  if (!run) {
    return;
  }

  const timeline = run.timeline.map((item) => {
    if (item.id !== itemId) {
      return item;
    }
    return {
      ...item,
      ...patch,
      completedAt: patch.status === "succeeded" || patch.status === "cancelled" || patch.status === "failed"
        ? nowIso()
        : item.completedAt
    };
  });

  updateRun(runId, { timeline });
}

function actionTitle(action) {
  if (!action || typeof action !== "object") {
    return "Unknown action";
  }

  const type = String(action.type || "UnknownAction");
  if (type === "NavigateAction") {
    return `Navigate to ${String(action.url || "target")}`;
  }
  if (type === "ClickAction") {
    return "Click element";
  }
  if (type === "TypeAction" || type === "FillAction") {
    const text = String(action.text || action.value || "");
    return `Type ${text ? `"${text.slice(0, 24)}${text.length > 24 ? "..." : ""}"` : "text"}`;
  }
  if (type === "ScrollAction") {
    return `Scroll ${String(action.direction || action.down ? "down" : "")}`.trim();
  }
  if (type === "WaitAction") {
    return `Wait ${String(action.time_seconds || 1)}s`;
  }
  if (type === "DoneAction" || type === "FinishAction") {
    return "Mark task completed";
  }

  return type;
}

async function callLocalAct(payload) {
  const response = await fetchWithTimeout(
    LOCAL_OPERATOR_ACT_URL,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    },
    90000
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`operator_act_error:${response.status}:${body.slice(0, 300)}`);
  }

  return response.json();
}

function normalizeActions(rawActions) {
  if (!Array.isArray(rawActions)) {
    return [];
  }

  const actions = [...rawActions];
  const done = actions.filter((a) => {
    const type = String((a && a.type) || "");
    return type === "DoneAction" || type === "FinishAction";
  });
  const rest = actions.filter((a) => {
    const type = String((a && a.type) || "");
    return type !== "DoneAction" && type !== "FinishAction";
  });
  return [...rest, ...done];
}

async function executeAction(tabId, action) {
  const type = String((action && action.type) || "");

  if (type === "DoneAction" || type === "FinishAction") {
    return { success: true, done: true };
  }

  if (type === "WaitAction") {
    const seconds = Number(action.time_seconds || 1);
    await sleep(Math.max(0, seconds) * 1000);
    return { success: true, done: false };
  }

  if (type === "NavigateAction") {
    const url = String(action.url || "");
    if (action.go_back) {
      await executeScriptOnTab(tabId, () => {
        history.back();
        return true;
      });
      await sleep(600);
      return { success: true, done: false };
    }

    if (action.go_forward) {
      await executeScriptOnTab(tabId, () => {
        history.forward();
        return true;
      });
      await sleep(600);
      return { success: true, done: false };
    }

    if (!url) {
      return { success: false, error: "navigate_missing_url", done: false };
    }

    await navigateTab(tabId, url);
    return { success: true, done: false };
  }

  const domResult = await executeDomAction(tabId, action);
  if (!domResult || !domResult.success) {
    return {
      success: false,
      error: domResult && domResult.error ? domResult.error : "dom_action_failed",
      done: false
    };
  }

  if (type === "ClickAction") {
    try {
      await waitForTabComplete(tabId, 5000);
    } catch (_error) {
      // navigation is optional on click
    }
  }

  return { success: true, done: false };
}

async function runLoop(runId) {
  const controller = runControllers.get(runId);
  if (!controller) {
    return;
  }

  try {
    const run = runs.get(runId);
    if (!run) {
      return;
    }

    if (!(await isLocalOperatorHealthy())) {
      throw new Error("local_operator_unreachable: start autoppia_operator at 127.0.0.1:5060");
    }

    const tabId = run.tabContext.tabId;
    if (typeof tabId !== "number") {
      throw new Error("active_tab_not_found");
    }

    const currentTab = await getTabContext(tabId);
    if (!isSupportedTabUrl(currentTab.url)) {
      throw new Error("unsupported_tab_url: open a regular http/https page");
    }

    if (run.startUrl && run.startUrl !== currentTab.url) {
      const navId = appendTimelineItem(runId, `Navigate to ${run.startUrl}`, "running");
      await persistRun(runId);
      try {
        await navigateTab(tabId, run.startUrl);
        patchTimelineItem(runId, navId, { status: "succeeded" });
      } catch (error) {
        patchTimelineItem(runId, navId, { status: "failed" });
        throw error;
      }
      await persistRun(runId);
    }

    let history = [];

    for (let stepIndex = 0; stepIndex < MAX_STEPS; stepIndex += 1) {
      if (controller.cancelled) {
        updateRun(runId, {
          status: "cancelled",
          result: {
            content: "Run cancelled by user",
            success: false,
            finishedAt: nowIso()
          }
        });
        await persistRun(runId);
        return;
      }

      const planId = appendTimelineItem(runId, `Plan step ${stepIndex + 1}`, "running");
      await persistRun(runId);

      let snapshot;
      try {
        snapshot = await captureSnapshot(tabId);
      } catch (error) {
        patchTimelineItem(runId, planId, { status: "failed" });
        throw error;
      }

      const actResponse = await callLocalAct({
        task_id: runId,
        prompt: run.prompt,
        url: snapshot.url,
        snapshot_html: snapshot.snapshot_html,
        step_index: stepIndex,
        history
      });

      patchTimelineItem(runId, planId, { status: "succeeded" });
      await persistRun(runId);

      const actions = normalizeActions(actResponse.actions || []);
      if (!actions.length) {
        updateRun(runId, {
          status: "succeeded",
          result: {
            content: "No more actions returned by operator. Task completed.",
            success: true,
            finishedAt: nowIso()
          },
          usage: actResponse.usage || null,
          estimated_cost_usd: actResponse.estimated_cost_usd || null,
          model: actResponse.model || null
        });
        await persistRun(runId);
        return;
      }

      for (const action of actions) {
        if (controller.cancelled) {
          updateRun(runId, {
            status: "cancelled",
            result: {
              content: "Run cancelled by user",
              success: false,
              finishedAt: nowIso()
            }
          });
          await persistRun(runId);
          return;
        }

        const actionId = appendTimelineItem(runId, actionTitle(action), "running");
        await persistRun(runId);

        let execution;
        try {
          execution = await executeAction(tabId, action);
        } catch (error) {
          execution = { success: false, error: error.message || "action_execution_error", done: false };
        }

        patchTimelineItem(runId, actionId, { status: execution.success ? "succeeded" : "failed" });

        const tabCtx = await getTabContext(tabId);
        history.push({
          step_index: stepIndex,
          action,
          success: execution.success,
          error: execution.error || null,
          url: tabCtx.url,
          at: nowIso()
        });

        updateRun(runId, {
          history,
          usage: actResponse.usage || null,
          estimated_cost_usd: actResponse.estimated_cost_usd || null,
          model: actResponse.model || null
        });
        await persistRun(runId);

        if (execution.done) {
          updateRun(runId, {
            status: "succeeded",
            result: {
              content: "Task completed by DoneAction.",
              success: true,
              finishedAt: nowIso()
            }
          });
          await persistRun(runId);
          return;
        }
      }
    }

    updateRun(runId, {
      status: "failed",
      result: {
        content: `Step limit reached (${MAX_STEPS}) before completion`,
        success: false,
        finishedAt: nowIso()
      }
    });
    await persistRun(runId);
  } catch (error) {
    updateRun(runId, {
      status: "failed",
      result: {
        content: error && error.message ? error.message : "run_failed",
        success: false,
        finishedAt: nowIso()
      }
    });
    await persistRun(runId);
  } finally {
    runControllers.delete(runId);
  }
}

async function startRun(payload) {
  const prompt = String(payload.prompt || "").trim();
  if (!prompt) {
    const error = new Error("Prompt is required");
    error.code = "invalid_prompt";
    throw error;
  }

  const startUrl = String(payload.startUrl || "").trim();
  if (startUrl && !isHttpUrl(startUrl)) {
    const error = new Error("Start URL must begin with http:// or https://");
    error.code = "invalid_start_url";
    throw error;
  }

  let tabCtx = await getActiveTabContext();
  const activeTabSupported = typeof tabCtx.tabId === "number" && isSupportedTabUrl(tabCtx.url);

  if (!activeTabSupported) {
    const fallbackUrl = startUrl || DEFAULT_FALLBACK_START_URL;
    const createdTab = await chrome.tabs.create({ url: fallbackUrl, active: true });
    if (!createdTab || typeof createdTab.id !== "number") {
      const error = new Error("Could not open a browser tab for execution");
      error.code = "tab_create_failed";
      throw error;
    }

    await waitForTabComplete(createdTab.id);
    tabCtx = await getTabContext(createdTab.id);
  }

  const run = {
    id: randomId("run"),
    prompt,
    startUrl,
    tabContext: tabCtx,
    status: "running",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    timeline: [],
    history: [],
    result: null,
    usage: null,
    estimated_cost_usd: null,
    model: null,
    provider: "local_operator"
  };

  runs.set(run.id, run);
  runControllers.set(run.id, { cancelled: false });
  await saveRunToHistory(copyRun(run));

  // run asynchronously so sidepanel gets immediate response
  runLoop(run.id).catch(async (error) => {
    updateRun(run.id, {
      status: "failed",
      result: {
        content: error && error.message ? error.message : "run_loop_crash",
        success: false,
        finishedAt: nowIso()
      }
    });
    await persistRun(run.id);
  });

  return copyRun(run);
}

async function cancelRun(runId) {
  const run = runs.get(runId);
  if (!run) {
    return null;
  }

  const controller = runControllers.get(runId);
  if (controller) {
    controller.cancelled = true;
  }

  if (run.status === "succeeded" || run.status === "failed") {
    return copyRun(run);
  }

  updateRun(runId, {
    status: "cancelled",
    result: {
      content: "Run cancelled by user",
      success: false,
      finishedAt: nowIso()
    }
  });
  await persistRun(runId);
  return copyRun(runs.get(runId));
}

async function handleMessage(message) {
  switch (message.type) {
    case "AUTH_STATUS": {
      const status = await tokenManager.getStatus();
      const localOperatorAvailable = await isLocalOperatorHealthy();
      return {
        ok: true,
        status: {
          ...status,
          localOperatorAvailable,
          executionProvider: "local_operator"
        }
      };
    }

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
