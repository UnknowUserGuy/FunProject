#!/usr/bin/env node
/**
 * egehaven-auto.js
 * ------------------------------------------------------------------
 * NEM version: du behoever IKKE finde noget i DevTools.
 * Scriptet aabner egehaven.udforske.com i en usynlig browser, fanger
 * SELV data-kaldet, og overvaager boligstatus for aendringer.
 *
 * Installation (engang):
 *   npm install playwright
 *   npx playwright install chromium
 *
 * Brug:
 *   node egehaven-auto.js --discover   # vis hvad den fandt (koer denne FOERST)
 *   node egehaven-auto.js --once       # ét tjek
 *   node egehaven-auto.js              # loebende overvaagning
 * ------------------------------------------------------------------
 */

const { chromium } = require("playwright");
const fs = require("fs");

// ============== KONFIGURATION ==============
const CONFIG = {
  groundUrl: process.env.EGEHAVEN_URL || "https://egehaven.udforske.com/ground/47/EG1",

  pollIntervalMs: Number(process.env.EGEHAVEN_INTERVAL || 5 * 60 * 1000),

  // Foelg kun bestemte id'er, fx [48, 67, 82, 85]. Tom = alle.
  watchIds: [],

  // Ekstra alarm naar en bolig bliver ledig.
  alertOnStatuses: ["ledig", "available", "fri"],

  // Telegram (valgfri). Tom => kun konsol + logfil.
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || "",
    chatId: process.env.TELEGRAM_CHAT_ID || ""
  },

  stateFile: "./egehaven-state.json",
  logFile: "./egehaven-watcher.log"
};
// ===========================================

const FIELD_ALIASES = {
  id:      ["id", "unitId", "unit_id", "number", "nr", "boligId", "boligNr"],
  address: ["address", "adresse", "title", "name", "displayName", "label"],
  area:    ["area", "areal", "size", "m2", "sqm", "boligareal", "livingArea"],
  price:   ["price", "pris", "kontantpris", "cashPrice", "cash_price", "amount"],
  status:  ["status", "state", "availability", "tilstand", "salgsstatus", "saleStatus"]
};

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(CONFIG.logFile, line + "\n"); } catch (_) {}
}

function pickField(obj, aliases) {
  if (!obj || typeof obj !== "object") return undefined;
  const lower = {};
  for (const k of Object.keys(obj)) lower[k.toLowerCase()] = obj[k];
  for (const a of aliases) {
    const v = lower[a.toLowerCase()];
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
}

function looksLikeUnit(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
  const hasStatus = pickField(obj, FIELD_ALIASES.status) !== undefined;
  const hasIdOrAddr =
    pickField(obj, FIELD_ALIASES.id) !== undefined ||
    pickField(obj, FIELD_ALIASES.address) !== undefined;
  return hasStatus && hasIdOrAddr;
}

function deepFindUnitArray(data) {
  let best = null;
  const visit = (node) => {
    if (Array.isArray(node)) {
      const unitish = node.filter(looksLikeUnit);
      if (unitish.length && (!best || unitish.length > best.length)) best = unitish;
      node.forEach(visit);
    } else if (node && typeof node === "object") {
      Object.values(node).forEach(visit);
    }
  };
  visit(data);
  return best || [];
}

function extractUnits(raw) {
  return deepFindUnitArray(raw).map((u) => ({
    id:      pickField(u, FIELD_ALIASES.id),
    address: pickField(u, FIELD_ALIASES.address),
    area:    pickField(u, FIELD_ALIASES.area),
    price:   pickField(u, FIELD_ALIASES.price),
    status:  pickField(u, FIELD_ALIASES.status)
  })).filter((u) => u.id !== undefined || u.address !== undefined);
}

const normStatus = (s) => String(s ?? "").trim().toLowerCase();

function loadState() {
  try { return JSON.parse(fs.readFileSync(CONFIG.stateFile, "utf8")); }
  catch (_) { return null; }
}
function saveState(units) {
  const map = {};
  for (const u of units) map[String(u.id ?? u.address)] = u;
  fs.writeFileSync(CONFIG.stateFile, JSON.stringify(map, null, 2));
}

function inWatchlist(u) {
  if (!CONFIG.watchIds.length) return true;
  return CONFIG.watchIds.map(String).includes(String(u.id));
}

function diff(prevMap, currUnits) {
  const changes = [];
  for (const u of currUnits) {
    const key = String(u.id ?? u.address);
    const old = prevMap[key];
    if (!old) { changes.push({ type: "ny", unit: u }); continue; }
    if (normStatus(old.status) !== normStatus(u.status)) {
      changes.push({ type: "status", unit: u, from: old.status, to: u.status });
    }
  }
  return changes;
}

function describe(u) {
  const p = [];
  if (u.id !== undefined) p.push(`#${u.id}`);
  if (u.address) p.push(u.address);
  if (u.area) p.push(`${u.area} m2`);
  if (u.price && u.price !== "-") p.push(`${u.price}`);
  return p.join(" · ");
}

async function notifyTelegram(text) {
  const { botToken, chatId } = CONFIG.telegram;
  if (!botToken || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text })
    });
  } catch (e) { log(`Telegram-fejl: ${e.message}`); }
}

