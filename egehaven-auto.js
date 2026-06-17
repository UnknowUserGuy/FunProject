#!/usr/bin/env node
/**
 * egehaven-auto.js  (multi-site udgave)
 * ------------------------------------------------------------------
 * Overvaager boligstatus paa én eller flere udforske.com-grunde.
 * Scriptet aabner hver side i en usynlig browser, fanger SELV
 * data-kaldet, og giver besked ved aendringer (fx naar en bolig
 * bliver ledig / til salg).
 *
 * Sites konfigureres nederst i SITES (eller via env-variabler).
 *
 * Installation (engang):
 *   npm install playwright
 *   npx playwright install chromium
 *
 * Brug:
 *   node egehaven-auto.js --discover           # vis hvad den fandt (alle sites)
 *   node egehaven-auto.js --discover --site=astashave
 *   node egehaven-auto.js --once               # ét tjek af ALLE sites
 *   node egehaven-auto.js --once --site=egehaven
 *   node egehaven-auto.js                       # loebende overvaagning af alle
 * ------------------------------------------------------------------
 */

const { chromium } = require("playwright");
const fs = require("fs");

// ============== SITES ==============
// Hver site overvaages uafhaengigt og har sin egen state-fil.
// URL kan overstyres via env-variabler (bruges af GitHub Actions).
const SITES = [
  {
    name: "Egehaven",
    enabled: process.env.EGEHAVEN_ENABLED !== "false",   // <- saet til false for at slaa fra
    url: process.env.EGEHAVEN_URL || "https://egehaven.udforske.com/ground/47/EG1",
    stateFile: process.env.EGEHAVEN_STATE || "./egehaven-state.json"
  },
  {
    name: "Astashave",
    enabled: process.env.ASTASHAVE_ENABLED !== "false",  // <- saet til false for at slaa fra
    url: process.env.ASTASHAVE_URL || "https://astashave.udforske.com/ground/53/AH",
    stateFile: process.env.ASTASHAVE_STATE || "./astashave-state.json"
  }
];

// ============== FAELLES KONFIGURATION ==============
const CONFIG = {
  pollIntervalMs: Number(process.env.WATCH_INTERVAL || 5 * 60 * 1000),

  // Foelg kun bestemte id'er, fx [48, 67, 82, 85]. Tom = alle.
  watchIds: [],

  // Ekstra alarm naar en bolig bliver koebbar. Vi kender ikke det praecise
  // ord endnu, saa vi daekker de sandsynlige. Uanset hvad faar du besked
  // ved ENHVER statusaendring (se nedenfor).
  alertOnStatuses: ["til salg", "ledig", "fri", "available", "klar til salg"],

  // Foelg IKKE boliger med disse statusser (de er ude af spil).
  ignoreStatuses: ["solgt"],

  // Telegram (valgfri). Tom => kun konsol + logfil.
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || "",
    chatId: process.env.TELEGRAM_CHAT_ID || ""
  },

  logFile: "./egehaven-watcher.log"
};

// Midlertidig "udbakke": --check skriver beskeder hertil (sender IKKE),
// og --notify sender dem BAGEFTER - foerst naar state er gemt/pushet.
// Filen committes ALDRIG (staar i .gitignore).
const OUTBOX_FILE = process.env.OUTBOX_FILE || "./outbox.json";
// ===========================================

const FIELD_ALIASES = {
  id:      ["id", "unitId", "unit_id", "number", "nr", "boligId", "boligNr"],
  address: ["address", "adresse", "title", "name", "displayName", "label"],
  area:    ["area", "areal", "size", "m2", "sqm", "boligareal", "livingArea"],
  price:   ["cash_price", "price", "pris", "kontantpris", "cashPrice", "amount"],
  // status_name foerst - det er feltet udforske bruger (Solgt / Koebsaftale ude / Kommer til salg / ...)
  status:  ["status_name", "status", "state", "availability", "tilstand", "salgsstatus", "saleStatus", "status_id"]
};

// Disse statusser betyder at boligen IKKE er til at koebe.
// Skifter en bolig til noget der IKKE staar her (fx "Til salg"/"Ledig"),
// faar du ekstra fremhaevet besked (groent flag).
const UNAVAILABLE_STATUSES = ["solgt", "koebsaftale ude", "købsaftale ude", "kommer til salg", "reserveret"];

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

const normStatus = (s) => String(s ?? "").trim().toLowerCase();

