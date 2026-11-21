const $ = (id) => document.getElementById(id);
const fields = ["host", "port", "user", "pass"];

async function render() {
  const { config, state = "off", error = "" } = await chrome.storage.local.get([
    "config", "state", "error",
  ]);
  if (config) {
    for (const f of fields) $(f).value = config[f] ?? "";
    $("tls").checked = config.tls !== false;
  }
  $("setupHint").hidden = Boolean(config?.host);
  const connected = state === "on" || state === "error";
  $("status").className = `pill ${state}`;
  $("status").textContent = { on: "Connected", error: "Error", off: "Off" }[state];
  $("toggle").textContent = connected ? "Disconnect" : "Connect";
  $("toggle").classList.toggle("disconnect", connected);
  $("error").hidden = !error;
  $("error").textContent = error;
}

function readForm() {
  if (!$("form").reportValidity()) return null;
  const config = Object.fromEntries(fields.map((f) => [f, $(f).value.trim()]));
  config.tls = $("tls").checked;
  return config;
}

$("toggle").addEventListener("click", async () => {
  const { state } = await chrome.storage.local.get("state");
  let msg;
  if (state === "on" || state === "error") {
    msg = { type: "disconnect" };
  } else {
    const config = readForm();
    if (!config) { $("settings").open = true; return; }
    msg = { type: "connect", config };
  }
  $("toggle").disabled = true;
  await chrome.runtime.sendMessage(msg);
  $("toggle").disabled = false;
  await render();
  checkIp();
});

async function checkIp() {
  $("ip").textContent = "…";
  try {
    const r = await fetch("https://api.ipify.org?format=json", { cache: "no-store" });
    $("ip").textContent = (await r.json()).ip;
  } catch {
    $("ip").textContent = "unreachable";
  }
}

$("checkIp").addEventListener("click", checkIp);

const openSetup = () => chrome.tabs.create({ url: chrome.runtime.getURL("setup/setup.html") });
$("openSetup").addEventListener("click", openSetup);
$("openSetup2").addEventListener("click", openSetup);
chrome.storage.onChanged.addListener(render);
render();
