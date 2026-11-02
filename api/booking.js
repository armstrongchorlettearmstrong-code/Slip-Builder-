// POST /api/booking  body: { legs: [{ match, prediction }] }
// Single-file version: fuzzy matching + SportyBet adapter (UNOFFICIAL, may fail) + handler.
// Fuzzy team-name matching (no dependencies): alias table + Dice coefficient.

const ALIASES = {
  "man utd": "manchester united",
  "man united": "manchester united",
  "man city": "manchester city",
  spurs: "tottenham hotspur",
  tottenham: "tottenham hotspur",
  wolves: "wolverhampton wanderers",
  "newcastle utd": "newcastle united",
  newcastle: "newcastle united",
  "west ham": "west ham united",
  "nottm forest": "nottingham forest",
  "nott forest": "nottingham forest",
  brighton: "brighton and hove albion",
  leicester: "leicester city",
  psg: "paris saint germain",
  "paris sg": "paris saint germain",
  inter: "inter milan",
  internazionale: "inter milan",
  "ac milan": "milan",
  atletico: "atletico madrid",
  "atl madrid": "atletico madrid",
  bayern: "bayern munich",
  "bayern munchen": "bayern munich",
  dortmund: "borussia dortmund",
  gladbach: "borussia monchengladbach",
  leverkusen: "bayer leverkusen",
  barca: "barcelona",
};

const STOP = new Set(["fc", "cf", "afc", "sc", "ac", "the", "club", "de"]);

function normalize(name) {
  let s = String(name || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (ALIASES[s]) s = ALIASES[s];
  s = s.split(" ").filter((w) => !STOP.has(w)).join(" ");
  return ALIASES[s] || s;
}

function bigrams(s) {
  const out = new Map();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    out.set(g, (out.get(g) || 0) + 1);
  }
  return out;
}

// Sørensen–Dice similarity, 0..1
function similarity(a, b) {
  a = normalize(a);
  b = normalize(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.9;
  const A = bigrams(a), B = bigrams(b);
  let overlap = 0;
  for (const [g, n] of A) overlap += Math.min(n, B.get(g) || 0);
  return (2 * overlap) / (Math.max(a.length - 1, 0) + Math.max(b.length - 1, 0) || 1);
}

// "Man Utd vs Arsenal" | "Man Utd v Arsenal" | "Man Utd - Arsenal"
function splitMatch(str) {
  const parts = String(str).split(/\s+(?:vs\.?|v|-|–|—)\s+/i);
  return parts.length === 2 ? { home: parts[0].trim(), away: parts[1].trim() } : null;
}

/**
 * Find the best event for a sheet match string.
 * events: [{ eventId, homeTeamName, awayTeamName, ... }]
 * Both teams must clear `threshold`; returns { event, score } or null.
 */
function findEvent(matchStr, events, threshold = 0.6) {
  const m = splitMatch(matchStr);
  if (!m) return null;
  let best = null;
  for (const ev of events) {
    const h = similarity(m.home, ev.homeTeamName);
    const a = similarity(m.away, ev.awayTeamName);
    if (h < threshold || a < threshold) continue;
    const score = (h + a) / 2;
    if (!best || score > best.score) best = { event: ev, score };
  }
  return best;
}

// SportyBet booking-code adapter.
//
// IMPORTANT: SportyBet has NO official public API. The paths and payload shapes below
// are based on the endpoints their own website calls and are UNVERIFIED. They can change
// without notice, may be geo-restricted or block datacenter IPs (Vercel), and using them
// may be against their Terms. Everything is isolated here so you can adjust one file.
// Failures never throw: they return { ok:false, reason } so the UI degrades gracefully.


const BASE = process.env.SPORTYBET_BASE || "https://www.sportybet.com";
const CC = process.env.SPORTYBET_COUNTRY || "ng";

// Football sport id + markets: 1 = 1X2, 10 = Double Chance, 18 = Over/Under
const EVENTS_PATH =
  `/api/${CC}/factsCenter/pcUpcomingEvents?sportId=sr%3Asport%3A1` +
  `&marketId=1%2C10%2C18&pageSize=100&pageNum=1&todayGames=true&timeline=`;
const SHARE_PATH = `/api/${CC}/orders/share`;

const HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json",
  "User-Agent": "Mozilla/5.0 (compatible; slip-builder/1.0)",
  operid: "2",
  platform: "web",
};

