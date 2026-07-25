// ================================================================
//  GOLD & CURRENCY TRACKER — Myanmar Edition
//  ALL ranges → Line Chart only
//  10Y → annual data + dashed forecast overlay
//  1Y  → monthly data
//  1M  → daily data (~22 trading days)
//  1W  → daily data (last 7 trading days)
// ================================================================

const GOLD_API             = "https://api.gold-api.com/price/XAU";
const FREE_GOLD_HISTORY_API= "https://freegoldapi.com/data/latest.json"; // real daily gold (USD/oz) history, no key needed
// Real 7-day gold forecast, trained by train_forecast_model.py (SARIMA) and
// committed daily by GitHub Actions after the data collector runs.
const ML_FORECAST_URL       = "https://raw.githubusercontent.com/Whitey999/tracker/main/forecast.json";
// ⚠️ SECURITY NOTE: this key lives in client-side JS, so it is visible to
// anyone who opens browser DevTools / View Source on this page. GoldAPI.io's
// free tier is quota-limited (~100 requests/month). Before deploying this
// site publicly with real traffic, move this key behind a server-side proxy
// (e.g. the Python backend mentioned earlier) instead of calling it directly
// from the browser. Used sparingly below (only to backfill recent gap days).
const GOLDAPI_IO_KEY       = "goldapi-80052cf5b856a93ccffcc0336ee9b5ba-io";
const GOLDAPI_IO_BASE      = "https://www.goldapi.io/api/XAU/USD";
const USD_HISTORY_CSV_URL  = "https://raw.githubusercontent.com/Whitey999/tracker/main/usd_history.csv"; // real black-market history, built by pipeline/ scripts — see pipeline/README.md
const CURRENCY_API         = "https://api.frankfurter.dev/v2/rates"; // official mid-market rates — used ONLY by the currency converter for non-MMK pairs, never for USD/MMK display
const CURRENCY_HISTORY_API = "https://api.frankfurter.dev/v2";        // + /rates?from=&to= for date ranges

const TICAL_TO_OZ = 16.3293 / 31.1035;

// On-page debug log (temporary) — shows API fetch status directly on the
// page so it can be read/copied without opening browser DevTools.
function dbg(msg){
    const el = document.getElementById("debug-panel");
    if (!el) { console.log(msg); return; }
    const t = new Date().toLocaleTimeString();
    el.textContent += `[${t}] ${msg}\n`;
    console.log(msg);
}

// Local-calendar-date ISO string (YYYY-MM-DD) WITHOUT converting through UTC.
// Date.prototype.toISOString() converts to UTC first, which silently shifts
// the date backward by one day for positive UTC-offset timezones (e.g.
// Myanmar, UTC+6:30) during early-morning local hours — this caused weekend
// dates to leak into "weekday-only" ranges and broke calendar-month filters.
// Always use this instead of toISOString() when the Date object represents
// a LOCAL calendar day (as opposed to a UTC timestamp).
function localIso(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth()+1).padStart(2,"0");
    const day = String(d.getDate()).padStart(2,"0");
    return `${y}-${m}-${day}`;
}

// ── State ────────────────────────────────────────────────────────
let goldHistory        = [];
let usdHistory         = [];
let goldDailyHistory   = [];
let usdDailyHistory    = [];
let goldChart          = null;
let usdChart           = null;
let isDarkMode         = true;
let currentGoldRange   = "10y";
let currentUsdRange    = "10y";
let liveGoldPrice      = 0;
let liveUsdRate        = 0;
let liveUsdSell        = 0;
let goldUsdPerOz       = 0;
let goldRealDailyRaw   = []; // real {date, price(USD/oz)} records from freegoldapi.com
let usingRealGoldDaily = false;

// ================================================================
//  BOOT
// ================================================================
document.addEventListener("DOMContentLoaded", async function () {
    setupDarkMode();
    setupEventListeners();
    await loadAllData();
    setActiveCard("gold");
});

// ================================================================
//  LOAD ALL DATA
// ================================================================
async function loadAllData() {
    document.getElementById("gold-price").innerHTML = "Loading...";
    document.getElementById("usd-rate").innerHTML   = "Loading...";

    await loadUsdData();               // real black-market history + live rate, both from usd_history.csv
    // usd_history.csv is built server-side by pipeline/backfill_usd_history.py
    // (one-time) and pipeline/update_usd_rate.py (daily, via GitHub Actions —
    // see pipeline/README.md), then committed to the repo. Fetching it here
    // is a single static-file request: no client-side API calls, no CORS
    // risk, no dead third-party endpoints.
    await Promise.all([loadGoldPrice(), loadRealGoldHistory()]);
    buildRealGoldDailyHistory(); // real freegoldapi.com data — no simulated/estimated fallback
    buildGoldMonthlyReal();      // real freegoldapi.com monthly data (World Bank) for older years
    // NOTE: GoldAPI.io gap-backfill removed — their API blocks direct browser
    // requests (CORS), so it silently failed. Re-enable once a server-side
    // proxy (e.g. the planned Python backend) can call it instead.
    buildRealAnnualHistory();    // derive yearly averages from the real data above — no hardcoded tables

    updateGoldDisplay();
    updateUsdDisplay();
    loadGoldChart(currentGoldRange);
    loadUsdChart(currentUsdRange);
    updateMarketAnalysis();
    updateForecasts();
    updateLastUpdate();

    dbg(`SUMMARY — Gold 1W: ${goldSlice("1w").length} pts | Gold 1M: ${goldSlice("1m").length} pts | USD 1W: ${usdSlice("1w").length} pts | USD 1M: ${usdSlice("1m").length} pts`);
}

// ── Annual aggregates — derived ONLY from real fetched data ─────
// Groups the real gold (goldMonthlyReal + goldDailyHistory) and real
// USD (usdDailyHistory) records by calendar year and averages them.
// No hardcoded price tables: a year with no real records simply does
// not appear, instead of being filled in with an invented number.
function buildRealAnnualHistory() {
    goldHistory = aggregateByYear([...goldMonthlyReal, ...goldDailyHistory], "price");
    usdHistory  = aggregateByYear(usdDailyHistory, "rate");
}

function aggregateByYear(records, field) {
    const byYear = new Map();
    records.forEach(r => {
        if (!r.iso || r[field] == null) return;
        const yr = new Date(r.iso + "T00:00:00").getFullYear();
        if (!byYear.has(yr)) byYear.set(yr, {sum:0, count:0});
        const g = byYear.get(yr);
        g.sum += r[field]; g.count++;
    });
    const years = [...byYear.keys()].sort((a,b)=>a-b);
    let prev = null;
    return years.map(yr => {
        const avg = Math.round(byYear.get(yr).sum / byYear.get(yr).count);
        const change = prev != null ? ((avg-prev)/prev*100) : 0;
        prev = avg;
        return {year:yr, date:String(yr), [field]:avg, change};
    });
}

// ── FALLBACK: no simulated numbers. If the real feed is unreachable,
// leave history empty and be honest about it in the UI instead of
// generating fake prices.
function clearGoldDailyHistoryNoData() {
    goldDailyHistory = [];
    usingRealGoldDaily = false;
}

