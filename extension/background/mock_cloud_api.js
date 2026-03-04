const MOCK_NETWORK_DELAY_MS = 220;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomToken(prefix) {
  const raw = `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  return `${prefix}_${raw}`;
}

export async function exchangeApiKey(apiKey) {
  await sleep(MOCK_NETWORK_DELAY_MS);

  if (!apiKey || typeof apiKey !== "string") {
    const error = new Error("API key is required");
    error.code = "invalid_api_key";
    throw error;
  }

  const trimmed = apiKey.trim();
  if (trimmed.length < 12) {
    const error = new Error("API key format looks invalid");
    error.code = "invalid_api_key";
    throw error;
  }

  return {
    token_type: "Bearer",
    access_token: randomToken("am_access"),
    refresh_token: randomToken("am_refresh"),
    expires_in: 900,
    scope: "automata:run"
  };
}

export async function refreshAccessToken(refreshToken) {
  await sleep(MOCK_NETWORK_DELAY_MS);

  if (!refreshToken || typeof refreshToken !== "string" || refreshToken.length < 12) {
    const error = new Error("Refresh token is invalid");
    error.code = "invalid_refresh_token";
    throw error;
  }

  return {
    token_type: "Bearer",
    access_token: randomToken("am_access"),
    refresh_token: randomToken("am_refresh"),
    expires_in: 900,
    scope: "automata:run"
  };
}

export async function revokeRefreshToken(_refreshToken) {
  await sleep(120);
  return { revoked: true };
}

export function buildMockRunSteps(prompt, startUrl) {
  const urlLabel = startUrl || "current page";
  return [
    `Open context at ${urlLabel}`,
    "Capture page snapshot",
    "Plan next browser action",
    `Execute task: ${prompt.slice(0, 80)}`,
    "Summarize result"
  ];
}