function isRealUnit(u) {
  if (u.id === undefined && u.address === undefined) return false;
  const addr = String(u.address || "").trim().toLowerCase();
  // Drop pladsholdere som "0 0", "stage 4 0", tom adresse:
  if (!addr || addr.startsWith("stage") || addr.startsWith("0")) return false;
  // Drop raekker uden rigtigt areal:
  const area = Number(String(u.area ?? "0").replace(/[^\d.]/g, ""));
  if (!area) return false;
  return true;
}

function extractUnits(raw) {
  const ignore = (CONFIG.ignoreStatuses || []).map(normStatus);
  return deepFindUnitArray(raw).map((u) => ({
    id:      pickField(u, FIELD_ALIASES.id),
    address: pickField(u, FIELD_ALIASES.address),
    area:    pickField(u, FIELD_ALIASES.area),
    price:   pickField(u, FIELD_ALIASES.price),
    status:  pickField(u, FIELD_ALIASES.status)
  })).filter(isRealUnit)
     .filter((u) => !ignore.includes(normStatus(u.status)));
}

function loadState(site) {
  try { return JSON.parse(fs.readFileSync(site.stateFile, "utf8")); }
  catch (_) { return null; }
}
function saveState(site, units) {
  const map = {};
  for (const u of units) map[String(u.id ?? u.address)] = u;
  fs.writeFileSync(site.stateFile, JSON.stringify(map, null, 2));
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

function formatPrice(v) {
  const n = Number(String(v).replace(/[^\d]/g, ""));
  if (!n || n < 1000) return null; // "1"/"0"/tomt = ingen rigtig pris
  return n.toLocaleString("da-DK") + " kr.";
}

function describe(u) {
  const p = [];
  if (u.address) p.push(u.address);
  else if (u.id !== undefined) p.push(`#${u.id}`);
  if (u.area) p.push(`${u.area} m2`);
  const pr = formatPrice(u.price);
  if (pr) p.push(pr);
  return p.join(" · ");
}

async function notifyTelegram(text) {
  const { botToken, chatId } = CONFIG.telegram;
  if (!botToken || !chatId) {
    log("Telegram er ikke konfigureret (token/chatId mangler) - springer afsendelse over.");
    return false;
  }
  try {
    const r = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text })
    });
    if (!r.ok) { log(`Telegram svarede HTTP ${r.status}`); return false; }
    return true;
  } catch (e) { log(`Telegram-fejl: ${e.message}`); return false; }
}

// Bygger besked-teksten (sender den IKKE). Returnerer string eller null.
function buildAnnouncement(site, changes) {
  // Du faar besked om ALT: enhver NY bolig (uanset status) og ENHVER
  // statusaendring paa en eksisterende bolig. watchIds filtrerer IKKE -
  // den saetter kun en ⭐ paa de boliger du evt. har valgt at foelge ekstra.
  const lines = [];
  const unavailable = UNAVAILABLE_STATUSES.map(normStatus);
  const alertList = CONFIG.alertOnStatuses.map(normStatus);
  for (const c of changes) {
    const star = (CONFIG.watchIds.length && inWatchlist(c.unit)) ? "⭐ " : "";
    const newNorm = normStatus(c.unit.status);
    // "available" = en status der IKKE staar paa optaget-listen (fx Ledig).
    const isAvailable = !!newNorm && !unavailable.includes(newNorm);
    if (c.type === "ny") {
      const tag = isAvailable ? "🆕🟢 NY LEDIG BOLIG" : "🆕 Ny bolig";
      lines.push(`${star}${tag}: ${describe(c.unit)} — status: ${c.unit.status}`);
    } else { // statusskift paa en bolig vi allerede kender
      const becameAvailable = isAvailable || alertList.includes(newNorm);
      const tag = becameAvailable ? "🟢 MULIGVIS LEDIG" : "🔄 Statusskift";
      lines.push(`${star}${tag}: ${describe(c.unit)} — ${c.from} → ${c.to}`);
    }
  }
  if (!lines.length) return null;
  return `${site.name} – ændringer:\n` + lines.join("\n");
}

/**
 * Aabner site-siden i en usynlig browser og fanger SELV alle JSON-svar.
 * Returnerer { units, captures }.
 */
async function sniff(page, site) {
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

  // Tving friske data: tilfoej no-cache paa alle requests, saa hverken
  // browser-cache eller en evt. CDN serverer en gammel boligliste.
  await page.route("**/*", (route) => {
    const headers = { ...route.request().headers(), "cache-control": "no-cache", "pragma": "no-cache" };
    route.continue({ headers });
  });

  await page.goto(site.url, { waitUntil: "networkidle", timeout: 60000 });
  // Giv evt. sene kald lov til at lande:
  await page.waitForTimeout(3000);
  page.off("response", handler);

  // Vaelg det svar med flest boliger (mest sandsynligt den rigtige liste).
  captures.sort((a, b) => b.count - a.count);
  const best = captures[0];
  return { units: best ? best.units : [], captures };
}

