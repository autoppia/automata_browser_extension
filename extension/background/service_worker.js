import {
  exchangeApiKey,
  refreshAccessToken,
  revokeRefreshToken
} from "./mock_cloud_api.js";
import { createTokenManager } from "./token_manager.js";

const HISTORY_KEY = "run_history";
const MAX_HISTORY = 50;
const MAX_STEPS = 12;
const LOCAL_OPERATOR_PORT = 18060;
const LOCAL_OPERATOR_BASE_CANDIDATES = [
  `http://127.0.0.1:${LOCAL_OPERATOR_PORT}`
];
const DEFAULT_FALLBACK_START_URL = "https://example.com/";
const USER_INPUT_POLL_INTERVAL_MS = 300;
const MAX_EVENTS = 240;
const LOCAL_SESSION_KEY = "local_execution_session";
const LOCAL_SESSIONS_KEY = "local_execution_sessions_v1";
const LOCAL_ACTIVE_SESSION_KEY = "local_execution_active_session_id_v1";
const AUTOMATIONS_KEY = "automation_workflows_v1";
const LOCAL_OPERATOR_BASE_KEY = "local_operator_base_url";
const MAX_AUTOMATIONS = 120;
const MAX_SESSION_CONTEXT_TURNS = 4;
const MAX_SESSION_HISTORY_ITEMS = 40;
const RECORDING_POLL_INTERVAL_MS = 700;
const NETWORK_CANDIDATE_CACHE_MS = 30000;
let localOperatorBaseUrl = LOCAL_OPERATOR_BASE_CANDIDATES[0];
let recordingSession = null;
let networkCandidateCache = { at: 0, values: [] };

const tokenManager = createTokenManager({
  exchangeApiKey,
  refreshAccessToken,
  revokeRefreshToken
});

const runs = new Map();
const runControllers = new Map();

function isDoneActionType(typeValue) {
  const t = String(typeValue || "").trim().toLowerCase();
  return t === "doneaction" || t === "finishaction" || t === "done" || t === "finish";
}

function isReportResultActionType(typeValue) {
  const t = String(typeValue || "").trim().toLowerCase().replaceAll("-", "_");
  return t === "reportresultaction" || t === "report_result" || t === "report_result_action";
}

function isRequestUserInputActionType(typeValue) {
  const t = String(typeValue || "").trim().toLowerCase().replaceAll("-", "_");
  return t === "requestuserinputaction" || t === "request_user_input" || t === "request_user_input_action";
}

function normalizeActionType(rawType) {
  const original = String(rawType || "").trim();
  if (!original) {
    return original;
  }
  const dotted = original.toLowerCase().replaceAll("-", "_");
  const key = dotted.includes(".") ? dotted.split(".").slice(1).join(".") : dotted;
  if (key === "click") return "ClickAction";
  if (key === "type" || key === "fill") return "TypeAction";
  if (key === "navigate") return "NavigateAction";
  if (key === "wait") return "WaitAction";
  if (key === "scroll") return "ScrollAction";
  if (key === "done" || key === "finish") return "DoneAction";
  if (key === "report_result" || key === "report_result_action" || key === "reportresult" || key === "reportresultaction") {
    return "ReportResultAction";
  }
  if (key === "run_workflow" || key === "runworkflow" || key === "workflow") return "RunWorkflowAction";
  if (key === "send_keys" || key === "sendkeys" || key === "sendkeysiwaaction") return "SendKeysIWAAction";
  if (key === "request_input" || key === "request_user_input" || key === "request_user_input_action" || key === "requestuserinputaction") {
    return "RequestUserInputAction";
  }
  if (original.endsWith("Action")) {
    return original;
  }
  if (original.includes("_")) {
    return `${original.split("_").map((part) => part ? part[0].toUpperCase() + part.slice(1) : "").join("")}Action`;
  }
  return `${original[0].toUpperCase()}${original.slice(1)}Action`;
}

function normalizeActionObject(rawAction) {
  if (!rawAction || typeof rawAction !== "object") {
    return null;
  }
  const normalized = { ...rawAction };
  normalized.type = normalizeActionType(normalized.type);
  return normalized;
}

function mapToolNameToActionType(name) {
  const raw = String(name || "").trim().toLowerCase().replaceAll("-", "_");
  if (!raw) {
    return "";
  }
  if (raw.startsWith("browser.")) {
    const suffix = raw.split(".").slice(1).join(".");
    return suffix || "";
  }
  if (raw === "user.request_input") {
    return "request_user_input";
  }
  return raw;
}

function parseToolCall(toolCall) {
  if (!toolCall || typeof toolCall !== "object") {
    return null;
  }
  const fnPayload = toolCall.function && typeof toolCall.function === "object" ? toolCall.function : toolCall;
  const name = String(fnPayload.name || "").trim();
  if (!name) {
    return null;
  }
  const mappedType = mapToolNameToActionType(name);
  let argumentsObject = {};
  if (fnPayload.arguments && typeof fnPayload.arguments === "object") {
    argumentsObject = { ...fnPayload.arguments };
  } else if (typeof fnPayload.arguments === "string") {
    const raw = fnPayload.arguments.trim();
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") {
          argumentsObject = parsed;
        }
      } catch (_error) {
        argumentsObject = {};
      }
    }
  }
  return normalizeActionObject({ ...argumentsObject, type: argumentsObject.type || mappedType || name });
}

function candidateToText(value) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const parsed = candidateToText(item);
      if (parsed) {
        return parsed;
      }
    }
    return null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || null;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value && typeof value === "object") {
    for (const key of ["text", "content", "message", "summary", "answer", "result", "final_text", "final_answer"]) {
      const nested = candidateToText(value[key]);
      if (nested) {
        return nested;
      }
    }
    try {
      const compact = JSON.stringify(value);
      return compact && compact.length <= 2000 ? compact : null;
    } catch (_error) {
      return null;
    }
  }
  return null;
}

function firstTextCandidate(...values) {
  for (const value of values) {
    const parsed = candidateToText(value);
    if (parsed) {
      return parsed;
    }
  }
  return null;
}

function extractFinalTextFromDoneAction(action) {
  const payload = action && typeof action === "object" ? action : {};
  return firstTextCandidate(
    payload.final_text,
    payload.final_answer,
    payload.summary,
    payload.answer,
    payload.result,
    payload.output,
    payload.content,
    payload.text,
    payload.message
  );
}

function extractFinalTextFromResultAction(action) {
  const payload = action && typeof action === "object" ? action : {};
  return firstTextCandidate(
    payload.content,
    payload.final_text,
    payload.final_answer,
    payload.summary,
    payload.answer,
    payload.result,
    payload.output,
    payload.text,
    payload.message
  );
}