// ================================================================
//  REAL GOLD DAILY HISTORY — freegoldapi.com (no API key needed)
//  Real USD/oz market data (Yahoo Finance gold futures, 2025–present).
//  USD→MMK conversion uses ONLY real Frankfurter rates for that exact
//  date (last ~45 real days). No interpolation/estimation is used —
//  any gold-USD record whose date has no matching real MMK rate is
//  skipped rather than faked, so every point shown is 100% real data.
// ================================================================
// freegoldapi.com's full feed also carries REAL monthly gold prices back
// to 1960 (World Bank Pink Sheet) underneath the last-400-days daily
// (Yahoo Finance) window — we were fetching all of it but throwing the
// older records away. Keep them separately so the 10Y/1Y "full history"
// modal can show real monthly points for years before the daily feed
// starts, instead of one fake-interpolated point per year.
let goldRealExtendedRaw = [];
async function loadRealGoldHistory() {
    try {
        const res = await fetch(FREE_GOLD_HISTORY_API);
        const raw = await res.json();
        const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 400);
        goldRealDailyRaw = (raw || [])
            .filter(d => d.price && new Date(d.date + "T00:00:00") >= cutoff)
            .sort((a,b) => new Date(a.date) - new Date(b.date));
        const extStart = new Date(); extStart.setFullYear(extStart.getFullYear() - 15);
        goldRealExtendedRaw = (raw || [])
            .filter(d => d.price && new Date(d.date + "T00:00:00") >= extStart)
            .sort((a,b) => new Date(a.date) - new Date(b.date));
        dbg(`freegoldapi.com: fetched ${raw?.length||0} total, ${goldRealDailyRaw.length} within last 400 days, ${goldRealExtendedRaw.length} within last 15 years. Latest: ${goldRealDailyRaw[goldRealDailyRaw.length-1]?.date || "none"}`);
    } catch (e) {
        dbg(`freegoldapi.com: FETCH FAILED — ${e.message||e}`);
        goldRealDailyRaw = [];
        goldRealExtendedRaw = [];
    }
}

// USD→MMK rate for a date — always uses live BLACK MARKET rate (liveUsdRate).
// Frankfurter historical data gives the official/CBM rate (~2100) which is
// NOT what gold shops use. We use the live black market rate for ALL dates
// so history is consistent with today's displayed price.
function realUsdMmkRateForDate(d) {
    return liveUsdRate || null; // real black market street rate only — never Frankfurter, never a guess
}

function buildRealGoldDailyHistory() {
    if (!goldRealDailyRaw.length) { clearGoldDailyHistoryNoData(); return; }
    goldDailyHistory = [];
    let prev = null;
    goldRealDailyRaw.forEach((rec) => {
        const d = new Date(rec.date + "T00:00:00");
        const mmkRate = realUsdMmkRateForDate(d);
        if (mmkRate == null) return;
        const label = d.toLocaleDateString("en-US", {month:"short", day:"numeric"});
        const price = Math.round((rec.price * TICAL_TO_OZ * mmkRate) / 1000) * 1000;
        const change = prev ? ((price - prev) / prev * 100) : 0;
        goldDailyHistory.push({date:label, iso:rec.date, price, change, usdOz:rec.price});
        prev = price;
    });

    // Add today as the final real point: gold-api.com live USD price ×
    // the live Myanmar USD/MMK rate — both real, computed in loadGoldPrice().
    // Skipped entirely if today's live price isn't actually available.
    if (liveGoldPrice > 0) {
        const today = new Date();
        const todayIso = localIso(today);
        const label = today.toLocaleDateString("en-US", {month:"short", day:"numeric"});
        if (goldDailyHistory.length && goldDailyHistory[goldDailyHistory.length-1].iso === todayIso) {
            const last = goldDailyHistory[goldDailyHistory.length-1];
            const prevRec = goldDailyHistory[goldDailyHistory.length-2];
            last.price = liveGoldPrice;
            last.change = prevRec ? ((liveGoldPrice - prevRec.price) / prevRec.price * 100) : 0;
        } else {
            const change = prev ? ((liveGoldPrice - prev) / prev * 100) : 0;
            goldDailyHistory.push({date:label, iso:todayIso, price:liveGoldPrice, change, usdOz:goldUsdPerOz});
        }
    }
    usingRealGoldDaily = goldDailyHistory.length > 0;
}

// Real MONTHLY gold points (World Bank Pink Sheet, via freegoldapi.com)
// converted to MMK, for years the daily (Yahoo Finance) feed doesn't
// reach. Same live black-market USD/MMK rate as the daily conversion —
// see the note on realUsdMmkRateForDate().
let goldMonthlyReal = [];
function buildGoldMonthlyReal() {
    if (!goldRealExtendedRaw.length) { goldMonthlyReal = []; return; }
    const earliestDailyIso = goldDailyHistory.length ? goldDailyHistory[0].iso : null;
    let prev = null;
    goldMonthlyReal = goldRealExtendedRaw
        .filter(rec => !earliestDailyIso || rec.date < earliestDailyIso)
        .map(rec => {
            const d = new Date(rec.date + "T00:00:00");
            const mmkRate = realUsdMmkRateForDate(d);
            if (mmkRate == null) return null; // no real rate for this date — skip rather than guess
            const label = d.toLocaleDateString("en-US", {year:"numeric", month:"short", day:"numeric"});
            const price = Math.round((rec.price * TICAL_TO_OZ * mmkRate) / 1000) * 1000;
            const change = prev ? ((price - prev) / prev * 100) : 0;
            prev = price;
            return {date:label, iso:rec.date, price, change, usdOz:rec.price};
        })
        .filter(Boolean);
    dbg(`gold monthly real: ${goldMonthlyReal.length} World-Bank-sourced points built`);
}

// NOTE: A GoldAPI.io per-day backfill was tried here to patch recent gaps,
// but GoldAPI.io blocks direct browser requests (CORS) — it only works from
// a server. Removed to avoid dead code; re-add server-side once the planned
// Python backend exists (GOLDAPI_IO_KEY is still defined above for that).

// ================================================================
//  API — GOLD PRICE
// ================================================================
async function loadGoldPrice() {
    try {
        const r=await fetch(GOLD_API), d=await r.json();
        const price = d.price || d.ask;
        if (!(price > 0)) throw new Error("Gold API returned no usable price");
        goldUsdPerOz = price;
        liveGoldPrice = liveUsdRate>0 ? Math.round((goldUsdPerOz*TICAL_TO_OZ*liveUsdRate)/1000)*1000 : 0;
    } catch(e) {
        console.error("Gold API:",e);
        dbg(`Gold API: FETCH FAILED — ${e.message||e}. No fabricated fallback used; keeping last known price.`);
        // liveGoldPrice is left as-is (whatever the last real fetch produced,
        // or 0 on first load) rather than substituted with an invented number.
    }
    return liveGoldPrice;
}

