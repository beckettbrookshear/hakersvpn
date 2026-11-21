// HakersVPN background service worker.
//
// Connecting = pointing Chrome's proxy settings at the server (fixed_servers,
// so if the server is unreachable requests FAIL rather than leaking out
// directly) and blocking WebRTC from bypassing the proxy.

const authAttempts = new Map(); // requestId -> tries, to stop loops on bad creds

async function getConfig() {
  const { config } = await chrome.storage.local.get("config");
  return config || null;
}

async function setState(state, error = "") {
  await chrome.storage.local.set({ state, error });
  const badge = { on: "ON", error: "ERR", off: "" }[state] ?? "";
  const color = state === "error" ? "#c0392b" : "#1e8e3e";
  await chrome.action.setBadgeText({ text: badge });
  await chrome.action.setBadgeBackgroundColor({ color });
}

async function connect(config) {
  await chrome.storage.local.set({ config });
  await chrome.proxy.settings.set({
    scope: "regular",
    value: {
      mode: "fixed_servers",
      rules: {
        singleProxy: {
          scheme: config.tls ? "https" : "http",
          host: config.host,
          port: Number(config.port),
        },
        bypassList: ["<local>", "localhost", "127.0.0.1", "[::1]"],
      },
    },
  });
  // Stop WebRTC from revealing your real IP outside the tunnel.
  await chrome.privacy.network.webRTCIPHandlingPolicy.set({
    value: "disable_non_proxied_udp",
  });
  await setState("on");
}

async function disconnect() {
  await chrome.proxy.settings.clear({ scope: "regular" });
  await chrome.privacy.network.webRTCIPHandlingPolicy.clear({});
  await setState("off");
}

// Supply credentials when the server answers 407. Registered at top level
// so it keeps working after the service worker restarts.
chrome.webRequest.onAuthRequired.addListener(
  (details, callback) => {
    if (!details.isProxy) return callback({});
    const tries = (authAttempts.get(details.requestId) || 0) + 1;
    authAttempts.set(details.requestId, tries);
    if (tries > 2) {
      setState("error", "Server rejected username/password");
      return callback({ cancel: true });
    }
    getConfig().then((c) =>
      callback(c ? { authCredentials: { username: c.user, password: c.pass } } : {})
    );
  },
  { urls: ["<all_urls>"] },
  ["asyncBlocking"]
);

const forget = (d) => authAttempts.delete(d.requestId);
chrome.webRequest.onCompleted.addListener(forget, { urls: ["<all_urls>"] });
chrome.webRequest.onErrorOccurred.addListener(forget, { urls: ["<all_urls>"] });

chrome.proxy.onProxyError.addListener((e) => {
  setState("error", e.error || "Proxy error");
});

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  (async () => {
    try {
      if (msg.type === "connect") await connect(msg.config);
      else if (msg.type === "disconnect") await disconnect();
      reply({ ok: true });
    } catch (e) {
      await setState("error", String(e.message || e));
      reply({ ok: false, error: String(e.message || e) });
    }
  })();
  return true; // async reply
});

// Open the setup page right after the extension is first installed.
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") {
    chrome.tabs.create({ url: chrome.runtime.getURL("setup/setup.html") });
  }
});

// Restore the badge when the browser starts.
chrome.runtime.onStartup.addListener(async () => {
  const { state } = await chrome.storage.local.get("state");
  await setState(state === "on" ? "on" : "off");
});