function randomId(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

function nowIso() {
  return new Date().toISOString();
}

function errorMessage(error, fallback = "unknown_error") {
  if (typeof error === "string" && error.trim()) {
    return error;
  }
  if (error && typeof error.message === "string" && error.message.trim()) {
    return error.message;
  }
  return fallback;
}

function codedError(code, message, extra = null) {
  const err = new Error(String(message || code || "unknown_error"));
  err.code = String(code || "unknown_error");
  if (extra && typeof extra === "object") {
    Object.assign(err, extra);
  }
  return err;
}

function normalizeRunFailure(error) {
  const raw = errorMessage(error, "run_failed");
  let code = "";
  let message = raw;
  let status = null;

  if (error && typeof error.code === "string" && error.code.trim()) {
    code = String(error.code).trim();
  }

  if (!code) {
    if (raw === "active_tab_not_found") {
      code = "active_tab_not_found";
    } else if (raw === "snapshot_failed") {
      code = "snapshot_failed";
    } else if (raw.startsWith("unsupported_tab_url")) {
      code = "unsupported_tab_url";
    } else if (raw.startsWith("local_operator_unreachable")) {
      code = "local_operator_unreachable";
    } else if (raw.startsWith("operator_act_error:")) {
      code = "operator_http_error";
      const parts = raw.split(":");
      const parsedStatus = Number(parts[1] || 0);
      status = Number.isFinite(parsedStatus) && parsedStatus > 0 ? parsedStatus : null;
    } else if (raw.startsWith("operator_error:")) {
      code = "operator_error";
    } else if (raw.includes("operator returned no actions")) {
      code = "operator_no_actions";
    } else if (raw.includes("navigation_failed")) {
      code = "navigation_failed";
    } else if (raw.startsWith("workflow_step_failed")) {
      code = "workflow_step_failed";
    } else if (raw.includes("workflow_not_found_or_empty")) {
      code = "workflow_not_found_or_empty";
    } else {
      code = "run_failed";
    }
  }

  if (code === "invalid_prompt") {
    message = "Prompt is required.";
  } else if (code === "invalid_start_url") {
    message = "Start URL must begin with http:// or https://.";
  } else if (code === "tab_create_failed") {
    message = "Could not open a browser tab for execution.";
  } else if (code === "active_tab_not_found") {
    message = "No active browser tab found for execution.";
  } else if (code === "unsupported_tab_url") {
    message = "Open a regular http/https page first or provide Start URL.";
  } else if (code === "snapshot_failed") {
    message = "Could not capture page snapshot. Reload the page and try again.";
  } else if (code === "local_operator_unreachable") {
    message = "Local operator unreachable at 127.0.0.1:18060. Start autoppia_operator and retry.";
  } else if (code === "operator_http_error") {
    if (!status && error && Number.isFinite(Number(error.status))) {
      status = Number(error.status);
    }
    message = status
      ? `Operator /act returned HTTP ${status}.`
      : "Operator /act returned an HTTP error.";
  } else if (code === "operator_error") {
    message = raw.startsWith("operator_error:")
      ? `Operator error: ${raw.slice("operator_error:".length).trim() || "unknown"}`
      : "Operator returned an internal error.";
  } else if (code === "operator_no_actions") {
    message = "Operator returned no actions and did not mark completion.";
  } else if (code === "navigation_failed") {
    message = "Navigation failed. Check Start URL and internet access.";
  } else if (code === "workflow_step_failed") {
    message = "Workflow step failed. Agent takeover can continue planning from this state.";
  } else if (code === "workflow_not_found_or_empty") {
    message = "Workflow not found or it has no steps.";
  } else if (code === "max_steps_reached") {
    message = `Step limit reached (${MAX_STEPS}) before completion.`;
  }

  return {
    code,
    message,
    raw_message: raw,
    status
  };
}

function buildRunFailure(error) {
  const normalized = normalizeRunFailure(error);
  return {
    code: normalized.code,
    message: normalized.message,
    raw_message: normalized.raw_message,
    status: normalized.status,
    at: nowIso()
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isHttpBaseUrl(value) {
  try {
    const parsed = new URL(String(value || "").trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch (_error) {
    return false;
  }
}

function normalizeOperatorBaseUrl(value) {
  let normalized = String(value || "").trim().replace(/\/+$/, "");
  // Migrate from legacy blocked/conflicting ports to safe default.
  if (normalized.endsWith(":5060") || normalized.endsWith(":8765")) {
    normalized = `${normalized.slice(0, -5)}:${LOCAL_OPERATOR_PORT}`;
  }
  if (!isHttpBaseUrl(normalized)) {
    return null;
  }
  return normalized;
}

function buildOperatorUrl(base, path) {
  return `${String(base || "").replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}

async function discoverNetworkOperatorCandidates() {
  // Chrome extensions (MV3) do not expose network interface enumeration.
  // Keep candidates deterministic and rely on user-provided Operator URL.
  const now = Date.now();
  if ((now - Number(networkCandidateCache.at || 0)) >= NETWORK_CANDIDATE_CACHE_MS) {
    networkCandidateCache = { at: now, values: [] };
  }
  return Array.isArray(networkCandidateCache.values) ? networkCandidateCache.values : [];
}

async function loadSavedOperatorBaseUrl() {
  try {
    const data = await chrome.storage.local.get(LOCAL_OPERATOR_BASE_KEY);
    const normalized = normalizeOperatorBaseUrl(data[LOCAL_OPERATOR_BASE_KEY]);
    if (normalized) {
      localOperatorBaseUrl = normalized;
    }
  } catch (_error) {
    // ignore storage boot failures
  }
}

async function setSavedOperatorBaseUrl(baseUrl) {
  const normalized = normalizeOperatorBaseUrl(baseUrl);
  if (!normalized) {
    throw codedError("invalid_operator_base_url", "Operator URL must start with http:// or https://");
  }
  localOperatorBaseUrl = normalized;
  await chrome.storage.local.set({ [LOCAL_OPERATOR_BASE_KEY]: normalized });
  return normalized;
}

async function operatorCandidatesOrdered() {
  const discovered = await discoverNetworkOperatorCandidates();
  const ordered = [localOperatorBaseUrl, ...LOCAL_OPERATOR_BASE_CANDIDATES, ...discovered];
  return [...new Set(ordered.filter((x) => typeof x === "string" && x.trim()))];
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
  const candidates = await operatorCandidatesOrdered();
  for (const base of candidates) {
    try {
      const response = await fetchWithTimeout(buildOperatorUrl(base, "/health"), {}, 3500);
      if (response.ok) {
        localOperatorBaseUrl = base;
        return true;
      }
    } catch (_error) {
      // probe next base candidate
    }
  }
  return false;
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
    throw codedError("snapshot_failed", "snapshot_failed");
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

        if (actionType === "SelectAction") {
          const element = resolveElement(action.selector);
          const value = String(action.value || "");
          if (!element) {
            return { success: false, error: "select_selector_not_found" };
          }
          if (!("tagName" in element) || String(element.tagName || "").toLowerCase() !== "select") {
            return { success: false, error: "select_target_not_select" };
          }
          element.value = value;
          element.dispatchEvent(new Event("input", { bubbles: true }));
          element.dispatchEvent(new Event("change", { bubbles: true }));
          return { success: true };
        }

        if (actionType === "SelectDropDownOptionAction") {
          const element = resolveElement(action.selector);
          const text = String(action.text || "");
          if (!element) {
            return { success: false, error: "select_option_selector_not_found" };
          }
          if (!("tagName" in element) || String(element.tagName || "").toLowerCase() !== "select") {
            return { success: false, error: "select_option_target_not_select" };
          }
          const options = Array.from(element.options || []);
          const picked = options.find((opt) => String(opt.text || "").trim() === text) || options.find((opt) => String(opt.value || "") === text);
          if (!picked) {
            return { success: false, error: "select_option_not_found" };
          }
          element.value = picked.value;
          element.dispatchEvent(new Event("input", { bubbles: true }));
          element.dispatchEvent(new Event("change", { bubbles: true }));
          return { success: true };
        }

        if (actionType === "HoverAction") {
          const element = resolveElement(action.selector);
          if (!element) {
            return { success: false, error: "hover_selector_not_found" };
          }
          element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
          const evt = new MouseEvent("mouseover", { bubbles: true, cancelable: true, view: window });
          element.dispatchEvent(evt);
          return { success: true };
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

          const beforeX = Number(window.scrollX || 0);
          const beforeY = Number(window.scrollY || 0);
          const doc = document.documentElement || document.body;
          const scrollWidth = Number((doc && doc.scrollWidth) || 0);
          const scrollHeight = Number((doc && doc.scrollHeight) || 0);
          const viewportWidth = Number(window.innerWidth || 0);
          const viewportHeight = Number(window.innerHeight || 0);

          window.scrollBy(dx, dy);

          const afterX = Number(window.scrollX || 0);
          const afterY = Number(window.scrollY || 0);
          const moved = Math.abs(afterX - beforeX) > 1 || Math.abs(afterY - beforeY) > 1;
          const verticallyScrollable = scrollHeight > viewportHeight + 1;
          const horizontallyScrollable = scrollWidth > viewportWidth + 1;

          if (!moved) {
            const notScrollable = (Math.abs(dy) > 0 && !verticallyScrollable) || (Math.abs(dx) > 0 && !horizontallyScrollable);
            return {
              success: true,
              no_effect: true,
              detail: `${notScrollable ? "no_scrollable_area" : "no_scroll_delta"} before(${beforeX},${beforeY}) after(${afterX},${afterY})`
            };
          }
          return {
            success: true,
            detail: `before(${beforeX},${beforeY}) after(${afterX},${afterY})`
          };
        }

        if (actionType === "SendKeysAction" || actionType === "SendKeysIWAAction") {
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

function normalizeSessionRecord(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const id = String(raw.id || "").trim();
  if (!id) {
    return null;
  }
  const createdAt = String(raw.createdAt || raw.created_at || "").trim() || nowIso();
  const updatedAt = String(raw.updatedAt || raw.updated_at || raw.lastRunAt || "").trim() || createdAt;
  const runCount = Number.isFinite(Number(raw.runCount)) ? Math.max(0, Number(raw.runCount)) : 0;
  const title = String(raw.title || "").trim();
  return {
    id,
    title: title || null,
    createdAt,
    updatedAt,
    lastRunAt: String(raw.lastRunAt || "").trim() || null,
    runCount
  };
}

function sessionTitleFromPrompt(prompt) {
  const text = String(prompt || "").trim();
  if (!text) {
    return null;
  }
  return text.slice(0, 56);
}

async function loadSessionsState() {
  const data = await chrome.storage.local.get([LOCAL_SESSIONS_KEY, LOCAL_ACTIVE_SESSION_KEY, LOCAL_SESSION_KEY]);
  let sessions = Array.isArray(data[LOCAL_SESSIONS_KEY]) ? data[LOCAL_SESSIONS_KEY].map(normalizeSessionRecord).filter(Boolean) : [];
  let activeSessionId = String(data[LOCAL_ACTIVE_SESSION_KEY] || "").trim();

  if (!sessions.length) {
    const legacy = normalizeSessionRecord(data[LOCAL_SESSION_KEY]);
    if (legacy) {
      sessions = [legacy];
      activeSessionId = activeSessionId || legacy.id;
    }
  }

  if (!sessions.length) {
    const createdAt = nowIso();
    const created = {
      id: randomId("session"),
      title: "New session",
      createdAt,
      updatedAt: createdAt,
      lastRunAt: null,
      runCount: 0
    };
    sessions = [created];
    activeSessionId = created.id;
  }

  sessions.sort((a, b) => {
    const ta = new Date(a.updatedAt || a.createdAt || 0).getTime();
    const tb = new Date(b.updatedAt || b.createdAt || 0).getTime();
    return tb - ta;
  });

  if (!activeSessionId || !sessions.some((item) => item.id === activeSessionId)) {
    activeSessionId = sessions[0].id;
  }

  await chrome.storage.local.set({
    [LOCAL_SESSIONS_KEY]: sessions,
    [LOCAL_ACTIVE_SESSION_KEY]: activeSessionId
  });
  return { sessions, activeSessionId };
}

async function listSessions() {
  const state = await loadSessionsState();
  return {
    sessions: state.sessions,
    activeSessionId: state.activeSessionId
  };
}

async function setActiveSession(sessionId) {
  const requested = String(sessionId || "").trim();
  const state = await loadSessionsState();
  const nextId = state.sessions.some((item) => item.id === requested) ? requested : state.activeSessionId;
  await chrome.storage.local.set({ [LOCAL_ACTIVE_SESSION_KEY]: nextId });
  return {
    sessions: state.sessions,
    activeSessionId: nextId
  };
}

async function createSession(name = "") {
  const state = await loadSessionsState();
  const createdAt = nowIso();
  const session = {
    id: randomId("session"),
    title: String(name || "").trim() || "New session",
    createdAt,
    updatedAt: createdAt,
    lastRunAt: null,
    runCount: 0
  };
  const sessions = [session, ...state.sessions];
  await chrome.storage.local.set({
    [LOCAL_SESSIONS_KEY]: sessions,
    [LOCAL_ACTIVE_SESSION_KEY]: session.id
  });
  return { sessions, activeSessionId: session.id, session };
}

async function touchLocalSession({ sessionId = "", prompt = "" } = {}) {
  const state = await loadSessionsState();
  const now = nowIso();
  const preferredId = String(sessionId || "").trim() || state.activeSessionId;
  let found = false;
  const sessions = state.sessions.map((item) => {
    if (item.id !== preferredId) {
      return item;
    }
    found = true;
    const title = item.title || sessionTitleFromPrompt(prompt) || "New session";
    return {
      ...item,
      title,
      runCount: Number(item.runCount || 0) + 1,
      lastRunAt: now,
      updatedAt: now
    };
  });
  if (!found) {
    const created = {
      id: preferredId || randomId("session"),
      title: sessionTitleFromPrompt(prompt) || "New session",
      createdAt: now,
      updatedAt: now,
      lastRunAt: now,
      runCount: 1
    };
    sessions.unshift(created);
  }
  sessions.sort((a, b) => {
    const ta = new Date(a.updatedAt || a.createdAt || 0).getTime();
    const tb = new Date(b.updatedAt || b.createdAt || 0).getTime();
    return tb - ta;
  });

  const activeId = found ? preferredId : sessions[0].id;
  await chrome.storage.local.set({
    [LOCAL_SESSIONS_KEY]: sessions,
    [LOCAL_ACTIVE_SESSION_KEY]: activeId,
    // keep legacy session key for compatibility with previously installed versions
    [LOCAL_SESSION_KEY]: sessions.find((item) => item.id === activeId) || sessions[0]
  });

  const active = sessions.find((item) => item.id === activeId) || sessions[0];
  return {
    session: active,
    sessions,
    activeSessionId: activeId
  };
}

function historyBySession(history, sessionId) {
  const sid = String(sessionId || "").trim();
  if (!sid) {
    return [];
  }
  return (Array.isArray(history) ? history : [])
    .filter((item) => item && String(item.session_id || "") === sid)
    .sort((a, b) => new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime());
}

function safeShortText(value, maxLen = 220) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) {
    return "";
  }
  return text.length > maxLen ? `${text.slice(0, maxLen)}...` : text;
}

function buildSessionPromptContext(history, sessionId, prompt) {
  const runsInSession = historyBySession(history, sessionId);
  const turns = runsInSession
    .filter((run) => run && String(run.status || "") === "succeeded")
    .slice(-MAX_SESSION_CONTEXT_TURNS)
    .map((run) => {
      const user = safeShortText(run.prompt, 220);
      const assistant = safeShortText(run.result && typeof run.result === "object" ? run.result.content : "", 320);
      return {
        user,
        assistant
      };
    })
    .filter((turn) => turn.user || turn.assistant);

  if (!turns.length) {
    return String(prompt || "").trim();
  }

  const lines = ["Session context from previous turns (for continuity):"];
  turns.forEach((turn, index) => {
    const n = index + 1;
    if (turn.user) {
      lines.push(`Turn ${n} user: ${turn.user}`);
    }
    if (turn.assistant) {
      lines.push(`Turn ${n} agent result: ${turn.assistant}`);
    }
  });
  lines.push(`Current user request: ${String(prompt || "").trim()}`);
  return lines.join("\n");
}

function buildSessionCarryHistory(history, sessionId) {
  const runsInSession = historyBySession(history, sessionId).slice(-MAX_SESSION_CONTEXT_TURNS);
  const out = [];
  runsInSession.forEach((run) => {
    const runHistory = Array.isArray(run.history) ? run.history : [];
    runHistory.slice(-MAX_SESSION_HISTORY_ITEMS).forEach((item) => {
      if (!item || typeof item !== "object") {
        return;
      }
      out.push({
        step_index: Number.isFinite(Number(item.step_index)) ? Number(item.step_index) : 0,
        action: item.action && typeof item.action === "object" ? item.action : {},
        success: item.success === true,
        error: item.error || null,
        user_input: typeof item.user_input === "string" ? item.user_input : undefined,
        url: String(item.url || ""),
        at: String(item.at || "")
      });
    });
  });
  if (out.length <= MAX_SESSION_HISTORY_ITEMS) {
    return out;
  }
  return out.slice(out.length - MAX_SESSION_HISTORY_ITEMS);
}

async function saveRunToHistory(run) {
  const history = await loadHistory();
  const runForHistory = copyRun(run);
  delete runForHistory.carry_history;
  const filtered = history.filter((item) => item.id !== run.id);
  filtered.unshift(runForHistory);
  await chrome.storage.local.set({ [HISTORY_KEY]: filtered.slice(0, MAX_HISTORY) });
}

async function clearStoredHistory() {
  await chrome.storage.local.remove(HISTORY_KEY);
}

async function loadAutomations() {
  const data = await chrome.storage.local.get(AUTOMATIONS_KEY);
  return Array.isArray(data[AUTOMATIONS_KEY]) ? data[AUTOMATIONS_KEY] : [];
}

async function saveAutomations(automations) {
  const list = Array.isArray(automations) ? automations : [];
  await chrome.storage.local.set({ [AUTOMATIONS_KEY]: list.slice(0, MAX_AUTOMATIONS) });
}

async function getAutomationById(automationId) {
  const id = String(automationId || "").trim();
  if (!id) {
    return null;
  }
  const list = await loadAutomations();
  return list.find((item) => item && String(item.id || "") === id) || null;
}

async function getAutomationByName(name) {
  const target = String(name || "").trim().toLowerCase();
  if (!target) {
    return null;
  }
  const list = await loadAutomations();
  return list.find((item) => String(item && item.name ? item.name : "").trim().toLowerCase() === target) || null;
}

function areSelectorsEquivalent(a, b) {
  try {
    return JSON.stringify(a || null) === JSON.stringify(b || null);
  } catch (_error) {
    return false;
  }
}

function appendRecordedStep(draft, action) {
  if (!draft || !Array.isArray(draft.steps)) {
    return;
  }
  const normalized = normalizeActionObject(action);
  if (!normalized || !normalized.type) {
    return;
  }

  const steps = draft.steps;
  const previous = steps.length ? steps[steps.length - 1] : null;

  if (
    previous
    && previous.type === "NavigateAction"
    && normalized.type === "NavigateAction"
    && String(previous.url || "") === String(normalized.url || "")
  ) {
    return;
  }

  if (
    previous
    && previous.type === "TypeAction"
    && normalized.type === "TypeAction"
    && areSelectorsEquivalent(previous.selector, normalized.selector)
  ) {
    previous.text = String(normalized.text || normalized.value || "");
    return;
  }

  steps.push(normalized);
}

function convertRecorderEventToAction(rawEvent) {
  if (!rawEvent || typeof rawEvent !== "object") {
    return null;
  }

  const type = String(rawEvent.type || "").trim().toLowerCase();
  const selector = rawEvent.selector && typeof rawEvent.selector === "object" ? rawEvent.selector : null;
  if (type === "click" && selector) {
    return normalizeActionObject({ type: "ClickAction", selector });
  }
  if (type === "change" && selector) {
    return normalizeActionObject({
      type: "TypeAction",
      selector,
      text: String(rawEvent.value || "")
    });
  }
  if (type === "send_keys") {
    return normalizeActionObject({
      type: "SendKeysIWAAction",
      keys: String(rawEvent.keys || "Enter")
    });
  }
  return null;
}

async function installRecorderOnTab(tabId) {
  return executeScriptOnTab(
    tabId,
    () => {
      if (window.__automataRecorderInstalled) {
        return { installed: true };
      }

      const queue = [];

      function clipText(text, maxLen = 96) {
        const value = String(text || "").replace(/\s+/g, " ").trim();
        return value.length > maxLen ? value.slice(0, maxLen) : value;
      }

      function makeSelector(target) {
        if (!target || !(target instanceof Element)) {
          return null;
        }
        const el = target;
        if (el.id) {
          return { type: "attributeValueSelector", attribute: "id", value: String(el.id) };
        }
        const testId = el.getAttribute("data-testid");
        if (testId) {
          return { type: "attributeValueSelector", attribute: "data-testid", value: String(testId) };
        }
        const nameAttr = el.getAttribute("name");
        if (nameAttr) {
          return { type: "attributeValueSelector", attribute: "name", value: String(nameAttr) };
        }
        const ariaLabel = el.getAttribute("aria-label");
        if (ariaLabel) {
          return { type: "attributeValueSelector", attribute: "aria-label", value: String(ariaLabel) };
        }
        if (el.tagName && el.tagName.toLowerCase() === "a") {
          const href = el.getAttribute("href");
          if (href) {
            return { type: "attributeValueSelector", attribute: "href", value: String(href) };
          }
        }
        const text = clipText(el.textContent || "");
        if (text) {
          return { type: "textSelector", text };
        }
        return null;
      }

      function push(event) {
        queue.push({
          ...event,
          ts: Date.now()
        });
        if (queue.length > 600) {
          queue.shift();
        }
      }

      function onClick(ev) {
        const selector = makeSelector(ev.target);
        if (!selector) {
          return;
        }
        push({ type: "click", selector });
      }

      function onChange(ev) {
        const target = ev.target;
        if (!target || !(target instanceof Element)) {
          return;
        }
        const tag = String(target.tagName || "").toLowerCase();
        if (!["input", "textarea", "select"].includes(tag)) {
          return;
        }
        const selector = makeSelector(target);
        if (!selector) {
          return;
        }
        const value = "value" in target ? String(target.value || "") : "";
        push({ type: "change", selector, value });
      }

      function onKeyDown(ev) {
        if (ev.key !== "Enter") {
          return;
        }
        push({ type: "send_keys", keys: "Enter" });
      }

      document.addEventListener("click", onClick, true);
      document.addEventListener("change", onChange, true);
      document.addEventListener("keydown", onKeyDown, true);

      window.__automataRecorderInstalled = true;
      window.__automataRecorderDrain = () => {
        const out = queue.slice();
        queue.length = 0;
        return out;
      };
      window.__automataRecorderCleanup = () => {
        document.removeEventListener("click", onClick, true);
        document.removeEventListener("change", onChange, true);
        document.removeEventListener("keydown", onKeyDown, true);
        window.__automataRecorderInstalled = false;
        window.__automataRecorderDrain = null;
        window.__automataRecorderCleanup = null;
      };

      return { installed: true };
    }
  );
}

async function teardownRecorderOnTab(tabId) {
  try {
    await executeScriptOnTab(
      tabId,
      () => {
        if (typeof window.__automataRecorderCleanup === "function") {
          window.__automataRecorderCleanup();
        }
        return true;
      }
    );
  } catch (_error) {
    // best effort
  }
}

async function pullRecorderEvents(tabId) {
  const payload = await executeScriptOnTab(
    tabId,
    () => {
      const url = window.location.href;
      const drain = typeof window.__automataRecorderDrain === "function"
        ? window.__automataRecorderDrain
        : null;
      const events = drain ? drain() : [];
      return {
        url,
        events: Array.isArray(events) ? events : [],
        installed: Boolean(window.__automataRecorderInstalled)
      };
    }
  );
  return payload && typeof payload === "object"
    ? payload
    : { url: "", events: [], installed: false };
}

async function pollRecordingSession(session = recordingSession) {
  if (!session || !session.active || !session.draft) {
    return;
  }
  const draft = session.draft;
  const tabId = Number(draft.tabId);
  if (!Number.isFinite(tabId)) {
    return;
  }

  try {
    const pulled = await pullRecorderEvents(tabId);
    if (!pulled.installed) {
      await installRecorderOnTab(tabId);
    }
    if (pulled.url && pulled.url !== draft.lastUrl && isHttpUrl(pulled.url)) {
      appendRecordedStep(draft, { type: "NavigateAction", url: pulled.url });
      draft.lastUrl = pulled.url;
    }
    const events = Array.isArray(pulled.events) ? pulled.events : [];
    for (const event of events) {
      const action = convertRecorderEventToAction(event);
      if (action) {
        appendRecordedStep(draft, action);
      }
    }
    draft.raw_events = Number(draft.raw_events || 0) + events.length;
    draft.updated_at = nowIso();
  } catch (_error) {
    // tab could be navigating or temporarily unavailable
  }
}

async function startRecording(payload = {}) {
  if (recordingSession && recordingSession.active) {
    throw codedError("recording_already_active", "A recording session is already active.");
  }

  const tabCtx = await getActiveTabContext();
  if (typeof tabCtx.tabId !== "number") {
    throw codedError("active_tab_not_found", "No active tab found for recording.");
  }
  if (!isSupportedTabUrl(tabCtx.url) || !isHttpUrl(tabCtx.url)) {
    throw codedError("unsupported_tab_url", "Open a regular http/https page before recording.");
  }

  await installRecorderOnTab(tabCtx.tabId);

  const now = nowIso();
  const draft = {
    id: randomId("recording"),
    name: String(payload.name || "").trim(),
    tabId: tabCtx.tabId,
    started_at: now,
    updated_at: now,
    start_url: String(tabCtx.url || ""),
    lastUrl: String(tabCtx.url || ""),
    raw_events: 0,
    steps: []
  };
  appendRecordedStep(draft, { type: "NavigateAction", url: draft.start_url });

  const pollId = setInterval(() => {
    pollRecordingSession().catch(() => {});
  }, RECORDING_POLL_INTERVAL_MS);

  recordingSession = {
    active: true,
    pollId,
    draft
  };

  return {
    active: true,
    tabId: draft.tabId,
    started_at: draft.started_at,
    step_count: draft.steps.length
  };
}

async function stopRecording(payload = {}) {
  if (!recordingSession || !recordingSession.active || !recordingSession.draft) {
    throw codedError("recording_not_active", "No active recording session.");
  }

  const current = recordingSession;
  if (current.pollId) {
    clearInterval(current.pollId);
  }

  const draft = current.draft;
  await pollRecordingSession(current);
  await teardownRecorderOnTab(draft.tabId);
  recordingSession = null;

  const shouldSave = payload.save !== false;
  if (!shouldSave) {
    return {
      saved: false,
      active: false,
      draft: {
        ...draft,
        step_count: Array.isArray(draft.steps) ? draft.steps.length : 0
      }
    };
  }

  const name = String(payload.name || draft.name || "").trim() || `Workflow ${new Date().toLocaleString()}`;
  const automation = {
    id: randomId("wf"),
    name,
    description: String(payload.description || "").trim(),
    created_at: nowIso(),
    updated_at: nowIso(),
    source: "recording",
    start_url: String(draft.start_url || ""),
    raw_events: Number(draft.raw_events || 0),
    steps: Array.isArray(draft.steps) ? draft.steps.slice(0, 400) : []
  };

  const existing = await loadAutomations();
  const deduped = existing.filter((item) => String(item && item.id ? item.id : "") !== automation.id);
  deduped.unshift(automation);
  await saveAutomations(deduped);

  return {
    saved: true,
    active: false,
    automation
  };
}

function getRecordingStatus() {
  if (!recordingSession || !recordingSession.active || !recordingSession.draft) {
    return { active: false };
  }
  const draft = recordingSession.draft;
  return {
    active: true,
    tabId: draft.tabId,
    started_at: draft.started_at,
    updated_at: draft.updated_at,
    step_count: Array.isArray(draft.steps) ? draft.steps.length : 0,
    raw_events: Number(draft.raw_events || 0)
  };
}

async function deleteAutomation(automationId) {
  const id = String(automationId || "").trim();
  if (!id) {
    return false;
  }
  const current = await loadAutomations();
  const next = current.filter((item) => String(item && item.id ? item.id : "") !== id);
  const changed = next.length !== current.length;
  if (changed) {
    await saveAutomations(next);
  }
  return changed;
}

async function buildPromptWithAutomationTools(prompt) {
  const basePrompt = String(prompt || "");
  const automations = await loadAutomations();
  if (!automations.length) {
    return basePrompt;
  }
  const top = automations.slice(0, 12);
  const lines = top.map((item) => {
    const id = String(item.id || "");
    const name = String(item.name || "workflow");
    const stepCount = Array.isArray(item.steps) ? item.steps.length : 0;
    const startUrl = String(item.start_url || "");
    return `- ${id}: ${name} (${stepCount} steps${startUrl ? `, start: ${startUrl}` : ""})`;
  });

  const guidance = [
    "",
    "Local workflow tools available (execute via RunWorkflowAction):",
    ...lines,
    "When a workflow matches the task, you may return RunWorkflowAction with {workflow_id, recovery_mode}.",
    "Prefer recovery_mode='agent_takeover' so planner can continue if a workflow step fails."
  ].join("\n");

  const joined = `${basePrompt}\n${guidance}`.trim();
  return joined.length > 6000 ? joined.slice(0, 6000) : joined;
}

function defaultAllowedTools() {
  return [
    {
      name: "browser.navigate",
      description: "Navigate the current tab to a URL or move browser history.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string" },
          go_back: { type: "boolean" },
          go_forward: { type: "boolean" }
        },
        additionalProperties: true
      }
    },
    {
      name: "browser.click",
      description: "Click an element in the current page.",
      parameters: { type: "object", properties: { selector: { type: "object" } }, required: ["selector"], additionalProperties: true }
    },
    {
      name: "browser.type",
      description: "Type/fill text into an element.",
      parameters: {
        type: "object",
        properties: { selector: { type: "object" }, text: { type: "string" }, value: { type: "string" } },
        required: ["selector"],
        additionalProperties: true
      }
    },
    {
      name: "browser.scroll",
      description: "Scroll in the page viewport.",
      parameters: { type: "object", properties: { direction: { type: "string" }, amount: { type: "number" } }, additionalProperties: true }
    },
    {
      name: "browser.wait",
      description: "Wait for a short period before the next action.",
      parameters: { type: "object", properties: { time_seconds: { type: "number" } }, additionalProperties: true }
    },
    {
      name: "browser.select",
      description: "Select a value from a dropdown.",
      parameters: {
        type: "object",
        properties: { selector: { type: "object" }, value: { type: "string" } },
        required: ["selector", "value"],
        additionalProperties: true
      }
    },
    {
      name: "browser.hover",
      description: "Hover over an element.",
      parameters: { type: "object", properties: { selector: { type: "object" } }, required: ["selector"], additionalProperties: true }
    },
    {
      name: "browser.hold_key",
      description: "Hold/release a keyboard key in the focused page.",
      parameters: {
        type: "object",
        properties: { key: { type: "string" }, release: { type: "boolean" }, duration_ms: { type: "number" } },
        required: ["key"],
        additionalProperties: true
      }
    },
    {
      name: "browser.send_keys",
      description: "Send keyboard shortcut keys to the page.",
      parameters: { type: "object", properties: { keys: { type: "string" } }, required: ["keys"], additionalProperties: true }
    },
    {
      name: "user.request_input",
      description: "Ask the user for required input.",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string" },
          required: { type: "boolean" },
          options: { type: "array", items: { type: "string" } },
          question_id: { type: "string" }
        },
        required: ["prompt"],
        additionalProperties: true
      }
    }
  ];
}

async function buildAllowedToolsForRun() {
  const tools = defaultAllowedTools();
  const automations = await loadAutomations();
  if (automations.length) {
    tools.push({
      name: "browser.run_workflow",
      description: "Run a recorded local workflow by id or name.",
      parameters: {
        type: "object",
        properties: {
          workflow_id: { type: "string" },
          workflow_name: { type: "string" },
          recovery_mode: { type: "string" }
        },
        additionalProperties: true
      }
    });
  }
  return tools;
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

function appendRunEvent(runId, eventPayload) {
  const run = runs.get(runId);
  if (!run) {
    return null;
  }

  const payload = eventPayload && typeof eventPayload === "object" ? eventPayload : {};
  const event = {
    id: randomId("evt"),
    type: String(payload.type || "info"),
    title: String(payload.title || "Event"),
    detail: typeof payload.detail === "string" ? payload.detail : "",
    status: String(payload.status || "pending"),
    createdAt: nowIso(),
    stepIndex: Number.isFinite(payload.stepIndex) ? Number(payload.stepIndex) : null,
    actionType: payload.actionType ? String(payload.actionType) : null,
    data: payload.data && typeof payload.data === "object" ? payload.data : null
  };

  const currentEvents = Array.isArray(run.events) ? run.events : [];
  const events = [...currentEvents, event].slice(-MAX_EVENTS);
  updateRun(runId, { events });
  return event.id;
}

function patchRunEvent(runId, eventId, patch) {
  const run = runs.get(runId);
  if (!run || !eventId) {
    return;
  }

  const events = (Array.isArray(run.events) ? run.events : []).map((event) => {
    if (!event || event.id !== eventId) {
      return event;
    }
    const next = { ...event, ...patch };
    if (patch && typeof patch.detail === "string") {
      next.detail = patch.detail;
    }
    if (patch && typeof patch.status === "string") {
      next.status = patch.status;
    }
    return next;
  });

  updateRun(runId, { events });
}

async function persistRun(runId) {
  const run = runs.get(runId);
  if (!run) {
    return;
  }
  await saveRunToHistory(copyRun(run));
}

function appendTimelineItem(runId, title, status = "pending", eventType = "step", eventData = null) {
  const run = runs.get(runId);
  if (!run) {
    return null;
  }

  const eventId = appendRunEvent(runId, {
    type: eventType,
    title,
    status,
    data: eventData
  });

  const item = {
    id: `${run.timeline.length + 1}`,
    title,
    status,
    eventId,
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
    if (item.eventId) {
      patchRunEvent(runId, item.eventId, patch);
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
    const direction = String(action.direction || "").trim().toLowerCase() || (action.up ? "up" : "down");
    return `Scroll ${direction}`.trim();
  }
  if (type === "WaitAction") {
    return `Wait ${String(action.time_seconds || 1)}s`;
  }
  if (type === "RequestUserInputAction") {
    return `User input required: ${String(action.prompt || "provide information").slice(0, 72)}`;
  }
  if (type === "RunWorkflowAction") {
    const wfId = String(action.workflow_id || action.automation_id || action.workflow_name || "workflow");
    return `Run workflow ${wfId}`;
  }
  if (isReportResultActionType(type)) {
    const content = extractFinalTextFromResultAction(action);
    if (content) {
      return `Report result: ${content.slice(0, 64)}`;
    }
    return "Report final result";
  }
  if (type === "DoneAction" || type === "FinishAction") {
    return "Mark task completed";
  }

  return type;
}

async function resolveExecutionTab(startUrl = "") {
  let tabCtx = await getActiveTabContext();
  const activeTabSupported = typeof tabCtx.tabId === "number" && isSupportedTabUrl(tabCtx.url);
  if (activeTabSupported) {
    return tabCtx;
  }

  const fallbackUrl = startUrl || DEFAULT_FALLBACK_START_URL;
  const createdTab = await chrome.tabs.create({ url: fallbackUrl, active: true });
  if (!createdTab || typeof createdTab.id !== "number") {
    throw codedError("tab_create_failed", "Could not open a browser tab for execution");
  }

  await waitForTabComplete(createdTab.id);
  tabCtx = await getTabContext(createdTab.id);
  return tabCtx;
}

async function resolveAutomationFromAction(action) {
  const payload = action && typeof action === "object" ? action : {};
  const workflowId = String(payload.workflow_id || payload.automation_id || "").trim();
  const workflowName = String(payload.workflow_name || payload.name || "").trim();

  let automation = null;
  if (workflowId) {
    automation = await getAutomationById(workflowId);
  }
  if (!automation && workflowName) {
    automation = await getAutomationByName(workflowName);
  }
  return automation;
}

async function callLocalAct(payload) {
  let lastError = null;
  const candidates = await operatorCandidatesOrdered();

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    for (const base of candidates) {
      try {
        const response = await fetchWithTimeout(
          buildOperatorUrl(base, "/act"),
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
          },
          90000
        );

        if (!response.ok) {
          const body = await response.text();
          throw codedError(
            "operator_http_error",
            `operator_act_error:${response.status}:${body.slice(0, 300)}`,
            { status: response.status }
          );
        }

        localOperatorBaseUrl = base;
        return response.json();
      } catch (error) {
        lastError = error;
      }
    }
    if (attempt < 2) {
      await sleep(350);
    }
  }

  const rawMessage = errorMessage(lastError, "");
  const lowered = rawMessage.toLowerCase();
  if (
    lowered.includes("failed to fetch")
    || lowered.includes("fetch failed")
    || lowered.includes("networkerror")
    || lowered.includes("err_connection_refused")
    || lowered.includes("connection refused")
  ) {
    throw codedError(
      "local_operator_unreachable",
      "local_operator_unreachable: start autoppia_operator at 127.0.0.1:18060"
    );
  }
  if (rawMessage) {
    throw codedError("operator_call_failed", rawMessage);
  }
  throw codedError(
    "local_operator_unreachable",
    "local_operator_unreachable: start autoppia_operator at 127.0.0.1:18060"
  );
}

async function callLocalCapabilities() {
  const candidates = await operatorCandidatesOrdered();
  for (const base of candidates) {
    try {
      const response = await fetchWithTimeout(buildOperatorUrl(base, "/capabilities"), {}, 4500);
      if (!response.ok) {
        continue;
      }
      const payload = await response.json();
      localOperatorBaseUrl = base;
      return payload && typeof payload === "object" ? payload : null;
    } catch (_error) {
      // probe next base candidate
    }
  }
  return null;
}

function normalizeActResponse(rawResponse) {
  const payload = rawResponse && typeof rawResponse === "object" ? rawResponse : {};
  let actions = [];

  if (Array.isArray(payload.tool_calls)) {
    actions = payload.tool_calls.map(parseToolCall).filter(Boolean);
  } else if (Array.isArray(payload.actions)) {
    const actionLooksLikeToolCalls = payload.actions.some((item) => {
      if (!item || typeof item !== "object") {
        return false;
      }
      return typeof item.name === "string" || (item.function && typeof item.function === "object");
    });
    actions = actionLooksLikeToolCalls
      ? payload.actions.map(parseToolCall).filter(Boolean)
      : payload.actions.map(normalizeActionObject).filter(Boolean);
  } else if (payload.action && typeof payload.action === "object") {
    const normalized = normalizeActionObject(payload.action);
    actions = normalized ? [normalized] : [];
  } else if (typeof payload.navigate_url === "string") {
    const normalized = normalizeActionObject({ type: "NavigateAction", url: payload.navigate_url });
    actions = normalized ? [normalized] : [];
  } else if (payload.function_call) {
    const normalized = parseToolCall(payload.function_call);
    actions = normalized ? [normalized] : [];
  }

  const executionMode = ["single_step", "batch"].includes(String(payload.execution_mode || "").toLowerCase())
    ? String(payload.execution_mode).toLowerCase()
    : "batch";
  if (executionMode === "single_step" && actions.length > 1) {
    actions = actions.slice(0, 1);
  }

  const terminalActions = actions.filter((a) => isDoneActionType(a.type) || isReportResultActionType(a.type));
  const restActions = actions.filter((a) => !isDoneActionType(a.type) && !isReportResultActionType(a.type));
  actions = [...restActions, ...terminalActions];
  const done = Boolean(payload.done) || actions.some((a) => isDoneActionType(a.type) || isReportResultActionType(a.type));
  const finalText = firstTextCandidate(
    payload.content,
    payload.final_text,
    payload.final_answer,
    payload.summary,
    payload.answer,
    payload.result,
    payload.output,
    payload.content,
    payload.message,
    actions.filter((a) => isReportResultActionType(a.type)).map(extractFinalTextFromResultAction),
    actions.filter((a) => isDoneActionType(a.type)).map(extractFinalTextFromDoneAction)
  );

  const normalized = {
    protocol_version: String(payload.protocol_version || "1.0"),
    execution_mode: executionMode,
    actions,
    done,
    content: firstTextCandidate(payload.content),
    reasoning: typeof payload.reasoning === "string" ? payload.reasoning : null,
    action_rationales: Array.isArray(payload.action_rationales)
      ? payload.action_rationales.filter((x) => typeof x === "string")
      : [],
    final_text: finalText,
    state_out: payload.state_out && typeof payload.state_out === "object" ? payload.state_out : {},
    usage: payload.usage && typeof payload.usage === "object" ? payload.usage : null,
    estimated_cost_usd: payload.estimated_cost_usd ?? null,
    model: typeof payload.model === "string" ? payload.model : null,
    error: typeof payload.error === "string" ? payload.error : null
  };
  return normalized;
}

async function waitForUserInput(runId, promptAction) {
  const controller = runControllers.get(runId);
  if (!controller) {
    return { cancelled: true, answer: "" };
  }

  const waitEventId = appendRunEvent(runId, {
    type: "input_required",
    title: "User input required",
    detail: String(promptAction.prompt || "Input required"),
    status: "awaiting_input",
    data: {
      options: Array.isArray(promptAction.options) ? promptAction.options : [],
      required: promptAction.required !== false,
      question_id: String(promptAction.question_id || "")
    }
  });

  updateRun(runId, {
    status: "awaiting_input",
    waitingForUserInput: {
      prompt: String(promptAction.prompt || "Input required"),
      question_id: String(promptAction.question_id || ""),
      required: promptAction.required !== false,
      options: Array.isArray(promptAction.options) ? promptAction.options : [],
      at: nowIso()
    }
  });
  await persistRun(runId);

  while (true) {
    if (controller.cancelled) {
      patchRunEvent(runId, waitEventId, {
        status: "cancelled",
        detail: "Run cancelled while waiting for user input."
      });
      return { cancelled: true, answer: "" };
    }
    if (controller.userInputQueue.length > 0) {
      const answer = String(controller.userInputQueue.shift() || "");
      updateRun(runId, {
        status: "running",
        waitingForUserInput: null
      });
      patchRunEvent(runId, waitEventId, {
        status: "succeeded",
        detail: "Input received. Replanning next action."
      });
      await persistRun(runId);
      return { cancelled: false, answer };
    }
    await sleep(USER_INPUT_POLL_INTERVAL_MS);
  }
}

async function executeWorkflowAction(tabId, action, context = {}) {
  const runId = context && context.runId ? String(context.runId) : "";
  const stepIndex = Number.isFinite(Number(context.stepIndex)) ? Number(context.stepIndex) : null;
  const recoveryMode = String((action && action.recovery_mode) || "agent_takeover").trim().toLowerCase();
  const automation = await resolveAutomationFromAction(action);

  if (!automation || !Array.isArray(automation.steps) || !automation.steps.length) {
    return {
      success: false,
      done: false,
      error: "workflow_not_found_or_empty",
      recovery: {
        mode: recoveryMode,
        workflow_id: String((action && action.workflow_id) || ""),
        workflow_name: String((action && action.workflow_name) || ""),
        reason: "workflow_not_found_or_empty"
      }
    };
  }

  if (runId) {
    appendRunEvent(runId, {
      type: "workflow_start",
      title: `Workflow started: ${String(automation.name || automation.id || "workflow")}`,
      detail: `Executing ${automation.steps.length} recorded step(s).`,
      status: "running",
      stepIndex,
      data: {
        workflow_id: String(automation.id || ""),
        workflow_name: String(automation.name || "")
      }
    });
  }

  const maxSteps = Math.min(400, automation.steps.length);
  let executedSteps = 0;
  for (let idx = 0; idx < maxSteps; idx += 1) {
    const wfAction = normalizeActionObject(automation.steps[idx]);
    if (!wfAction) {
      continue;
    }
    executedSteps += 1;
    if (String(wfAction.type || "") === "RunWorkflowAction") {
      return {
        success: false,
        done: false,
        error: `workflow_nested_not_allowed:${idx + 1}`,
        recovery: {
          mode: recoveryMode,
          workflow_id: String(automation.id || ""),
          workflow_name: String(automation.name || ""),
          failed_step_index: idx,
          reason: "workflow_nested_not_allowed"
        }
      };
    }

    const result = await executeAction(tabId, wfAction, {
      ...context,
      depth: Number(context.depth || 0) + 1,
      fromWorkflow: true
    });
    if (!result || !result.success) {
      const recovery = {
        mode: recoveryMode,
        workflow_id: String(automation.id || ""),
        workflow_name: String(automation.name || ""),
        failed_step_index: idx,
        failed_action: wfAction,
        reason: String((result && result.error) || "workflow_step_failed")
      };

      if (runId) {
        appendRunEvent(runId, {
          type: "workflow_recovery",
          title: `Workflow failed: ${String(automation.name || automation.id || "workflow")}`,
          detail: `Step ${idx + 1} failed: ${recovery.reason}`,
          status: "failed",
          stepIndex,
          data: recovery
        });
      }
      return {
        success: false,
        done: false,
        error: `workflow_step_failed:${idx + 1}:${recovery.reason}`,
        recovery
      };
    }
    if (result.done) {
      break;
    }
  }

  if (runId) {
    appendRunEvent(runId, {
      type: "workflow_succeeded",
      title: `Workflow finished: ${String(automation.name || automation.id || "workflow")}`,
      detail: `Executed ${executedSteps} step(s).`,
      status: "succeeded",
      stepIndex,
      data: {
        workflow_id: String(automation.id || ""),
        workflow_name: String(automation.name || "")
      }
    });
  }

  return {
    success: true,
    done: false,
    workflow: {
      id: String(automation.id || ""),
      name: String(automation.name || ""),
      steps_executed: executedSteps
    }
  };
}

async function executeAction(tabId, action, context = {}) {
  const type = String((action && action.type) || "");
  const depth = Number.isFinite(Number(context.depth)) ? Number(context.depth) : 0;

  if (isRequestUserInputActionType(type)) {
    return { success: true, done: false, requiresUserInput: true };
  }

  if (type === "RunWorkflowAction") {
    if (depth >= 2) {
      return { success: false, error: "workflow_depth_exceeded", done: false };
    }
    return executeWorkflowAction(tabId, action, context);
  }

  if (type === "DoneAction" || type === "FinishAction") {
    return { success: true, done: true };
  }
  if (isReportResultActionType(type)) {
    return {
      success: true,
      done: true,
      detail: extractFinalTextFromResultAction(action) || "Result reported."
    };
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

  if (type === "HoldKeyAction") {
    const key = String(action.key || "");
    if (!key) {
      return { success: false, error: "holdkey_missing_key", done: false };
    }
    const release = Boolean(action.release);
    const durationMs = Number(action.duration_ms || 0);
    await executeScriptOnTab(
      tabId,
      async (rawKey, rawRelease, rawDuration) => {
        const target = document.activeElement || document.body;
        if (rawRelease) {
          target.dispatchEvent(new KeyboardEvent("keyup", { key: rawKey, bubbles: true, cancelable: true }));
          return true;
        }
        target.dispatchEvent(new KeyboardEvent("keydown", { key: rawKey, bubbles: true, cancelable: true }));
        if (rawDuration > 0) {
          await new Promise((resolve) => setTimeout(resolve, rawDuration));
          target.dispatchEvent(new KeyboardEvent("keyup", { key: rawKey, bubbles: true, cancelable: true }));
        }
        return true;
      },
      [key, release, Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0]
    );
    return { success: true, done: false };
  }

  const domResult = await executeDomAction(tabId, action);
  if (!domResult || !domResult.success) {
    return {
      success: false,
      error: domResult && domResult.error ? domResult.error : "dom_action_failed",
      detail: domResult && domResult.detail ? String(domResult.detail) : "",
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

  return {
    success: true,
    done: false,
    detail: domResult && domResult.detail ? String(domResult.detail) : ""
  };
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

    const tabId = run.tabContext.tabId;
    if (typeof tabId !== "number") {
      throw codedError("active_tab_not_found", "active_tab_not_found");
    }

    const currentTab = await getTabContext(tabId);
    if (!isSupportedTabUrl(currentTab.url)) {
      throw codedError("unsupported_tab_url", "unsupported_tab_url: open a regular http/https page");
    }

    appendRunEvent(runId, {
      type: "run_execution",
      title: "Execution started",
      detail: `Running on ${currentTab.url || "current tab"}`,
      status: "running",
      data: { tabId, url: currentTab.url || "", operator_base: localOperatorBaseUrl }
    });
    await persistRun(runId);

    if (run.startUrl && run.startUrl !== currentTab.url) {
      const navId = appendTimelineItem(
        runId,
        `Navigate to ${run.startUrl}`,
        "running",
        "navigation",
        { url: run.startUrl }
      );
      await persistRun(runId);
      try {
        await navigateTab(tabId, run.startUrl);
        patchTimelineItem(runId, navId, { status: "succeeded" });
      } catch (error) {
        const navFailure = codedError("navigation_failed", errorMessage(error, "navigation_failed"));
        patchTimelineItem(runId, navId, { status: "failed", detail: navFailure.message });
        throw navFailure;
      }
      await persistRun(runId);
    }

    const carryHistory = Array.isArray(run.carry_history) ? run.carry_history.slice(0, MAX_SESSION_HISTORY_ITEMS) : [];
    let currentHistory = [];
    let plannerState = run.state_out && typeof run.state_out === "object" ? { ...run.state_out } : {};
    const allowedTools = await buildAllowedToolsForRun();

    for (let stepIndex = 0; stepIndex < MAX_STEPS; stepIndex += 1) {
      if (controller.cancelled) {
        appendRunEvent(runId, {
          type: "run_cancelled",
          title: "Run cancelled",
          detail: "Cancelled by user.",
          status: "cancelled"
        });
        updateRun(runId, {
          status: "cancelled",
          waitingForUserInput: null,
          lastError: null,
          result: {
            content: "Run cancelled by user",
            success: false,
            finishedAt: nowIso()
          }
        });
        await persistRun(runId);
        return;
      }

      const planId = appendTimelineItem(
        runId,
        `Plan step ${stepIndex + 1}`,
        "running",
        "planning",
        { stepIndex }
      );
      await persistRun(runId);

      let snapshot;
      try {
        snapshot = await captureSnapshot(tabId);
      } catch (error) {
        patchTimelineItem(runId, planId, { status: "failed", detail: errorMessage(error, "snapshot_failed") });
        throw error;
      }

      const rawActResponse = await callLocalAct({
        protocol_version: "1.0",
        task_id: runId,
        prompt: run.prompt_with_tools || run.prompt,
        url: snapshot.url,
        snapshot_html: snapshot.snapshot_html,
        step_index: stepIndex,
        history: [...carryHistory, ...currentHistory],
        state_in: plannerState,
        allowed_tools: allowedTools,
        include_reasoning: true
      });
      const actResponse = normalizeActResponse(rawActResponse);
      plannerState = actResponse.state_out && typeof actResponse.state_out === "object" ? { ...actResponse.state_out } : {};
      if (actResponse.error) {
        throw codedError("operator_error", `operator_error:${actResponse.error}`);
      }
      if (actResponse.reasoning) {
        appendRunEvent(runId, {
          type: "reasoning",
          title: "Thoughts",
          detail: actResponse.reasoning.slice(0, 500),
          status: "succeeded",
          stepIndex
        });
      }

      patchTimelineItem(runId, planId, {
        status: "succeeded",
        detail: actResponse.reasoning ? `Thoughts: ${actResponse.reasoning.slice(0, 280)}` : ""
      });
      updateRun(runId, { state_out: plannerState });
      await persistRun(runId);

      const actions = Array.isArray(actResponse.actions) ? [...actResponse.actions] : [];
      if (!actions.length) {
        const doneByOperator = Boolean(actResponse.done);
        const finalText = firstTextCandidate(actResponse.final_text);
        const stopThought = firstTextCandidate(
          Array.isArray(actResponse.action_rationales) ? actResponse.action_rationales[0] : null,
          actResponse.reasoning
        );
        if (!doneByOperator) {
          const noActionFailure = buildRunFailure(codedError("operator_no_actions", "Operator returned no actions."));
          appendRunEvent(runId, {
            type: "run_result",
            title: "Run failed",
            detail: noActionFailure.message,
            status: "failed",
            data: { error_code: noActionFailure.code }
          });
          updateRun(runId, {
            status: "failed",
            lastError: noActionFailure,
            result: {
              content: noActionFailure.message,
              success: false,
              error_code: noActionFailure.code,
              finishedAt: nowIso()
            },
            protocol_version: actResponse.protocol_version || null,
            execution_mode: actResponse.execution_mode || null,
            usage: actResponse.usage || null,
            estimated_cost_usd: actResponse.estimated_cost_usd || null,
            model: actResponse.model || null
          });
          await persistRun(runId);
          return;
        }
        const finalDetail = finalText
          ? `Operator final result: ${finalText.slice(0, 500)}`
          : (
            doneByOperator
              ? (stopThought || "Operator marked task as completed.")
              : "No more actions returned by operator."
          );
        appendRunEvent(runId, {
          type: "run_result",
          title: "Run completed",
          detail: finalDetail,
          status: "succeeded"
        });
        updateRun(runId, {
          status: "succeeded",
          lastError: null,
          result: {
            content: finalText || "",
            success: true,
            finishedAt: nowIso()
          },
          state_out: plannerState,
          protocol_version: actResponse.protocol_version || null,
          execution_mode: actResponse.execution_mode || null,
          usage: actResponse.usage || null,
          estimated_cost_usd: actResponse.estimated_cost_usd || null,
          model: actResponse.model || null
        });
        await persistRun(runId);
        return;
      }

      let requiresReplan = false;
      for (let actionIdx = 0; actionIdx < actions.length; actionIdx += 1) {
        const action = actions[actionIdx];
        const actionRationale = Array.isArray(actResponse.action_rationales)
          ? String(actResponse.action_rationales[actionIdx] || "").trim()
          : "";
        if (controller.cancelled) {
          appendRunEvent(runId, {
            type: "run_cancelled",
            title: "Run cancelled",
            detail: "Cancelled by user.",
            status: "cancelled"
          });
          updateRun(runId, {
            status: "cancelled",
            waitingForUserInput: null,
            lastError: null,
            result: {
              content: "Run cancelled by user",
              success: false,
              finishedAt: nowIso()
            }
          });
          await persistRun(runId);
          return;
        }

        if (isRequestUserInputActionType(action.type)) {
          const inputTimelineId = appendTimelineItem(
            runId,
            actionTitle(action),
            "running",
            "input_required",
            {
              prompt: String(action.prompt || ""),
              required: action.required !== false,
              options: Array.isArray(action.options) ? action.options : []
            }
          );
          await persistRun(runId);

          const inputResult = await waitForUserInput(runId, action);
          if (inputResult.cancelled) {
            patchTimelineItem(runId, inputTimelineId, { status: "cancelled" });
            appendRunEvent(runId, {
              type: "run_cancelled",
              title: "Run cancelled",
              detail: "Run cancelled while waiting for user input.",
              status: "cancelled"
            });
            updateRun(runId, {
              status: "cancelled",
              waitingForUserInput: null,
              lastError: null,
              result: {
                content: "Run cancelled while waiting for user input.",
                success: false,
                finishedAt: nowIso()
              }
            });
            await persistRun(runId);
            return;
          }

          const answer = String(inputResult.answer || "").trim();
          const required = action.required !== false;
          const inputSuccess = Boolean(answer) || !required;
          patchTimelineItem(runId, inputTimelineId, {
            status: inputSuccess ? "succeeded" : "failed",
            detail: inputSuccess ? "Input received from user." : "Required input missing."
          });

          const tabCtx = await getTabContext(tabId);
          currentHistory.push({
            step_index: stepIndex,
            action,
            success: inputSuccess,
            error: inputSuccess ? null : "missing_user_input",
            user_input: answer,
            url: tabCtx.url,
            at: nowIso()
          });

          updateRun(runId, {
            history: currentHistory,
            state_out: plannerState,
            protocol_version: actResponse.protocol_version || null,
            execution_mode: actResponse.execution_mode || null,
            usage: actResponse.usage || null,
            estimated_cost_usd: actResponse.estimated_cost_usd || null,
            model: actResponse.model || null
          });
          await persistRun(runId);

          if (!inputSuccess) {
            appendRunEvent(runId, {
              type: "run_result",
              title: "Run failed",
              detail: "Required input was not provided.",
              status: "failed"
            });
            updateRun(runId, {
              status: "failed",
              lastError: {
                code: "missing_user_input",
                message: "Required input was not provided.",
                raw_message: "missing_user_input",
                status: null,
                at: nowIso()
              },
              result: {
                content: "Required input was not provided.",
                success: false,
                error_code: "missing_user_input",
                finishedAt: nowIso()
              }
            });
            await persistRun(runId);
            return;
          }

          requiresReplan = true;
          break;
        }

        const actionId = appendTimelineItem(
          runId,
          actionTitle(action),
          "running",
          "action",
          {
            type: String(action.type || ""),
            stepIndex,
            rationale: actionRationale || ""
          }
        );
        await persistRun(runId);

        let execution;
        try {
          execution = await executeAction(tabId, action, { runId, stepIndex, depth: 0 });
        } catch (error) {
          execution = { success: false, error: errorMessage(error, "action_execution_error"), done: false };
        }

        patchTimelineItem(runId, actionId, {
          status: execution.success ? "succeeded" : "failed",
          detail: execution.success
            ? String(execution.detail || "")
            : String(execution.error || "action_execution_error")
        });

        const tabCtx = await getTabContext(tabId);
        currentHistory.push({
          step_index: stepIndex,
          action,
          success: execution.success,
          error: execution.error || null,
          recovery: execution.recovery || null,
          workflow: execution.workflow || null,
          url: tabCtx.url,
          at: nowIso()
        });

        updateRun(runId, {
          history: currentHistory,
          state_out: plannerState,
          protocol_version: actResponse.protocol_version || null,
          execution_mode: actResponse.execution_mode || null,
          usage: actResponse.usage || null,
          estimated_cost_usd: actResponse.estimated_cost_usd || null,
          model: actResponse.model || null
        });
        await persistRun(runId);

        if (execution.done) {
          const doneText = firstTextCandidate(
            extractFinalTextFromResultAction(action),
            extractFinalTextFromDoneAction(action),
            actResponse.final_text
          );
          const stopThought = firstTextCandidate(actionRationale, actResponse.reasoning);
          appendRunEvent(runId, {
            type: "run_result",
            title: "Run completed",
            detail: doneText
              ? `Task completed: ${doneText.slice(0, 500)}`
              : (stopThought || "Task completed."),
            status: "succeeded"
          });
          updateRun(runId, {
            status: "succeeded",
            lastError: null,
            result: {
              content: doneText || "",
              success: true,
              finishedAt: nowIso()
            },
            state_out: plannerState
          });
          await persistRun(runId);
          return;
        }
      }
      if (requiresReplan) {
        continue;
      }
    }

    const maxStepsFailure = buildRunFailure(codedError("max_steps_reached", "max_steps_reached"));
    updateRun(runId, {
      status: "failed",
      waitingForUserInput: null,
      lastError: maxStepsFailure,
      result: {
        content: maxStepsFailure.message,
        success: false,
        error_code: maxStepsFailure.code,
        finishedAt: nowIso()
      }
    });
    appendRunEvent(runId, {
      type: "run_result",
      title: "Run failed",
      detail: maxStepsFailure.message,
      status: "failed",
      data: { error_code: maxStepsFailure.code }
    });
    await persistRun(runId);
  } catch (error) {
    const failure = buildRunFailure(error);
    updateRun(runId, {
      status: "failed",
      waitingForUserInput: null,
      lastError: failure,
      result: {
        content: failure.message,
        success: false,
        error_code: failure.code,
        finishedAt: nowIso()
      }
    });
    appendRunEvent(runId, {
      type: "run_result",
      title: "Run failed",
      detail: failure.message,
      status: "failed",
      data: { error_code: failure.code }
    });
    await persistRun(runId);
  } finally {
    runControllers.delete(runId);
  }
}

async function startRun(payload) {
  const prompt = String(payload.prompt || "").trim();
  if (!prompt) {
    throw codedError("invalid_prompt", "Prompt is required");
  }

  const startUrl = String(payload.startUrl || "").trim();
  if (startUrl && !isHttpUrl(startUrl)) {
    throw codedError("invalid_start_url", "Start URL must begin with http:// or https://");
  }

  const healthy = await isLocalOperatorHealthy();

  const capabilities = await callLocalCapabilities();
  const touched = await touchLocalSession({
    sessionId: payload.sessionId || "",
    prompt
  });
  const localSession = touched.session;
  const allHistory = await loadHistory();
  const promptWithContext = buildSessionPromptContext(allHistory, localSession.id, prompt);
  const promptWithTools = await buildPromptWithAutomationTools(promptWithContext);
  const carryHistory = buildSessionCarryHistory(allHistory, localSession.id);

  const tabCtx = await resolveExecutionTab(startUrl);

  const run = {
    id: randomId("run"),
    session_id: localSession.id,
    session_run_number: Number(localSession.runCount || 1),
    prompt,
    prompt_with_tools: promptWithTools,
    startUrl,
    tabContext: tabCtx,
    status: "running",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    events: [],
    timeline: [],
    history: [],
    carry_history: carryHistory,
    waitingForUserInput: null,
    lastError: null,
    result: null,
    state_out: {},
    protocol_version: capabilities && typeof capabilities.protocol_version === "string"
      ? capabilities.protocol_version
      : null,
    execution_mode: capabilities && typeof capabilities.default_execution_mode === "string"
      ? capabilities.default_execution_mode
      : null,
    usage: null,
    estimated_cost_usd: null,
    model: null,
    provider: "local_operator",
    capabilities: capabilities || null
  };

  runs.set(run.id, run);
  appendRunEvent(run.id, {
    type: "run_started",
    title: "Run created",
    detail: `${localSession.title || "Session"} • Run #${Number(localSession.runCount || 1)}`,
    status: "running",
    data: {
      session_id: localSession.id,
      session_title: localSession.title || null,
      session_run_number: Number(localSession.runCount || 1),
      provider: "local_operator",
      operator_base: localOperatorBaseUrl
    }
  });
  if (!healthy) {
    appendRunEvent(run.id, {
      type: "operator_warning",
      title: "Operator health check not reachable",
      detail: "Proceeding anyway. If /act fails, start autoppia_operator and verify 127.0.0.1:18060.",
      status: "pending"
    });
  }
  runControllers.set(run.id, { cancelled: false, userInputQueue: [] });
  await saveRunToHistory(copyRun(runs.get(run.id)));

  // run asynchronously so sidepanel gets immediate response
  runLoop(run.id).catch(async (error) => {
    const failure = buildRunFailure(error);
    updateRun(run.id, {
      status: "failed",
      lastError: failure,
      result: {
        content: failure.message,
        success: false,
        error_code: failure.code,
        finishedAt: nowIso()
      }
    });
    appendRunEvent(run.id, {
      type: "run_result",
      title: "Run failed",
      detail: failure.message,
      status: "failed",
      data: { error_code: failure.code }
    });
    await persistRun(run.id);
  });

  return copyRun(runs.get(run.id));
}

async function replayLoop(runId, automation) {
  const controller = runControllers.get(runId);
  const run = runs.get(runId);
  if (!controller || !run) {
    return;
  }

  const tabId = run.tabContext && typeof run.tabContext.tabId === "number" ? run.tabContext.tabId : null;
  if (!Number.isFinite(tabId)) {
    throw codedError("active_tab_not_found", "No active tab found for replay.");
  }

  const steps = Array.isArray(automation.steps) ? automation.steps.slice(0, 400) : [];
  if (!steps.length) {
    throw codedError("workflow_not_found_or_empty", "Recorded workflow has no steps.");
  }

  appendRunEvent(runId, {
    type: "run_execution",
    title: "Workflow replay started",
    detail: `Replaying "${String(automation.name || automation.id || "workflow")}" (${steps.length} step(s)).`,
    status: "running",
    data: {
      workflow_id: String(automation.id || ""),
      workflow_name: String(automation.name || ""),
      operator_base: localOperatorBaseUrl
    }
  });
  await persistRun(runId);

  const history = [];
  for (let idx = 0; idx < steps.length; idx += 1) {
    if (controller.cancelled) {
      appendRunEvent(runId, {
        type: "run_cancelled",
        title: "Run cancelled",
        detail: "Cancelled by user.",
        status: "cancelled"
      });
      updateRun(runId, {
        status: "cancelled",
        waitingForUserInput: null,
        lastError: null,
        history,
        result: {
          content: "Workflow replay cancelled by user.",
          success: false,
          finishedAt: nowIso()
        }
      });
      await persistRun(runId);
      return;
    }

    const action = normalizeActionObject(steps[idx]);
    if (!action) {
      continue;
    }

    const stepTitle = `Replay ${idx + 1}: ${actionTitle(action)}`;
    const timelineId = appendTimelineItem(runId, stepTitle, "running", "workflow_step", { stepIndex: idx });
    await persistRun(runId);

    let execution;
    try {
      execution = await executeAction(tabId, action, { runId, stepIndex: idx, depth: 0 });
    } catch (error) {
      execution = { success: false, done: false, error: errorMessage(error, "action_execution_error") };
    }

    patchTimelineItem(runId, timelineId, {
      status: execution.success ? "succeeded" : "failed",
      detail: execution.success ? "" : String(execution.error || "action_execution_error")
    });

    const tabCtx = await getTabContext(tabId);
    history.push({
      step_index: idx,
      action,
      success: Boolean(execution && execution.success),
      error: execution && execution.error ? String(execution.error) : null,
      recovery: execution && execution.recovery ? execution.recovery : null,
      workflow: execution && execution.workflow ? execution.workflow : null,
      url: tabCtx.url,
      at: nowIso()
    });
    updateRun(runId, { history });
    await persistRun(runId);

    if (!execution.success) {
      const failure = buildRunFailure(codedError("workflow_step_failed", String(execution.error || "workflow_step_failed")));
      updateRun(runId, {
        status: "failed",
        waitingForUserInput: null,
        lastError: failure,
        history,
        result: {
          content: failure.message,
          success: false,
          error_code: failure.code,
          finishedAt: nowIso()
        }
      });
      appendRunEvent(runId, {
        type: "run_result",
        title: "Workflow replay failed",
        detail: failure.message,
        status: "failed",
        data: { error_code: failure.code }
      });
      await persistRun(runId);
      return;
    }

    if (execution.done) {
      break;
    }
  }

  updateRun(runId, {
    status: "succeeded",
    waitingForUserInput: null,
    lastError: null,
    history,
    result: {
      content: `Workflow replay completed: ${String(automation.name || automation.id || "workflow")}`,
      success: true,
      finishedAt: nowIso()
    }
  });
  appendRunEvent(runId, {
    type: "run_result",
    title: "Workflow replay completed",
    detail: `Completed ${history.length} step(s).`,
    status: "succeeded"
  });
  await persistRun(runId);
}

async function replayAutomation(payload = {}) {
  const automationId = String(payload.automationId || payload.workflow_id || "").trim();
  if (!automationId) {
    throw codedError("automation_id_required", "Automation id is required.");
  }

  const automation = await getAutomationById(automationId);
  if (!automation) {
    throw codedError("automation_not_found", "Automation not found.");
  }

  const startUrl = String(payload.startUrl || automation.start_url || "").trim();
  const tabCtx = await resolveExecutionTab(startUrl);
  const touched = await touchLocalSession({
    sessionId: payload.sessionId || "",
    prompt: `Replay workflow: ${String(automation.name || automation.id || automationId)}`
  });
  const localSession = touched.session;

  const run = {
    id: randomId("run"),
    session_id: localSession.id,
    session_run_number: Number(localSession.runCount || 1),
    prompt: `Replay workflow: ${String(automation.name || automation.id || automationId)}`,
    prompt_with_tools: `Replay workflow: ${String(automation.name || automation.id || automationId)}`,
    startUrl,
    tabContext: tabCtx,
    status: "running",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    events: [],
    timeline: [],
    history: [],
    waitingForUserInput: null,
    lastError: null,
    result: null,
    protocol_version: "1.0",
    execution_mode: "workflow_replay",
    usage: null,
    estimated_cost_usd: null,
    model: null,
    provider: "local_workflow",
    automation_id: String(automation.id || ""),
    automation_name: String(automation.name || "")
  };

  runs.set(run.id, run);
  appendRunEvent(run.id, {
    type: "run_started",
    title: "Workflow replay created",
    detail: `${localSession.title || "Session"} • Run #${Number(localSession.runCount || 1)}`,
    status: "running",
    data: {
      session_id: localSession.id,
      session_title: localSession.title || null,
      session_run_number: Number(localSession.runCount || 1),
      provider: "local_workflow",
      workflow_id: String(automation.id || ""),
      workflow_name: String(automation.name || "")
    }
  });
  runControllers.set(run.id, { cancelled: false, userInputQueue: [] });
  await saveRunToHistory(copyRun(runs.get(run.id)));

  replayLoop(run.id, automation).catch(async (error) => {
    const failure = buildRunFailure(error);
    updateRun(run.id, {
      status: "failed",
      lastError: failure,
      result: {
        content: failure.message,
        success: false,
        error_code: failure.code,
        finishedAt: nowIso()
      }
    });
    appendRunEvent(run.id, {
      type: "run_result",
      title: "Workflow replay failed",
      detail: failure.message,
      status: "failed",
      data: { error_code: failure.code }
    });
    await persistRun(run.id);
  }).finally(() => {
    runControllers.delete(run.id);
  });

  return copyRun(runs.get(run.id));
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

  appendRunEvent(runId, {
    type: "run_cancelled",
    title: "Run cancelled",
    detail: "Cancelled by user.",
    status: "cancelled"
  });
  updateRun(runId, {
    status: "cancelled",
    waitingForUserInput: null,
    lastError: null,
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
          executionProvider: "local_operator",
          recording: getRecordingStatus()
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

    case "OPERATOR_BASE_GET": {
      return { ok: true, baseUrl: localOperatorBaseUrl };
    }

    case "OPERATOR_BASE_SET": {
      const baseUrl = await setSavedOperatorBaseUrl(message.baseUrl || "");
      return { ok: true, baseUrl };
    }

    case "SESSION_LIST": {
      const state = await listSessions();
      const history = await loadHistory();
      const sid = String(state.activeSessionId || "").trim();
      return {
        ok: true,
        sessions: state.sessions,
        activeSessionId: state.activeSessionId,
        history: sid ? historyBySession(history, sid).reverse() : []
      };
    }

    case "SESSION_CREATE": {
      const created = await createSession(message.name || "");
      const history = await loadHistory();
      return {
        ok: true,
        sessions: created.sessions,
        activeSessionId: created.activeSessionId,
        session: created.session,
        history: []
      };
    }

    case "SESSION_SET_ACTIVE": {
      const state = await setActiveSession(message.sessionId || "");
      const history = await loadHistory();
      const sid = String(state.activeSessionId || "").trim();
      return {
        ok: true,
        sessions: state.sessions,
        activeSessionId: state.activeSessionId,
        history: sid ? historyBySession(history, sid).reverse() : []
      };
    }

    case "RUN_START": {
      const run = await startRun(message.payload || {});
      return { ok: true, run };
    }

    case "AUTOMATION_REPLAY": {
      const run = await replayAutomation(message.payload || {});
      return { ok: true, run };
    }

    case "RUN_GET": {
      const runId = String(message.runId || "");
      const run = runs.get(runId);
      if (!run) {
        return { ok: false, error: "Run not found", code: "run_not_found" };
      }
      return { ok: true, run: copyRun(run) };
    }

    case "RUN_CANCEL": {
      const runId = String(message.runId || "");
      const run = await cancelRun(runId);
      if (!run) {
        return { ok: false, error: "Run not found", code: "run_not_found" };
      }
      return { ok: true, run };
    }

    case "RUN_SUBMIT_USER_INPUT": {
      const runId = String(message.runId || "");
      const answer = String(message.answer || "");
      const run = runs.get(runId);
      const controller = runControllers.get(runId);
      if (!run || !controller) {
        return { ok: false, error: "Run not found", code: "run_not_found" };
      }
      if (!run.waitingForUserInput) {
        return { ok: false, error: "No pending user input", code: "no_pending_user_input" };
      }
      if (!Array.isArray(controller.userInputQueue)) {
        controller.userInputQueue = [];
      }
      controller.userInputQueue.push(answer);
      appendRunEvent(runId, {
        type: "input_submitted",
        title: "User input submitted",
        detail: answer ? "Input received and queued for next planning step." : "Empty input submitted.",
        status: "running"
      });
      updateRun(runId, {
        lastUserInputAt: nowIso()
      });
      await persistRun(runId);
      return { ok: true, run: copyRun(runs.get(runId)) };
    }

    case "RUN_HISTORY": {
      const history = await loadHistory();
      const sessionId = String(message.sessionId || "").trim();
      if (!sessionId) {
        return { ok: true, history };
      }
      return { ok: true, history: historyBySession(history, sessionId).reverse() };
    }

    case "RUN_HISTORY_CLEAR": {
      await clearStoredHistory();
      return { ok: true };
    }

    case "AUTOMATION_LIST": {
      const automations = await loadAutomations();
      return { ok: true, automations, recording: getRecordingStatus() };
    }

    case "AUTOMATION_RECORD_STATUS": {
      return { ok: true, recording: getRecordingStatus() };
    }

    case "AUTOMATION_RECORD_START": {
      const recording = await startRecording(message.payload || {});
      return { ok: true, recording };
    }

    case "AUTOMATION_RECORD_STOP": {
      const result = await stopRecording(message.payload || {});
      const automations = await loadAutomations();
      return { ok: true, ...result, automations, recording: getRecordingStatus() };
    }

    case "AUTOMATION_DELETE": {
      const changed = await deleteAutomation(message.automationId || "");
      const automations = await loadAutomations();
      return { ok: true, changed, automations };
    }

    default:
      return { ok: false, error: "unsupported_message_type" };
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then((response) => sendResponse(response))
    .catch((error) => {
      const normalized = normalizeRunFailure(error);
      sendResponse({
        ok: false,
        error: normalized.message || "unknown_error",
        code: normalized.code || "unknown_error"
      });
    });
  return true;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!recordingSession || !recordingSession.active || !recordingSession.draft) {
    return;
  }
  if (Number(recordingSession.draft.tabId) !== Number(tabId)) {
    return;
  }
  if (changeInfo.status !== "complete") {
    return;
  }

  const url = String((tab && tab.url) || "");
  if (url && isHttpUrl(url) && url !== String(recordingSession.draft.lastUrl || "")) {
    appendRecordedStep(recordingSession.draft, { type: "NavigateAction", url });
    recordingSession.draft.lastUrl = url;
    recordingSession.draft.updated_at = nowIso();
  }

  installRecorderOnTab(tabId).catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (!recordingSession || !recordingSession.active || !recordingSession.draft) {
    return;
  }
  if (Number(recordingSession.draft.tabId) !== Number(tabId)) {
    return;
  }
  if (recordingSession.pollId) {
    clearInterval(recordingSession.pollId);
  }
  recordingSession = null;
});

chrome.runtime.onInstalled.addListener(() => {
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  }
});

loadSavedOperatorBaseUrl().catch(() => {});

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
