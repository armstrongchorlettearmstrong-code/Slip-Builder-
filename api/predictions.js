// GET /api/predictions?continent=Europe&league=Premier%20League&ticketType=2odds
// Single-file version: Google Sheets reader + slip generator + handler.
// Reads rows from Google Sheets (REST, no SDK = tiny cold start).
// Expected header row: Continent | League | Match | Prediction | Odds

const BASE = "https://sheets.googleapis.com/v4/spreadsheets";
const TTL_MS = (Number(process.env.CACHE_TTL_SECONDS) || 60) * 1000;
let cache = { at: 0, rows: null }; // survives between warm invocations

function parseOdds(v) {
  const n = parseFloat(String(v ?? "").replace(",", ".").trim());
  return Number.isFinite(n) && n > 1 ? n : null;
}

function parseRows(values) {
  if (!values || values.length < 2) return [];
  const header = values[0].map((h) => String(h).trim().toLowerCase());
  const idx = (name) => header.indexOf(name);
  const col = {
    continent: idx("continent"),
    league: idx("league"),
    match: idx("match"),
    prediction: idx("prediction"),
    odds: idx("odds"),
  };
  if (Object.values(col).some((i) => i === -1)) {
    throw new Error("Sheet header must be: Continent, League, Match, Prediction, Odds");
  }
  return values
    .slice(1)
    .map((r) => ({
      continent: String(r[col.continent] ?? "").trim(),
      league: String(r[col.league] ?? "").trim(),
      match: String(r[col.match] ?? "").trim(),
      prediction: String(r[col.prediction] ?? "").trim(),
      odds: parseOdds(r[col.odds]),
    }))
    .filter((r) => r.match && r.prediction && r.odds);
}

async function fetchRows() {
  if (cache.rows && Date.now() - cache.at < TTL_MS) return cache.rows;

  const { GOOGLE_API_KEY, GOOGLE_SHEET_ID, SHEET_RANGE = "Sheet1!A1:E500" } = process.env;
  if (!GOOGLE_API_KEY || !GOOGLE_SHEET_ID) {
    throw new Error("Missing GOOGLE_API_KEY or GOOGLE_SHEET_ID environment variable");
  }

  const url = `${BASE}/${GOOGLE_SHEET_ID}/values/${encodeURIComponent(SHEET_RANGE)}?key=${GOOGLE_API_KEY}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000); // stay well under the function limit
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`Google Sheets API responded ${res.status}`);
    const json = await res.json();
    cache = { at: Date.now(), rows: parseRows(json.values) };
    return cache.rows;
  } catch (e) {
    if (cache.rows) return cache.rows; // serve stale data rather than fail
    throw e.name === "AbortError" ? new Error("Google Sheets request timed out") : e;
  } finally {
    clearTimeout(timer);
  }
}

// Slip generation: bundle "safe" legs so the combined odds land in a target window.

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Generic bundler.
 * Pool = rows inside [minOdds, maxOdds], one leg per match, sorted ascending by odds.
 * Depth-first search, pruned as soon as the running product exceeds `high`.
 * Preference: fewest legs first (less risk), then closest to the window midpoint.
 */
function findSlip(rows, { minOdds, maxOdds, low, high, minLegs = 2, maxLegs = 5, poolSize = 30 }) {
  const seen = new Set();
  const pool = rows
    .filter((r) => r.odds >= minOdds && r.odds <= maxOdds)
    .filter((r) => {
      const key = r.match.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.odds - b.odds)
    .slice(0, poolSize);

  const mid = (low + high) / 2;
  let best = null;

  const better = (a, b) =>
    a.legs.length !== b.legs.length
      ? a.legs.length < b.legs.length
      : Math.abs(a.total - mid) < Math.abs(b.total - mid);

  function dfs(start, chosen, product) {
    if (chosen.length >= minLegs && product >= low && product <= high) {
      const cand = { legs: [...chosen], total: product };
      if (!best || better(cand, best)) best = cand;
    }
    if (chosen.length >= maxLegs) return;
    for (let i = start; i < pool.length; i++) {
      const next = product * pool[i].odds;
      if (next > high) break; // pool is ascending, so later odds only get bigger
      chosen.push(pool[i]);
      dfs(i + 1, chosen, next);
      chosen.pop();
    }
  }
  dfs(0, [], 1);

  if (!best) return null;
  return {
    legs: best.legs.map(({ continent, league, match, prediction, odds }) => ({
      continent, league, match, prediction, odds,
    })),
    totalOdds: round2(best.total),
    window: [low, high],
  };
}

// "2 odds" ticket: legs at 1.30-1.55, combined ~1.95-2.20
function generateTwoOddSlip(rows) {
  return findSlip(rows, { minOdds: 1.3, maxOdds: 1.55, low: 1.95, high: 2.2, minLegs: 2, maxLegs: 4 });
}

// "3 odds" ticket: legs at 1.30-1.55, combined ~2.85-3.25
function generateThreeOddSlip(rows) {
  return findSlip(rows, { minOdds: 1.3, maxOdds: 1.55, low: 2.85, high: 3.25, minLegs: 2, maxLegs: 5 });
}

// GET /api/predictions?continent=Europe&league=Premier%20League&ticketType=2odds

const eq = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();
const uniq = (arr) => [...new Set(arr.filter(Boolean))].sort((a, b) => a.localeCompare(b));

module.exports = async (req, res) => {
  try {
    const { continent = "", league = "", ticketType = "2odds" } = req.query || {};
    if (!["2odds", "3odds"].includes(ticketType)) {
      return res.status(400).json({ error: "ticketType must be '2odds' or '3odds'" });
    }

    const rows = await fetchRows();

    // Strict filtering happens BEFORE any odds math.
    const byContinent = continent && continent !== "all" ? rows.filter((r) => eq(r.continent, continent)) : rows;
    const filtered = league && league !== "all" ? byContinent.filter((r) => eq(r.league, league)) : byContinent;

    const slip = ticketType === "2odds" ? generateTwoOddSlip(filtered) : generateThreeOddSlip(filtered);

    res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=300");
    return res.status(200).json({
      ticketType,
      slip, // null when no valid combination exists
      matchesConsidered: filtered.length,
      filters: {
        continents: uniq(rows.map((r) => r.continent)),
        leagues: uniq(byContinent.map((r) => r.league)), // narrows with the continent
      },
    });
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
};
    