async function runDiscover(sites) {
  const browser = await chromium.launch();
  try {
    for (const site of sites) {
      const page = await browser.newPage();
      log(`[${site.name}] Aabner siden og lytter efter data-kald...`);
      const { units, captures } = await sniff(page, site);
      await page.close();

      if (!captures.length) {
        log(`[${site.name}] Fandt INGEN JSON med boligdata. Skriv til mig saa justerer vi.`);
        continue;
      }
      log(`[${site.name}] Fandt ${captures.length} datakilde(r). Bedste indeholder ${units.length} boliger.`);
      log(`[${site.name}] Endpoint(s):`);
      captures.forEach((c) => log(`  - ${c.count} boliger fra: ${c.url}`));
      log(`[${site.name}] Eksempel paa de foerste boliger:`);
      console.log(JSON.stringify(units.slice(0, 5), null, 2));
    }
  } finally {
    await browser.close();
  }
}

// Finder alle arrays-af-objekter dybt i et JSON-svar.
function deepFindObjectArrays(data, acc = []) {
  if (Array.isArray(data)) {
    const objs = data.filter((x) => x && typeof x === "object" && !Array.isArray(x));
    if (objs.length) acc.push(objs);
    data.forEach((x) => deepFindObjectArrays(x, acc));
  } else if (data && typeof data === "object") {
    Object.values(data).forEach((v) => deepFindObjectArrays(v, acc));
  }
  return acc;
}

// Kompakt resume pr. site: feltnavne, ét eksempel-objekt, og felter med faa
// distinkte vaerdier (= sandsynlige status-felter).
async function runDump(sites) {
  const browser = await chromium.launch();
  try {
    for (const site of sites) {
      const page = await browser.newPage();
      const seen = [];
      page.on("response", async (res) => {
        try {
          const ct = (res.headers()["content-type"] || "").toLowerCase();
          if (!ct.includes("json")) return;
          seen.push({ url: res.url(), text: await res.text() });
        } catch (_) { /* spring uoplaeselige svar over */ }
      });

      log(`[${site.name}] Aabner siden og laver et kort resume af dataene...`);
      await page.goto(site.url, { waitUntil: "networkidle", timeout: 60000 });
      await page.waitForTimeout(3500);
      await page.close();

      const arrays = [];
      seen.forEach((r) => {
        try {
          deepFindObjectArrays(JSON.parse(r.text)).forEach((objs) =>
            arrays.push({ src: r.url, objs })
          );
        } catch (_) {}
      });
      arrays.sort((a, b) => b.objs.length - a.objs.length);

      log(`[${site.name}] JSON-svar: ${seen.length}. Objekt-lister fundet: ${arrays.length}.`);
      log(`[${site.name}] Endpoints:`);
      [...new Set(seen.map((s) => s.url))].slice(0, 8).forEach((u) => log(`  - ${u}`));

      arrays.slice(0, 3).forEach((a, i) => {
        const objs = a.objs;
        console.log(`\n--- [${site.name}] LISTE #${i}: ${objs.length} objekter ---`);
        console.log("Felter: " + Object.keys(objs[0]).join(", "));
        console.log("Eksempel (foerste objekt):");
        console.log(JSON.stringify(objs[0], null, 2).slice(0, 1000));

        const keys = Object.keys(objs[0]);
        const enumLines = [];
        for (const k of keys) {
          const vals = new Set();
          for (const o of objs) {
            const v = o[k];
            if (v === null || ["string", "number", "boolean"].includes(typeof v)) {
              vals.add(String(v));
            }
            if (vals.size > 10) break;
          }
          if (vals.size >= 1 && vals.size <= 8) {
            enumLines.push(`  ${k}: ${[...vals].join(" | ")}`);
          }
        }
        if (enumLines.length) {
          console.log("Felter med faa vaerdier (mulige status-felter):");
          console.log(enumLines.join("\n"));
        }
      });
    }
  } finally {
    await browser.close();
  }
}

