const pairForm = document.querySelector("#pair-form");
const searchPanel = document.querySelector("#search");
const searchForm = document.querySelector("#search-form");
const queryInput = document.querySelector("#query");
const results = document.querySelector("#results");
const status = document.querySelector("#status");
const error = document.querySelector("#error");
const refreshButton = document.querySelector("#refresh");
let sessionId = "";
let catalogue = [];
const base = window.location.origin;
const DATABASE_NAME = "substream-companion";
const STORE_NAME = "catalogues";

const params = new URLSearchParams(window.location.search);
if (params.get("code")) document.querySelector("#code").value = params.get("code");

pairForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  error.textContent = "";
  try {
    const response = await fetch(`${base}/api/pair/join`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: document.querySelector("#code").value }) });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || "Pairing failed.");
    sessionId = value.sessionId;
    pairForm.hidden = true;
    searchPanel.hidden = false;
    queryInput.focus();
    status.textContent = "Connected. Saving a searchable catalogue on this device…";
    await refreshCatalogue(false);
  } catch (cause) { error.textContent = cause instanceof Error ? cause.message : "Pairing failed."; }
});

searchForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const query = queryInput.value.trim();
  if (query.length < 2 || !sessionId) return;
  results.replaceChildren();
  status.textContent = catalogue.length ? "Searching saved catalogue…" : "Searching provider catalogue…";
  try {
    const found = catalogue.length ? searchCatalogue(catalogue, query) : await searchProvider(query);
    showResults(found);
  } catch (cause) { status.textContent = ""; error.textContent = cause instanceof Error ? cause.message : "Search failed."; }
});

refreshButton.addEventListener("click", () => void refreshCatalogue(true));

async function refreshCatalogue(forceProviderRefresh) {
  refreshButton.disabled = true;
  error.textContent = "";
  status.textContent = forceProviderRefresh ? "Refreshing provider catalogue…" : "Loading provider catalogue…";
  try {
    const response = await fetch(`${base}/api/catalogue?sessionId=${encodeURIComponent(sessionId)}${forceProviderRefresh ? "&refresh=1" : ""}`);
    const value = await response.json();
    if (!response.ok || !Array.isArray(value.records)) throw new Error(value.error || "Catalogue refresh failed.");
    catalogue = value.records;
    await saveCatalogue(catalogue);
    status.textContent = `${catalogue.length.toLocaleString()} titles saved on this device.`;
  } catch (cause) {
    catalogue = await loadLatestCatalogue();
    if (catalogue.length) status.textContent = `${catalogue.length.toLocaleString()} saved titles are available offline. Refresh will work when the LAN service returns.`;
    else error.textContent = cause instanceof Error ? cause.message : "Catalogue refresh failed.";
  } finally { refreshButton.disabled = false; }
}

async function searchProvider(query) {
  const response = await fetch(`${base}/api/search?sessionId=${encodeURIComponent(sessionId)}&q=${encodeURIComponent(query)}`);
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || "Search failed.");
  return value.results;
}

function searchCatalogue(records, query) {
  const terms = normalize(query).split(" ").filter(Boolean);
  return records.filter((record) => {
    const title = normalize(record.title || "");
    return terms.every((term) => title.includes(term));
  }).sort((left, right) => String(left.title).localeCompare(String(right.title))).slice(0, 50);
}

function showResults(found) {
  status.textContent = `${found.length} result${found.length === 1 ? "" : "s"}`;
  for (const item of found) {
    const button = document.createElement("button");
    button.className = "result";
    button.type = "button";
    button.innerHTML = `<span>${escapeHtml(item.title)}</span><small>${item.kind}${item.year ? ` · ${item.year}` : ""}${item.category ? ` · ${escapeHtml(item.category)}` : ""}</small>`;
    button.addEventListener("click", () => void select(item, button));
    results.append(button);
  }
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME, { keyPath: "sourceFingerprint" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Browser catalogue storage is unavailable."));
  });
}

async function saveCatalogue(records) {
  const sourceFingerprint = records[0]?.sourceFingerprint;
  if (!sourceFingerprint) return;
  const database = await openDatabase();
  await new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put({ sourceFingerprint, records, savedAt: Date.now() });
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
  database.close();
}

async function loadLatestCatalogue() {
  try {
    const database = await openDatabase();
    const records = await new Promise((resolve, reject) => {
      const request = database.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    database.close();
    return records.sort((left, right) => right.savedAt - left.savedAt)[0]?.records || [];
  } catch { return []; }
}

function normalize(value) { return String(value).normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }

async function select(item, button) {
  button.disabled = true;
  error.textContent = "";
  try {
    const response = await fetch(`${base}/api/pair/select`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId, selection: item }) });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || "The TV could not receive this selection.");
    status.textContent = `${item.title} sent to TV.`;
  } catch (cause) { button.disabled = false; error.textContent = cause instanceof Error ? cause.message : "Selection failed."; }
}

function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]); }