async function announce(changes) {
  const lines = [];
  for (const c of changes) {
    const relevant = inWatchlist(c.unit);
    const alert = CONFIG.alertOnStatuses.map(normStatus).includes(normStatus(c.unit.status));
    if (!relevant && !alert) continue;
    if (c.type === "ny") {
      lines.push(`🆕 Ny bolig: ${describe(c.unit)} — status: ${c.unit.status}`);
    } else {
      lines.push(`${alert ? "🟢" : "🔄"} ${describe(c.unit)} — ${c.from} → ${c.to}`);
    }
  }
  if (!lines.length) return;
  const msg = "Egehaven – ændringer:\n" + lines.join("\n");
  log(msg);
  await notifyTelegram(msg);
}

/**
 * Aabner siden i en usynlig browser og fanger SELV alle JSON-svar.
 * Returnerer { units, captures } hvor captures er info om hvad der blev set.
 */
async function sniff(page) {
  const captures = [];
  const handler = async (res) => {
    try {
      const ct = (res.headers()["content-type"] || "").toLowerCase();
      if (!ct.includes("json")) return;
      const data = await res.json();
      const units = extractUnits(data);
      if (units.length) captures.push({ url: res.url(), count: units.length, units });
    } catch (_) { /* ignorer ikke-parsebare svar */ }
  };
  page.on("response", handler);

  await page.goto(CONFIG.groundUrl, { waitUntil: "networkidle", timeout: 60000 });
  // Giv evt. sene kald lov til at lande:
  await page.waitForTimeout(3000);
  page.off("response", handler);

  // Vaelg det svar med flest boliger (mest sandsynligt den rigtige liste).
  captures.sort((a, b) => b.count - a.count);
  const best = captures[0];
  return { units: best ? best.units : [], captures };
}

async function runDiscover() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  log("Aabner siden og lytter efter data-kald...");
  const { units, captures } = await sniff(page);
  await browser.close();

  if (!captures.length) {
    log("Fandt INGEN JSON med boligdata. Skriv til mig saa justerer vi.");
    return;
  }
  log(`Fandt ${captures.length} datakilde(r). Bedste indeholder ${units.length} boliger.`);
  log("Endpoint(s):");
  captures.forEach((c) => log(`  - ${c.count} boliger fra: ${c.url}`));
  log("Eksempel paa de foerste boliger:");
  console.log(JSON.stringify(units.slice(0, 5), null, 2));
}

async function checkOnce(browser) {
  const page = await browser.newPage();
  let result;
  try { result = await sniff(page); }
  finally { await page.close(); }

  const units = result.units;
  if (!units.length) { log("ADVARSEL: ingen boliger fundet i dette tjek."); return; }

  const prevMap = loadState();
  if (prevMap === null) {
    saveState(units);
    log(`Baseline gemt med ${units.length} boliger. Overvaager nu...`);
    return;
  }
  const changes = diff(prevMap, units);
  if (changes.length) await announce(changes);
  else log(`Ingen aendringer (${units.length} boliger tjekket).`);
  saveState(units);
}

(async () => {
  if (process.argv.includes("--discover")) {
    await runDiscover();
    return;
  }

  const browser = await chromium.launch();
  try {
    if (process.argv.includes("--once")) {
      await checkOnce(browser);
    } else {
      log(`Starter overvaagning. Tjekker hvert ${Math.round(CONFIG.pollIntervalMs / 1000)} sek.`);
      for (;;) {
        try { await checkOnce(browser); }
        catch (e) { log(`Fejl under tjek: ${e.message}`); }
        await new Promise((r) => setTimeout(r, CONFIG.pollIntervalMs));
      }
    }
  } finally {
    if (process.argv.includes("--once") || process.argv.includes("--discover")) {
      await browser.close();
    }
  }
})();