// Sheet prediction text -> SportyBet market/outcome ids (verify against live responses)
function mapPrediction(text) {
  const t = String(text).toLowerCase().replace(/\s+/g, " ").trim();
  if (["1", "home", "home win"].includes(t)) return { marketId: "1", outcomeId: "1", specifier: "" };
  if (["x", "draw"].includes(t)) return { marketId: "1", outcomeId: "2", specifier: "" };
  if (["2", "away", "away win"].includes(t)) return { marketId: "1", outcomeId: "3", specifier: "" };
  if (["1x", "home or draw", "home/draw"].includes(t)) return { marketId: "10", outcomeId: "9", specifier: "" };
  if (["12", "home or away"].includes(t)) return { marketId: "10", outcomeId: "10", specifier: "" };
  if (["x2", "draw or away", "draw/away"].includes(t)) return { marketId: "10", outcomeId: "11", specifier: "" };
  const ou = t.match(/^(over|under)\s*(\d+(?:\.\d+)?)/);
  if (ou) {
    return {
      marketId: "18",
      outcomeId: ou[1] === "over" ? "12" : "13",
      specifier: `total=${ou[2]}`,
    };
  }
  return null;
}

async function http(path, options = {}, ms = 6000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(BASE + path, { ...options, headers: HEADERS, signal: ctrl.signal });
    if (!res.ok) throw new Error(`SportyBet responded ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function flattenEvents(json) {
  const tournaments = json?.data?.tournaments || [];
  return tournaments.flatMap((t) => t.events || []);
}

/** legs: [{ match, prediction }] -> { ok, code?, url?, unmatched?, reason? } */
async function createBookingCode(legs) {
  try {
    const events = flattenEvents(await http(EVENTS_PATH));
    if (!events.length) return { ok: false, reason: "No SportyBet events returned (blocked, geo-restricted, or endpoint changed)." };

    const selections = [];
    const unmatched = [];
    for (const leg of legs) {
      const found = findEvent(leg.match, events);
      const market = mapPrediction(leg.prediction);
      if (!found || !market) {
        unmatched.push({ match: leg.match, prediction: leg.prediction, why: !found ? "match not found" : "market not supported" });
        continue;
      }
      selections.push({ eventId: found.event.eventId, ...market });
    }

    // A code with missing legs would have different odds, so refuse partial slips.
    if (unmatched.length) return { ok: false, reason: "Some selections could not be mapped.", unmatched };

    const out = await http(SHARE_PATH, { method: "POST", body: JSON.stringify({ selections }) });
    const code = out?.data?.shareCode;
    if (!code) return { ok: false, reason: "SportyBet did not return a booking code." };
    return { ok: true, code, url: out?.data?.shareURL || null };
  } catch (e) {
    return { ok: false, reason: e.name === "AbortError" ? "SportyBet request timed out." : e.message };
  }
}

// POST /api/booking  body: { legs: [{ match, prediction }] }
// Kept separate from /api/predictions so the slow external call never delays the slip itself.

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const legs = req.body?.legs;
  if (!Array.isArray(legs) || !legs.length || legs.length > 10) {
    return res.status(400).json({ error: "Provide 1-10 legs: [{ match, prediction }]" });
  }
  const clean = legs.map((l) => ({ match: String(l.match || ""), prediction: String(l.prediction || "") }));
  const result = await createBookingCode(clean);
  return res.status(result.ok ? 200 : 422).json(result);
};