async function checkSite(browser, site, outbox, { notify }) {
  const page = await browser.newPage();
  let result;
  try { result = await sniff(page, site); }
  finally { await page.close(); }

  const units = result.units;
  if (!units.length) {
    // Ingen data (fx siden fejlede/var tom): roer IKKE ved state, saa vi
    // ikke ved en fejl "glemmer" alle boliger og spammer falske beskeder.
    log(`[${site.name}] ADVARSEL: ingen boliger fundet i dette tjek. State er uaendret.`);
    return;
  }

  const prevMap = loadState(site);
  if (prevMap === null) {
    saveState(site, units);
    log(`[${site.name}] Baseline gemt med ${units.length} boliger. Overvaager nu...`);
    return;
  }

  const changes = diff(prevMap, units);

  // VIGTIGT: gem state FOERST. En besked maa aldrig sendes uden at den
  // tilhoerende state-aendring ogsaa er gemt - ellers opdager naeste
  // koersel samme aendring igen og sender dubletter.
  saveState(site, units);

  if (!changes.length) {
    log(`[${site.name}] Ingen aendringer (${units.length} boliger tjekket).`);
    return;
  }

  const msg = buildAnnouncement(site, changes);
  if (!msg) return;
  log(msg);
  if (notify) {
    await notifyTelegram(msg);   // --once: send direkte (lokal brug)
  } else {
    outbox.push(msg);            // --check: gem til senere (efter git push)
  }
}

// Uden --site: kun sites med enabled=true. Med --site=navn: tvinges med (god til test).
function selectedSites() {
  const arg = process.argv.find((a) => a.startsWith("--site="));
  if (!arg) {
    const active = SITES.filter((s) => s.enabled);
    if (!active.length) log("Ingen sites er slaaet til (enabled=false paa alle).");
    return active;
  }
  const want = arg.split("=")[1].trim().toLowerCase();
  const picked = SITES.filter((s) => s.name.toLowerCase() === want); // --site overstyrer enabled
  if (!picked.length) {
    log(`Ukendt site "${want}". Kendte: ${SITES.map((s) => s.name).join(", ")}`);
    process.exit(1);
  }
  return picked;
}

(async () => {
  const sites = selectedSites();

  if (process.argv.includes("--dump")) {
    await runDump(sites);
    return;
  }
  if (process.argv.includes("--discover")) {
    await runDiscover(sites);
    return;
  }

  // --notify: send beskeder fra udbakken. Bruger INGEN browser.
  // Koeres FOERST efter at state er gemt+pushet, saa en sendt besked
  // altid svarer til en gemt state-aendring (= ingen dubletter).
  if (process.argv.includes("--notify")) {
    let msgs = [];
    try { msgs = JSON.parse(fs.readFileSync(OUTBOX_FILE, "utf8")); } catch (_) { msgs = []; }
    if (!Array.isArray(msgs) || !msgs.length) {
      log("Udbakken er tom - intet at sende.");
      return;
    }
    let ok = 0, fail = 0;
    for (const m of msgs) { (await notifyTelegram(m)) ? ok++ : fail++; }
    log(`Telegram: ${ok} sendt, ${fail} fejlet.`);
    if (fail === 0) {
      try { fs.unlinkSync(OUTBOX_FILE); } catch (_) {}
    } else {
      // Behold udbakken og fejl, saa man kan se det og evt. koere igen.
      process.exitCode = 1;
    }
    return;
  }

  const browser = await chromium.launch();
  try {
    const isCheck = process.argv.includes("--check");
    const isOnce = process.argv.includes("--once");

    if (isCheck || isOnce) {
      const outbox = [];
      for (const site of sites) {
        try { await checkSite(browser, site, outbox, { notify: isOnce }); }
        catch (e) { log(`[${site.name}] Fejl under tjek: ${e.message}`); }
      }
      // --check skriver beskederne til udbakken (sender dem ikke her).
      if (isCheck) {
        try { fs.writeFileSync(OUTBOX_FILE, JSON.stringify(outbox, null, 2)); }
        catch (e) { log(`Kunne ikke skrive udbakke: ${e.message}`); }
        log(`Udbakke skrevet med ${outbox.length} besked(er).`);
      }
    } else {
      log(`Starter overvaagning af ${sites.length} site(s). Tjekker hvert ${Math.round(CONFIG.pollIntervalMs / 1000)} sek.`);
      for (;;) {
        for (const site of sites) {
          try { await checkSite(browser, site, [], { notify: true }); }
          catch (e) { log(`[${site.name}] Fejl under tjek: ${e.message}`); }
        }
        await new Promise((r) => setTimeout(r, CONFIG.pollIntervalMs));
      }
    }
  } finally {
    await browser.close();
  }
})();
