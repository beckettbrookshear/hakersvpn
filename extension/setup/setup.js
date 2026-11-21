const $ = (id) => document.getElementById(id);

function randomPassword(len = 24) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

const validDomain = (d) => /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(d);
const validIp = (ip) =>
  /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) && ip.split(".").every((n) => Number(n) <= 255);

// Reuse the saved login if there is one, so re-copying the script doesn't
// invalidate a server that is already running.
async function getOrCreateLogin() {
  const { config } = await chrome.storage.local.get("config");
  const login = {
    user: config?.user || "vpn",
    pass: config?.pass || randomPassword(),
  };
  await chrome.storage.local.set({
    config: { host: "", port: "443", tls: true, ...config, ...login },
  });
  return login;
}

async function buildScript() {
  const domain = $("domain").value.trim().toLowerCase();
  if (domain && !validDomain(domain)) {
    alert("That domain doesn't look right. Leave it blank to use the automatic address.");
    return null;
  }
  const { user, pass } = await getOrCreateLogin();
  await chrome.storage.local.set({ setupDomain: domain });
  const template = await (await fetch(chrome.runtime.getURL("setup/server-setup.sh"))).text();
  return template
    .replace('PROXY_USER="__USER__"', `PROXY_USER="${user}"`)
    .replace('PROXY_PASS="__PASS__"', `PROXY_PASS="${pass}"`)
    .replace('DOMAIN="__DOMAIN__"', `DOMAIN="${domain}"`);
}

$("copy").addEventListener("click", async () => {
  const script = await buildScript();
  if (!script) return;
  await navigator.clipboard.writeText(script);
  $("copied").hidden = false;
  setTimeout(() => ($("copied").hidden = true), 3000);
});

$("download").addEventListener("click", async () => {
  const script = await buildScript();
  if (!script) return;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([script], { type: "text/plain" }));
  a.download = "hakersvpn-setup.sh";
  a.click();
  URL.revokeObjectURL(a.href);
});

function setStatus(text, kind = "") {
  $("status").hidden = false;
  $("status").className = `status ${kind}`;
  $("status").textContent = text;
}

// The server answers a direct visit with "404 page not found" once it is
// running with a valid certificate.
async function serverReady(host) {
  try {
    const r = await fetch(`https://${host}/`, { cache: "no-store" });
    return r.status === 404;
  } catch {
    return false;
  }
}

$("check").addEventListener("click", async () => {
  const ip = $("ip").value.trim();
  if (!validIp(ip)) return setStatus("Enter an IPv4 address like 203.0.113.10.", "bad");

  const { config = {}, setupDomain = "" } = await chrome.storage.local.get(["config", "setupDomain"]);
  if (!config.pass) return setStatus("Do step 1 first: copy the setup script.", "bad");

  const host = setupDomain || `${ip.replaceAll(".", "-")}.sslip.io`;
  await chrome.storage.local.set({ config: { ...config, host, port: "443", tls: true } });

  $("check").disabled = true;
  const started = Date.now();
  const limitMs = 15 * 60 * 1000;
  while (Date.now() - started < limitMs) {
    const mins = Math.floor((Date.now() - started) / 60000);
    setStatus(`Waiting for your server to finish setting up… (${mins} min so far — usually 3–5)`);
    if (await serverReady(host)) {
      setStatus("Your server is ready! Click the HakersVPN icon in the toolbar and press Connect.", "good");
      $("check").disabled = false;
      return;
    }
    await new Promise((r) => setTimeout(r, 10000));
  }
  setStatus(
    "The server didn't respond after 15 minutes. Check that you pasted the script when creating it, " +
      "chose Ubuntu 24.04, and allowed ports 80 and 443. Then try again.",
    "bad"
  );
  $("check").disabled = false;
});

chrome.storage.local.get("setupDomain").then(({ setupDomain }) => {
  if (setupDomain) $("domain").value = setupDomain;
});