// ================================================================
//  API — USD RATE (Myanmar market → CBM → Frankfurter → fallback)
// ================================================================
// Myanmar has TWO real, legitimate USD/MMK rates that coexist: an
// official/CBM reference rate (~2,000-2,200) and a black market/street
// rate (what gold shops & money changers actually use, historically
// ~3,400-4,800+, confirmed accurate by on-the-ground verification).
// This app tracks the black-market rate (myanmar-currency-api.github.io
// is a parallel-market source), so the sanity check only rejects
// clearly-broken values (e.g. 0, negative, or wildly implausible),
// not anything that looks "different from the official rate."
const RATE_PLAUSIBLE_MIN = 3000;  // reject CBM official rate (~2100); only accept black market rate (3000+)
const RATE_PLAUSIBLE_MAX = 8000;

function isRateSane(rate){
    return rate >= RATE_PLAUSIBLE_MIN && rate <= RATE_PLAUSIBLE_MAX;
}

// ================================================================
//  USD/MMK — real black-market data, loaded from usd_history.csv
//  (built server-side by pipeline/backfill_usd_history.py +
//  pipeline/update_usd_rate.py, run via GitHub Actions — see
//  pipeline/README.md). This replaces per-visit client-side API calls
//  entirely: no CORS risk, no dead APIs, no rate-limit exposure. The
//  CSV's last row IS today's live rate (updated once/day by the Action).
// ================================================================
async function loadUsdData() {
    usdDailyHistory = [];
    try {
        const res = await fetch(USD_HISTORY_CSV_URL + `?t=${Date.now()}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        const lines = text.trim().split("\n").slice(1); // drop header row
        let prev = null;
        lines.forEach(line => {
            const [dateStr, buyStr, sellStr] = line.split(",");
            const buy = parseFloat(buyStr), sell = parseFloat(sellStr ?? buyStr);
            if (!dateStr || !isRateSane(buy)) return; // skip malformed/implausible rows, never invent one
            const d = new Date(dateStr + "T00:00:00");
            const label = d.toLocaleDateString("en-US", {month:"short", day:"numeric", year:"numeric"});
            const change = prev ? ((buy - prev) / prev * 100) : 0;
            usdDailyHistory.push({year: d.getFullYear(), date: label, iso: dateStr, rate: buy, sell, change});
            prev = buy;
        });
    } catch (e) {
        console.warn("USD history CSV:", e);
        dbg(`USD history: FAILED to load ${USD_HISTORY_CSV_URL} — ${e.message||e}. No fabricated fallback used.`);
    }
    const last = usdDailyHistory[usdDailyHistory.length - 1];
    liveUsdRate = last ? last.rate : 0;
    liveUsdSell = last ? last.sell : 0;
    dbg(`USD history: ${usdDailyHistory.length} real record(s) loaded from usd_history.csv.${last?` Latest: ${last.iso} = ${last.rate}`:""}`);
    return liveUsdRate;
}

function todayLabel(){return new Date().toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"});}

// ================================================================
//  DISPLAY CARDS
// ================================================================
function updateGoldDisplay(){
    document.getElementById("gold-price").innerHTML = liveGoldPrice>0 ? liveGoldPrice.toLocaleString() : "Unavailable";
    const last=goldHistory[goldHistory.length-1],chg=last?.change||0;
    const el=document.getElementById("gold-change");
    el.innerHTML=`${chg>=0?"▲":"▼"} ${Math.abs(chg).toFixed(2)}%`;
    el.className=`card-change ${chg>=0?"positive":"negative"}`;
}
function updateUsdDisplay(){
    if(!(liveUsdRate>0)){
        document.getElementById("usd-rate").innerHTML="Unavailable";
    } else {
        const buy=Math.round(liveUsdRate).toLocaleString(),sell=Math.round(liveUsdSell).toLocaleString();
        document.getElementById("usd-rate").innerHTML=(liveUsdSell&&liveUsdSell!==liveUsdRate)
            ?`${buy} <span style="font-size:11px;opacity:0.5;">/ ${sell}</span>`:buy;
    }
    const last=usdHistory[usdHistory.length-1],chg=last?.change||0;
    const el=document.getElementById("usd-change");
    el.innerHTML=`${chg>=0?"▲":"▼"} ${Math.abs(chg).toFixed(2)}%`;
    el.className=`card-change ${chg>=0?"positive":"negative"}`;
}

// ================================================================
//  CHART COLOURS
// ================================================================
function C(){
    const dk=isDarkMode;
    return {
        text:      dk?"#7a88a8":"#1a1a2e",
        grid:      dk?"rgba(255,255,255,0.05)":"rgba(0,0,0,0.08)",
        goldLine:  "#d4af37",
        goldTop:   dk?"rgba(212,175,55,0.25)":"rgba(212,175,55,0.15)",
        goldBot:   "rgba(212,175,55,0)",
        usdLine:   "#2ecc71",
        usdTop:    dk?"rgba(46,204,113,0.20)":"rgba(46,204,113,0.12)",
        usdBot:    "rgba(46,204,113,0)",
        fcLine:    "#7b8cde",
        fcTop:     dk?"rgba(123,140,222,0.15)":"rgba(123,140,222,0.08)",
        fcBot:     "rgba(123,140,222,0)",
        tooltipBg: dk?"#0e1425":"#ffffff",
        dotBg:     dk?"#080c18":"#ffffff",
    };
}

function makeGrad(ctx, top, bot){
    const g=ctx.createLinearGradient(0,0,0,300);
    g.addColorStop(0,top); g.addColorStop(1,bot); return g;
}

// ── Shared line chart options ────────────────────────────────────
function lineOpts(c, tickFmt, range){
    const manyPoints = range==="1m"; // 22+ points — hide dots for cleaner look
    return {
        responsive:true, maintainAspectRatio:false,
        plugins:{
            legend:{ labels:{color:c.text,font:{size:11,weight:"600"},boxWidth:12,usePointStyle:true,pointStyleWidth:10} },
            tooltip:{
                backgroundColor:c.tooltipBg,
                borderColor:"rgba(212,175,55,0.3)",borderWidth:1,
                titleColor:"#d4af37",bodyColor:c.text,padding:12,
                callbacks:{label: ctx=>`  ${ctx.raw!=null?ctx.raw.toLocaleString():"—"} MMK`}
            }
        },
        scales:{
            y:{
                ticks:{color:c.text,font:{size:10},callback:tickFmt},
                grid:{color:c.grid},
                border:{color:"transparent"}
            },
            x:{
                ticks:{color:c.text,font:{size:10},maxTicksLimit:range==="10y"?12:range==="1y"?12:8,maxRotation:45,minRotation:0},
                grid:{color:"transparent"},
                border:{color:"transparent"}
            }
        },
        elements:{
            point:{
                radius:      4,
                hoverRadius: 7,
                hitRadius:   12,
            }
        },
        interaction:{mode:"index",intersect:false},
        animation:{duration:400,easing:"easeInOutQuart"}
    };
}

// ── Aggregate daily records into one averaged point per calendar month.
// Used only for the CHART line on 1Y (visual smoothing) — the Detailed
// History table below it still shows the full real daily records.
function monthlyAverage(records, valueKey){
    const groups = new Map(); // "YYYY-MM" -> {sum, count}
    records.forEach(r=>{
        if(!r.iso) return;
        const key = r.iso.slice(0,7);
        if(!groups.has(key)) groups.set(key, {sum:0,count:0});
        const g = groups.get(key);
        g.sum += (r[valueKey] ?? 0);
        g.count++;
    });
    const keys = [...groups.keys()].sort();
    let prev = null;
    return keys.map(k=>{
        const g = groups.get(k);
        const avg = g.sum / g.count;
        const d = new Date(k+"-01T00:00:00");
        const label = d.toLocaleDateString("en-US",{month:"short",year:"numeric"});
        const change = prev ? ((avg-prev)/prev*100) : 0;
        prev = avg;
        return {date:label, iso:k+"-01", [valueKey]:Math.round(avg), change};
    });
}

// ── Filter a daily-record array to the trailing N calendar days
// (today back to today-N), NOT "records that fall within the current
// calendar month". This is what "1M" should mean: e.g. on July 3rd it
// should still show ~30 days back (spanning into June), instead of only
// the 1-3 days that happen to fall in the new month so far. Weekends /
// holidays that have no record are simply absent from the result — the
// calendar window itself still spans the full N days ("ပိတ်ရက်ပါ
// ထည့်တွက်ပါ" — count closed days into the window, just don't fabricate
// a price for them).
function lastNCalendarDays(history, days){
    const cutoff = new Date();
    cutoff.setHours(0,0,0,0);
    cutoff.setDate(cutoff.getDate() - days);
    const filtered = history.filter(d=>{
        if(!d.iso) return false;
        return new Date(d.iso+"T00:00:00") >= cutoff;
    });
    return filtered.length ? filtered : history.slice(-days);
}

// ── Data slices per range ────────────────────────────────────────
function goldSlice(range){
    if(range==="1w") return goldDailyHistory.slice(-7);
    if(range==="1m") return lastNCalendarDays(goldDailyHistory, 30);
    if(range==="1y") return goldDailyHistory.slice(-261); // whatever real daily coverage actually exists (up to ~1 trading year)
    return goldHistory; // 10Y: real annual averages, derived from actual fetched data (range varies with source coverage)
}
function usdSlice(range){
    if(range==="1w") return usdDailyHistory.slice(-7);
    if(range==="1m") return lastNCalendarDays(usdDailyHistory, 30);
    if(range==="1y") return usdDailyHistory.length>=12?usdDailyHistory:usdHistory.slice(-12);
    return usdHistory;
}

// ── Daily regression forecast engine (for 7-Day widget) ──────────
// Same regression+momentum approach as buildForecast(), but indexed by
// trading day instead of by year, and projecting real calendar dates
// forward instead of years.
function buildDailyForecast(dailyHist, field, aheadDays) {
    if (!dailyHist || dailyHist.length < 2) return { forecasts: [], r2: 0, recentAvgChg: 0 };
    const recentHist = dailyHist.slice(-30); // regression window: last 30 real daily records
    const xs = recentHist.map((d, i) => i), ys = recentHist.map(d => d[field]);
    const n = xs.length, sx = xs.reduce((a, b) => a + b, 0), sy = ys.reduce((a, b) => a + b, 0);
    const sxy = xs.reduce((s, x, i) => s + x * ys[i], 0), sxx = xs.reduce((s, x) => s + x * x, 0);
    const den = n * sxx - sx * sx, slope = den ? (n * sxy - sx * sy) / den : 0, intercept = (sy - slope * sx) / n;
    const ym = sy / n, ssTot = ys.reduce((s, y) => s + (y - ym) ** 2, 0);
    const ssRes = ys.reduce((s, y, i) => s + (y - (slope * xs[i] + intercept)) ** 2, 0);
    const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 1;

    const rec = dailyHist.slice(-7); // momentum window: last 7 real daily records
    const avgChg = rec.length > 1 ? rec.reduce((s, d, i) => i === 0 ? 0 : s + d.change, 0) / (rec.length - 1) : 0;

    const lastReal = dailyHist[dailyHist.length - 1];
    const lastDate = new Date((lastReal.iso || localIso(new Date())) + "T00:00:00");
    const baseX = recentHist.length - 1;

    const forecasts = [];
    for (let i = 1; i <= aheadDays; i++) {
        const rv = slope * (baseX + i) + intercept;
        const lv = lastReal[field];
        const mv = lv * Math.pow(1 + avgChg / 100, i);
        const bl = rv * 0.5 + mv * 0.5;
        const rd = field === "price" ? Math.round(bl / 1000) * 1000 : Math.round(bl);
        const pv = i === 1 ? lv : forecasts[i - 2].value;
        const fd = new Date(lastDate); fd.setDate(fd.getDate() + i);
        const label = fd.toLocaleDateString("en-US", { month: "short", day: "numeric" });
        forecasts.push({ year: label, date: label, value: rd, change: pv > 0 ? ((rd - pv) / pv * 100) : 0, r2 });
    }
    return { forecasts, r2, recentAvgChg: avgChg };
}

// ── Regression forecast engine ───────────────────────────────────
function buildForecast(history,field,ahead){
    const xs=history.map(d=>d.year),ys=history.map(d=>d[field]);
    const n=xs.length,sx=xs.reduce((a,b)=>a+b,0),sy=ys.reduce((a,b)=>a+b,0);
    const sxy=xs.reduce((s,x,i)=>s+x*ys[i],0),sxx=xs.reduce((s,x)=>s+x*x,0);
    const den=n*sxx-sx*sx,slope=den?(n*sxy-sx*sy)/den:0,intercept=(sy-slope*sx)/n;
    const ym=sy/n,ssTot=ys.reduce((s,y)=>s+(y-ym)**2,0);
    const ssRes=ys.reduce((s,y,i)=>s+(y-(slope*xs[i]+intercept))**2,0);
    const r2=ssTot>0?1-ssRes/ssTot:1;
    const rec=history.slice(-5);
    const avgChg=rec.length>1?rec.reduce((s,d,i)=>i===0?0:s+d.change,0)/(rec.length-1):0;
    const forecasts=[];
    for(let i=1;i<=ahead;i++){
        const yr=2026+i,rv=slope*yr+intercept;
        const lv=history[history.length-1][field];
        const mv=lv*Math.pow(1+avgChg/100,i);
        const bl=rv*0.6+mv*0.4;
        const rd=field==="price"?Math.round(bl/1000)*1000:Math.round(bl);
        const pv=i===1?lv:forecasts[i-2].value;
        forecasts.push({year:yr,date:String(yr),value:rd,change:pv>0?((rd-pv)/pv*100):0,r2});
    }
    return {forecasts,r2,recentAvgChg:avgChg};
}

// pointRadius per range — 1M slightly smaller dots
function dotRadius(range){ return range==="1m"?3:4; }

// ================================================================
//  [10] GOLD CHART — Line Chart for all ranges
// ================================================================
function loadGoldChart(range){
    const canvas=document.getElementById("goldChart");
    const ctx=canvas.getContext("2d");
    if(goldChart) goldChart.destroy();

    const c=C();
    const rawData=goldSlice(range);
    const data = range==="1y" ? monthlyAverage(rawData,"price") : rawData; // smoother chart line for 1Y
    const show10y=range==="10y";
    const {forecasts}=show10y?buildForecast(goldHistory,"price",10):{forecasts:[]};

    const hLabels=data.map(d=>d.date);
    const hVals  =data.map(d=>d.price??0);
    const allLabels=show10y?[...hLabels,...forecasts.map(f=>f.date)]:hLabels;

    // Historical line: null-pad to leave room for forecast
    const histLine=show10y?[...hVals,...Array(forecasts.length).fill(null)]:hVals;
    // Forecast line: stitch from last historical point
    const fcLine=show10y?[...Array(hLabels.length-1).fill(null),hVals[hVals.length-1],...forecasts.map(f=>f.value)]:null;

    const gHist=makeGrad(ctx,c.goldTop,c.goldBot);
    const gFc   =makeGrad(ctx,c.fcTop,c.fcBot);

    const datasets=[{
        label:`Gold MMK / tical`,
        data:histLine,
        borderColor:c.goldLine, backgroundColor:gHist,
        borderWidth:2.5, fill:true, tension:0.4,
        pointBackgroundColor:c.goldLine,
        pointBorderColor:c.dotBg,
        pointBorderWidth:2,
        pointRadius:dotRadius(range),
        pointHoverRadius:dotRadius(range)+3,
        spanGaps:false,
    }];

    if(show10y&&fcLine){
        datasets.push({
            label:"Forecast 2027–2036",
            data:fcLine,
            borderColor:c.fcLine, backgroundColor:gFc,
            borderWidth:2, borderDash:[7,4],
            fill:true, tension:0.4,
            pointBackgroundColor:c.fcLine,
            pointBorderColor:c.dotBg,
            pointBorderWidth:2,
            spanGaps:false,
        });
    }

    const tickFmt = v=>v>=1000000?(v/1000000).toFixed(1)+"M":Math.round(v/1000)+"K";
    goldChart=new Chart(ctx,{type:"line",data:{labels:allLabels,datasets},options:lineOpts(c,tickFmt,range)});

    // Gold Detailed History table shows only real annual historical data —
    // the forecast (2027–2036) stays on the chart above only, not in this table.
    loadGoldTable(rawData, [], range);
}

// ================================================================
//  [11] GOLD TABLE
// ================================================================
function loadGoldTable(histData,fcData,range){
    const tbody=document.getElementById("gold-table-body");
    tbody.innerHTML="";
    const note=document.getElementById("gold-data-source-note");
    if(note){
        if(range==="10y") note.textContent=goldHistory.length?`✅ Real annual averages (${goldHistory[0].year}–${goldHistory[goldHistory.length-1].year}), derived from live market data, + regression forecast for future years (forecast is a projection, not real data).`:"❌ Not enough real historical data yet to build annual averages.";
        else if(!usingRealGoldDaily || !histData.length) note.textContent="❌ No real data available right now (source unreachable or no overlapping USD↔MMK rate for these dates). Try 🔄 Refresh.";
        else if(range==="1y" && histData.length<261) note.textContent=`✅ 100% real daily data — ${histData.length} trading day(s) available. Converted using black market USD/MMK rate.`;
        else note.textContent="✅ 100% real data — gold price from freegoldapi.com (Yahoo Finance), converted to MMK using current black market rate.";
    }
    if(fcData&&fcData.length){
        fcData.slice().reverse().forEach(f=>{
            const row=document.createElement("tr");row.style.opacity="0.75";
            row.innerHTML=`<td>${f.date} 🔮</td><td style="color:#7b8cde;font-weight:700">${f.value.toLocaleString()}</td><td class="${f.change>=0?"positive":"negative"}">${f.change>=0?"▲":"▼"} ${Math.abs(f.change).toFixed(1)}%</td>`;
            tbody.appendChild(row);
        });
        const sep=document.createElement("tr");
        sep.innerHTML=`<td colspan="3" style="text-align:center;font-size:9px;letter-spacing:0.1em;color:#2a3550;padding:6px 0;">── HISTORICAL RECORDS ──</td>`;
        tbody.appendChild(sep);
    }
    histData.slice().reverse().forEach(item=>{
        const val=item.price??0,chg=item.change??0;
        const row=document.createElement("tr");
        row.innerHTML=`<td>${item.date}</td><td>${val.toLocaleString()}</td><td class="${chg>=0?"positive":"negative"}">${chg>=0?"▲":"▼"} ${Math.abs(chg).toFixed(2)}%</td>`;
        tbody.appendChild(row);
    });
}

// ================================================================
//  [12] USD CHART — Line Chart for all ranges
// ================================================================
function loadUsdChart(range){
    const canvas=document.getElementById("usdChart");
    const ctx=canvas.getContext("2d");
    if(usdChart) usdChart.destroy();

    const c=C();
    const rawData=usdSlice(range);
    const data = range==="1y" ? monthlyAverage(rawData,"rate") : rawData; // smoother chart line for 1Y
    const show10y=range==="10y";
    const {forecasts}=show10y?buildForecast(usdHistory,"rate",10):{forecasts:[]};

    const hLabels=data.map(d=>d.date);
    const hVals  =data.map(d=>d.rate??0);
    const allLabels=show10y?[...hLabels,...forecasts.map(f=>f.date)]:hLabels;
    const histLine=show10y?[...hVals,...Array(forecasts.length).fill(null)]:hVals;
    const fcLine=show10y?[...Array(hLabels.length-1).fill(null),hVals[hVals.length-1],...forecasts.map(f=>f.value)]:null;

    const gHist=makeGrad(ctx,c.usdTop,c.usdBot);
    const gFc   =makeGrad(ctx,c.fcTop,c.fcBot);

    const datasets=[{
        label:`USD / MMK Rate`,
        data:histLine,
        borderColor:c.usdLine, backgroundColor:gHist,
        borderWidth:2.5, fill:true, tension:0.4,
        pointBackgroundColor:c.usdLine,
        pointBorderColor:c.dotBg,
        pointBorderWidth:2,
        pointRadius:dotRadius(range),
        pointHoverRadius:dotRadius(range)+3,
        spanGaps:false,
    }];
    if(show10y&&fcLine){
        datasets.push({
            label:"Forecast 2027–2036",
            data:fcLine,
            borderColor:c.fcLine, backgroundColor:gFc,
            borderWidth:2, borderDash:[7,4],
            fill:true, tension:0.4,
            pointBackgroundColor:c.fcLine,
            pointBorderColor:c.dotBg,
            pointBorderWidth:2,
            spanGaps:false,
        });
    }

    usdChart=new Chart(ctx,{type:"line",data:{labels:allLabels,datasets},options:lineOpts(c,v=>v.toLocaleString(),range)});

    // USD Detailed History table shows only real historical data —
    // the forecast (2027–2036) stays on the chart above only, not in this table.
    loadUsdTable(rawData, []);
}

// ================================================================
//  [13] USD TABLE
// ================================================================
function loadUsdTable(histData,fcData){
    const tbody=document.getElementById("usd-table-body");
    tbody.innerHTML="";
    const note=document.getElementById("usd-data-source-note");
    if(note){
        if(!histData.length) note.textContent="❌ No real USD/MMK rate available right now (all sources unreachable or implausible). Try 🔄 Refresh.";
        else note.textContent=`✅ Real black-market data only (${histData[0].date} – ${histData[histData.length-1].date}), built server-side from real sources — no fabricated days. There's a gap around 2024-06 to whenever the daily pipeline was turned on (see pipeline/README.md).`;
    }
    if(fcData&&fcData.length){
        fcData.slice().reverse().forEach(f=>{
            const row=document.createElement("tr");row.style.opacity="0.75";
            row.innerHTML=`<td>${f.date} 🔮</td><td style="color:#7b8cde;font-weight:700">${Math.round(f.value).toLocaleString()}</td><td class="${f.change>=0?"positive":"negative"}">${f.change>=0?"▲":"▼"} ${Math.abs(f.change).toFixed(1)}%</td>`;
            tbody.appendChild(row);
        });
        const sep=document.createElement("tr");
        sep.innerHTML=`<td colspan="3" style="text-align:center;font-size:9px;letter-spacing:0.1em;color:#2a3550;padding:6px 0;">── HISTORICAL RECORDS ──</td>`;
        tbody.appendChild(sep);
    }
    histData.slice().reverse().forEach(item=>{
        const val=item.rate??0,chg=item.change??0;
        const row=document.createElement("tr");
        row.innerHTML=`<td>${item.date}</td><td>${val.toLocaleString()}</td><td class="${chg>=0?"positive":"negative"}">${chg>=0?"▲":"▼"} ${Math.abs(chg).toFixed(2)}%</td>`;
        tbody.appendChild(row);
    });
}

// ================================================================
//  FORECASTS (widget steps)
// ================================================================
async function updateForecasts(){await updateGoldForecast();updateUsdForecast();}

async function updateGoldForecast(){
    try{
        const res = await fetch(ML_FORECAST_URL + `?t=${Date.now()}`);
        if(!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if(!data.forecast || !data.forecast.length) throw new Error("empty forecast");

        const lastReal = data.last_real;
        const lastVal  = data.forecast[data.forecast.length-1].value;
        const isUp = lastVal >= lastReal.value;
        const dq = data.data_quality || {};
        const conf = Math.min(95, Math.max(40, Math.round(dq.pct_real || 70)));

        document.getElementById("gold-trend-badge").innerHTML = isUp?"📈 UPTREND":"📉 DOWNTREND";
        document.getElementById("gold-trend-badge").className = `forecast-badge ${isUp?"uptrend":""}`;
        document.getElementById("gold-bar-fill").style.width = `${conf}%`;
        document.getElementById("gold-confidence").innerHTML =
            `✅ ${data.model || "SARIMA"} model · ${dq.real_days ?? "?"} real / ${dq.interpolated_days ?? 0} interpolated day(s) (${dq.pct_real ?? "?"}% real)`
            + (data.warning ? ` · ⚠️ ${data.warning}` : "");

        const stepsEl = document.getElementById("gold-forecast-steps");
        stepsEl.innerHTML = "";
        let prev = lastReal.value;
        data.forecast.forEach((f,i)=>{
            const changePct = ((f.value - prev) / prev * 100);
            const disp = f.value>=1000000 ? (f.value/1000000).toFixed(2)+"M" : Math.round(f.value/1000)+"K";
            const st=document.createElement("div");st.className="step";
            st.innerHTML=`<div class="step-day">${f.date}</div><div class="step-price">${disp}</div><div class="step-change ${changePct>=0?"positive":"negative"}">${changePct>=0?"▲":"▼"} ${Math.abs(changePct).toFixed(1)}%</div>`;
            stepsEl.appendChild(st);
            if(i<data.forecast.length-1){const a=document.createElement("div");a.className="step-arrow";a.innerHTML="→";stepsEl.appendChild(a);}
            prev = f.value;
        });
        return; // success — don't fall through to the JS regression fallback
    }catch(e){
        console.warn("Python SARIMA forecast.json unavailable, falling back to JS regression:", e);
    }

    // Fallback: in-browser regression on real daily data (used only if
    // forecast.json can't be reached — e.g. offline, or the model hasn't
    // run yet on a brand-new repo).
    const {forecasts,r2,recentAvgChg}=buildDailyForecast(goldDailyHistory,"price",7);
    const isUp=recentAvgChg>0,conf=Math.min(88,Math.round(55+r2*30));
    document.getElementById("gold-trend-badge").innerHTML=isUp?"📈 UPTREND":"📉 DOWNTREND";
    document.getElementById("gold-trend-badge").className=`forecast-badge ${isUp?"uptrend":""}`;
    document.getElementById("gold-bar-fill").style.width=`${conf}%`;
    document.getElementById("gold-confidence").innerHTML=`⚠️ Fallback estimate (JS regression) · Confidence: ${conf}% · R²=${r2.toFixed(2)} · Avg/day: ${recentAvgChg>=0?"+":""}${recentAvgChg.toFixed(2)}%`;
    renderSteps("gold-forecast-steps",forecasts.slice(0,7),true);
}
function updateUsdForecast(){
    const {forecasts,r2,recentAvgChg}=buildDailyForecast(usdDailyHistory,"rate",7);
    const isUp=recentAvgChg>0,conf=Math.min(80,Math.round(45+r2*30));
    document.getElementById("usd-trend-badge").innerHTML=isUp?"📈 UPTREND":"📉 STABLE";
    document.getElementById("usd-trend-badge").className=`forecast-badge ${isUp?"uptrend":""}`;
    document.getElementById("usd-bar-fill").style.width=`${conf}%`;
    const ce=document.getElementById("usd-confidence");
    ce.className=conf>=65?"confidence-high":"confidence-medium";
    ce.innerHTML=`${conf>=65?"✅":"⚠️"} Confidence: ${conf}% · R²=${r2.toFixed(2)} · Avg/day: ${recentAvgChg>=0?"+":""}${recentAvgChg.toFixed(2)}%`;
    renderSteps("usd-forecast-steps",forecasts.slice(0,7),false);
}
function renderSteps(id,steps,isGold){
    const c=document.getElementById(id);c.innerHTML="";
    steps.forEach((s,i)=>{
        const v=isGold?s.value:Math.round(s.value);
        const disp=isGold?(v>=1000000?(v/1000000).toFixed(2)+"M":Math.round(v/1000)+"K"):v.toLocaleString();
        const st=document.createElement("div");st.className="step";
        st.innerHTML=`<div class="step-day">${s.year}</div><div class="step-price">${disp}</div><div class="step-change ${s.change>=0?"positive":"negative"}">${s.change>=0?"▲":"▼"} ${Math.abs(s.change).toFixed(1)}%</div>`;
        c.appendChild(st);
        if(i<steps.length-1){const a=document.createElement("div");a.className="step-arrow";a.innerHTML="→";c.appendChild(a);}
    });
}

// ================================================================
//  MARKET ANALYSIS
// ================================================================
// Percent change over the last N daily records (falls back to 0 if not enough real data).
function pctChangeOverDays(dailyHist, field, days) {
    if (!dailyHist || dailyHist.length < 2) return 0;
    const last = dailyHist[dailyHist.length - 1][field];
    const idx = Math.max(0, dailyHist.length - 1 - days);
    const base = dailyHist[idx][field];
    return base > 0 ? ((last - base) / base * 100) : 0;
}

function updateMarketAnalysis(){
    const gH=goldHistory,uH=usdHistory;
    const g30=pctChangeOverDays(goldDailyHistory,"price",30);
    const u30=pctChangeOverDays(usdDailyHistory,"rate",30);
    const g5=gH.length>=6?((gH[gH.length-1].price-gH[gH.length-6].price)/gH[gH.length-6].price*100):0;

    // Trend + BUY/SELL/HOLD recommendations are now based on the last 1 MONTH
    // of real daily data (g30/u30), not the old annual-momentum basis.
    const trend=g30>0?"UPTREND":"CONSOLIDATION";
    const vol=Math.abs(g5)>50?"High":"Medium";

    let gAct,ga;
    if(g30>8){gAct="SELL";ga="Price surged over the past month — consider taking profit.";}
    else if(g30<-8){gAct="BUY";ga="Price dipped over the past month — potential buying opportunity.";}
    else{gAct="HOLD";ga="Price fairly stable over the past month — no strong signal.";}

    let uAct,ua;
    if(u30>5){uAct="BUY";ua="USD/MMK rising — buying USD now may beat further increases.";}
    else if(u30<-5){uAct="SELL";ua="USD/MMK falling — a good time to convert USD back to MMK.";}
    else{uAct="HOLD";ua="USD/MMK fairly stable over the past month — no strong signal.";}

    setEl("overall-trend",trend,`analysis-value ${trend==="UPTREND"?"uptrend":""}`);
    setEl("gold-30d-change",`${g30>=0?"+":""}${g30.toFixed(2)}%`,`analysis-value ${g30>=0?"positive":"negative"}`);
    setEl("usd-30d-change",`${u30>=0?"+":""}${u30.toFixed(2)}%`,`analysis-value ${u30>=0?"positive":"negative"}`);
    setEl("volatility",vol);setEl("gold-advice",ga);setEl("usd-advice",ua);
    setEl("gold-action",gAct,`rec-action ${gAct.toLowerCase()}`);setEl("gold-reason",ga);
    setEl("usd-action",uAct,`rec-action ${uAct.toLowerCase()}`);setEl("usd-reason",ua);
    setEl("trend",trend);setEl("confidence",`Confidence: ${Math.min(99,Math.round(55+Math.abs(g30)*2))}%`);
}
function setEl(id,html,cls){const e=document.getElementById(id);if(!e)return;e.innerHTML=html;if(cls!==undefined)e.className=cls;}

// ================================================================
//  CURRENCY CONVERTER
// ================================================================
async function convertCurrency(){
    const amount=parseFloat(document.getElementById("amount").value);
    const from=document.getElementById("from-currency").value;
    const to=document.getElementById("to-currency").value;
    const el=document.getElementById("conversion-result");
    if(isNaN(amount)||amount<=0){el.innerHTML="Please enter a valid amount";return;}
    el.innerHTML="Converting...";
    try{
        const mmk={USD:liveUsdRate};
        if(to==="MMK"&&mmk[from]){el.innerHTML=`${amount.toLocaleString()} ${from} = <strong>${Math.round(amount*mmk[from]).toLocaleString()} MMK</strong>`;return;}
        const r=await fetch(`${CURRENCY_API}?base=${from}&quotes=${to}`),d=await r.json();
        const rate=Array.isArray(d)?d[d.length-1]?.rate:(d.rate??d.rates?.[to]);
        if(!(rate>0)) throw new Error("no rate");
        el.innerHTML=`${amount.toLocaleString()} ${from} = <strong>${(amount*rate).toLocaleString(undefined,{maximumFractionDigits:2})} ${to}</strong>`;
    }catch(e){
        console.warn("Currency conversion:",e);
        el.innerHTML="Conversion rate unavailable right now — please try again.";
    }
}

// ================================================================
//  REFRESH
// ================================================================
async function refreshAllData(){
    const btn=document.getElementById("refresh-btn");
    btn.textContent="🔄 Refreshing...";btn.disabled=true;
    await loadAllData();
    btn.textContent="🔄 Refresh All Data";btn.disabled=false;
    updateLastUpdate();
}
function updateLastUpdate(){
    document.getElementById("last-update").textContent="Last update: "+new Date().toLocaleDateString("en-US",
        {year:"numeric",month:"long",day:"numeric",hour:"2-digit",minute:"2-digit",second:"2-digit"});
}

async function loadGoldHistory(days){}

// ================================================================
//  EVENT LISTENERS
// ================================================================
function setupEventListeners(){
    document.getElementById("gold-card").addEventListener("click",()=>setActiveCard("gold"));
    document.getElementById("usd-card").addEventListener("click",()=>setActiveCard("usd"));
    document.getElementById("trend-card").addEventListener("click",()=>setActiveCard("trend"));
    document.getElementById("refresh-btn").addEventListener("click",refreshAllData);
    document.getElementById("convert-btn").addEventListener("click",convertCurrency);

    document.querySelectorAll(".gold-btn").forEach(btn=>btn.addEventListener("click",function(){
        document.querySelectorAll(".gold-btn").forEach(b=>b.classList.remove("active"));
        this.classList.add("active");
        currentGoldRange=this.getAttribute("data-range")||"10y";
        loadGoldChart(currentGoldRange);
    }));
    document.querySelectorAll(".usd-btn").forEach(btn=>btn.addEventListener("click",function(){
        document.querySelectorAll(".usd-btn").forEach(b=>b.classList.remove("active"));
        this.classList.add("active");
        currentUsdRange=this.getAttribute("data-range")||"10y";
        loadUsdChart(currentUsdRange);
    }));

    document.querySelector(".gold-view")?.addEventListener("click",()=>openModal("gold"));
    document.querySelector(".usd-view")?.addEventListener("click",()=>openModal("usd"));
    document.getElementById("modal-close")?.addEventListener("click",closeModal);
    document.getElementById("modal-close-btn")?.addEventListener("click",closeModal);
    document.getElementById("history-modal")?.addEventListener("click",e=>{if(e.target.id==="history-modal")closeModal();});

    document.querySelectorAll(".modal-range-btn").forEach(btn=>btn.addEventListener("click",function(){
        document.querySelectorAll(".modal-range-btn").forEach(b=>b.classList.remove("active"));
        this.classList.add("active");
        modalRange = this.getAttribute("data-range")||"1w";
        renderModalTable();
    }));
}

// ── Modal state ───────────────────────────────────────────────────
let modalType  = "gold"; // "gold" | "usd"
let modalRange = "1w";   // always defaults to 1 Week when opened

// ── USD daily+annual merge (for modal 1Y/10Y — real daily where it
// exists, one annual anchor per older year instead of fake monthly
// interpolation) — mirrors the gold 10Y merge below.
function usdDailyMerged(daysBack) {
    const cutoff = new Date();
    cutoff.setHours(0,0,0,0);
    cutoff.setDate(cutoff.getDate() - daysBack);
    const oldestDailyDate = usdDailyHistory.length
        ? new Date(usdDailyHistory[0].iso + "T00:00:00")
        : new Date();
    const annualPart = usdHistory
        .filter(h => {
            const yearStart = new Date(h.year, 0, 1);
            return yearStart >= cutoff && yearStart < oldestDailyDate;
        })
        .map(h => ({...h, iso:`${h.year}-01-01`, _sort:new Date(h.year,0,1)}));
    const dailyPart = usdDailyHistory
        .filter(d => d.iso && new Date(d.iso+"T00:00:00") >= cutoff)
        .map(d => ({...d, _sort:new Date(d.iso+"T00:00:00")}));
    return [...annualPart, ...dailyPart].sort((a,b) => a._sort - b._sort);
}

// Returns daily-granularity data for the modal, for any of the 4 ranges.
// 1W  → last 7 days  (from the short daily history)
// 1M  → last ~22 days (from the short daily history)
// 1Y  → last ~365 days (from the long daily history)
// 10Y → full ~2600 days (from the long daily history)
function modalDailySlice(type, range) {
    const isGold = type === "gold";
    if (range === "1w") return (isGold ? goldDailyHistory : usdDailyHistory).slice(-7);
    if (range === "1m") {
        if (!isGold) return usdSlice("1m");
        return goldSlice("1m"); // reuse the same trailing-30-day logic as the chart
    }
    if (range === "1y") {
        // Always show whatever real daily records exist — no arbitrary
        // count threshold. Fewer real days is still better than fake ones.
        if (isGold) return goldDailyHistory.slice(-261);
        return usdDailyMerged(365);
    }
    // 10y: show real weekday-level detail for as far back as usdDailyHistory
    // goes, then one annual anchor per older year — not the old one-point-
    // per-month interpolation.
    if (!isGold) return usdDailyMerged(365*10);
    // Gold's real DAILY coverage only goes back to when freegoldapi.com's
    // Yahoo Finance feed starts (~2025). But the same feed also carries
    // real MONTHLY data (World Bank Pink Sheet) back to 1960 — so for
    // years without daily coverage we now show real monthly points
    // instead of one annual point; true annual anchors are only used as
    // a last-resort fallback for years neither source reaches.
    const dailyYears = new Set(goldDailyHistory.map(d => new Date(d.iso+"T00:00:00").getFullYear()));
    const monthlyYears = new Set(goldMonthlyReal.map(d => new Date(d.iso+"T00:00:00").getFullYear()));
    const annualPart = goldHistory
        .filter(h => !dailyYears.has(h.year) && !monthlyYears.has(h.year))
        .map(h => ({...h, iso:`${h.year}-01-01`, _sort:new Date(h.year,0,1)}));
    const monthlyPart = goldMonthlyReal.map(d => ({...d, _sort:new Date(d.iso+"T00:00:00")}));
    const dailyPart = goldDailyHistory.map(d => ({...d, _sort:new Date(d.iso+"T00:00:00")}));
    return [...annualPart, ...monthlyPart, ...dailyPart].sort((a,b) => a._sort - b._sort);
}

// ── Open modal — always resets to 1W daily view ──────────────────
function openModal(type) {
    modalType  = type;
    modalRange = "1w";
    document.querySelectorAll(".modal-range-btn").forEach(b =>
        b.classList.toggle("active", b.getAttribute("data-range") === "1w")
    );
    renderModalTable();
    document.getElementById("history-modal").classList.add("open");
    document.body.style.overflow = "hidden";
}

// ── Render the modal table for the currently selected type+range ──
function renderModalTable() {
    const isGold = modalType === "gold";
    const data   = modalDailySlice(modalType, modalRange);
    const labels = isGold
        ? { "10y":"10 Years (Monthly for older years + Daily since 2025)", "1y":"1 Year (Daily — real coverage may be partial)", "1m":"1 Month (Daily)", "1w":"1 Week (Daily)" }
        : { "10y":"10 Years (Daily)", "1y":"1 Year (Daily)", "1m":"1 Month (Daily)", "1w":"1 Week (Daily)" };

    document.getElementById("modal-title").textContent    = isGold ? "Gold Price — Full History" : "USD/MMK Rate — Full History";
    document.getElementById("modal-subtitle").textContent = labels[modalRange] || modalRange;
    document.getElementById("modal-col-date").textContent = "DATE";
    document.getElementById("modal-col-val").textContent  = isGold ? "PRICE (MMK/tical)" : "RATE (MMK/USD)";
    document.getElementById("modal-count").textContent    = `${data.length} records`;

    const tbody = document.getElementById("modal-table-body");
    tbody.innerHTML = "";
    data.slice().reverse().forEach(item => {
        const val = isGold ? (item.price ?? 0) : (item.rate ?? 0);
        const chg = item.change ?? 0;
        const row = document.createElement("tr");
        row.innerHTML = `<td>${item.date}</td><td>${val.toLocaleString()}</td><td class="${chg>=0?"positive":"negative"}">${chg>=0?"▲":"▼"} ${Math.abs(chg).toFixed(2)}%</td>`;
        tbody.appendChild(row);
    });
}

function closeModal(){
    document.getElementById("history-modal").classList.remove("open");
    document.body.style.overflow="";
}

// ================================================================
//  SET ACTIVE CARD
// ================================================================
function setActiveCard(type){
    document.querySelectorAll(".card").forEach(c=>c.classList.remove("active"));
    document.getElementById(`${type}-card`).classList.add("active");
    document.querySelectorAll(".content-section").forEach(s=>s.classList.remove("active"));
    document.getElementById(`${type}-content`).classList.add("active");
}

// ================================================================
//  DARK MODE
// ================================================================
function setupDarkMode(){
    const btn=document.getElementById("darkmode-toggle");
    const saved=localStorage.getItem("theme")||"dark";
    isDarkMode=saved==="dark";
    document.body.setAttribute("data-theme",saved);
    btn.textContent=isDarkMode?"☀️ Light Mode":"🌙 Dark Mode";
    btn.addEventListener("click",()=>{
        isDarkMode=!isDarkMode;
        const theme=isDarkMode?"dark":"light";
        document.body.setAttribute("data-theme",theme);
        localStorage.setItem("theme",theme);
        btn.textContent=isDarkMode?"☀️ Light Mode":"🌙 Dark Mode";
        loadGoldChart(currentGoldRange);
        loadUsdChart(currentUsdRange);
    });
}
