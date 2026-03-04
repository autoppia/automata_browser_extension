const LOCAL_KEYS = {
  refreshToken: "auth_refresh_token",
  tokenMeta: "auth_token_meta"
};

const SESSION_KEYS = {
  accessToken: "auth_access_token",
  accessExpiresAt: "auth_access_expires_at"
};

function nowMs() {
  return Date.now();
}

function hasSessionStorage() {
  return Boolean(chrome.storage && chrome.storage.session);
}

async function localGet(keys) {
  return chrome.storage.local.get(keys);
}

async function localSet(values) {
  return chrome.storage.local.set(values);
}

async function localRemove(keys) {
  return chrome.storage.local.remove(keys);
}

async function sessionGet(keys) {
  if (!hasSessionStorage()) {
    return {};
  }
  return chrome.storage.session.get(keys);
}

async function sessionSet(values) {
  if (!hasSessionStorage()) {
    return;
  }
  return chrome.storage.session.set(values);
}

async function sessionRemove(keys) {
  if (!hasSessionStorage()) {
    return;
  }
  return chrome.storage.session.remove(keys);
}

export function createTokenManager(cloudApi) {
  let accessTokenMemory = "";
  let accessExpiresAtMemory = 0;
  let refreshInFlight = null;

  async function hydrateFromSession() {
    if (accessTokenMemory && accessExpiresAtMemory) {
      return;
    }
    const data = await sessionGet([SESSION_KEYS.accessToken, SESSION_KEYS.accessExpiresAt]);
    accessTokenMemory = String(data[SESSION_KEYS.accessToken] || "");
    accessExpiresAtMemory = Number(data[SESSION_KEYS.accessExpiresAt] || 0);
  }

  function isAccessValid() {
    return Boolean(accessTokenMemory) && accessExpiresAtMemory > nowMs() + 5000;
  }

  async function persistAccess(accessToken, expiresInSec) {
    accessTokenMemory = accessToken;
    accessExpiresAtMemory = nowMs() + expiresInSec * 1000;
    await sessionSet({
      [SESSION_KEYS.accessToken]: accessTokenMemory,
      [SESSION_KEYS.accessExpiresAt]: accessExpiresAtMemory
    });
  }

  async function persistRefresh(refreshToken) {
    await localSet({ [LOCAL_KEYS.refreshToken]: refreshToken });
  }

  async function connectWithApiKey(apiKey) {
    const payload = await cloudApi.exchangeApiKey(apiKey);
    await persistRefresh(payload.refresh_token);
    await persistAccess(payload.access_token, payload.expires_in);
    await localSet({
      [LOCAL_KEYS.tokenMeta]: {
        tokenType: payload.token_type,
        scope: payload.scope,
        connectedAt: new Date().toISOString()
      }
    });
    return getStatus();
  }

  async function refreshAccessToken() {
    if (refreshInFlight) {
      return refreshInFlight;
    }

    refreshInFlight = (async () => {
      const local = await localGet([LOCAL_KEYS.refreshToken]);
      const refreshToken = String(local[LOCAL_KEYS.refreshToken] || "");
      if (!refreshToken) {
        const error = new Error("Not authenticated");
        error.code = "not_authenticated";
        throw error;
      }

      const payload = await cloudApi.refreshAccessToken(refreshToken);
      await persistAccess(payload.access_token, payload.expires_in);
      if (payload.refresh_token) {
        await persistRefresh(payload.refresh_token);
      }
      return payload.access_token;
    })();

    try {
      return await refreshInFlight;
    } finally {
      refreshInFlight = null;
    }
  }

  async function getValidAccessToken() {
    await hydrateFromSession();
    if (isAccessValid()) {
      return accessTokenMemory;
    }
    return refreshAccessToken();
  }

  async function getStatus() {
    await hydrateFromSession();
    const local = await localGet([LOCAL_KEYS.refreshToken, LOCAL_KEYS.tokenMeta]);
    const hasRefreshToken = Boolean(local[LOCAL_KEYS.refreshToken]);
    const hasAccessToken = isAccessValid();

    return {
      authenticated: hasRefreshToken,
      hasRefreshToken,
      hasAccessToken,
      accessExpiresAt: accessExpiresAtMemory || null,
      tokenMeta: local[LOCAL_KEYS.tokenMeta] || null
    };
  }

  async function logout() {
    const local = await localGet([LOCAL_KEYS.refreshToken]);
    const refreshToken = String(local[LOCAL_KEYS.refreshToken] || "");
    if (refreshToken) {
      try {
        await cloudApi.revokeRefreshToken(refreshToken);
      } catch (_error) {
        // best effort
      }
    }

    accessTokenMemory = "";
    accessExpiresAtMemory = 0;

    await Promise.all([
      localRemove([LOCAL_KEYS.refreshToken, LOCAL_KEYS.tokenMeta]),
      sessionRemove([SESSION_KEYS.accessToken, SESSION_KEYS.accessExpiresAt])
    ]);

    return getStatus();
  }

  return {
    connectWithApiKey,
    getValidAccessToken,
    getStatus,
    logout
  };
}
