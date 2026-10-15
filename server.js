const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;
const BUILD_ID = 'friendly-v20'; // Shown at the bottom-right of the page to confirm the running server is the latest file
app.use(express.static(path.join(__dirname, 'public')));

// Ranked detection must go through this function only.
// Only boolean true counts as Ranked (the string "false", 1, undefined, etc. are all Casual).
function isRankedFlag(value) {
  return value === true;
}

// Whether Casual matches also change MMR.
//   false (default): Casual changes trophies only; MMR / win streak are Ranked-only.
//   true: Casual changes MMR / streak the same way Ranked does.
const CASUAL_MMR_ENABLED = false;

// ============================================================
// Trophies are Casual-only.
//   - Ranked matches never change trophies (they only change MMR / streak).
//   - Friendly (custom room) matches never change trophies, MMR, streak or Casual win count.
//   - Win: +10 trophies (including an opponent forfeit) / Loss: 0 / Draw: 0
//   - Leaving a match counts as a loss -> 0.
//   - Same-account matches (invalidated) change nothing.
// ============================================================
const CASUAL_WIN_TROPHIES = 10;
const CASUAL_LOSE_TROPHIES = 0;

// result: 'win' | 'lose' | 'draw'
function getCasualTrophyChange(result) {
  if (result === 'win') return CASUAL_WIN_TROPHIES;
  if (result === 'lose') return CASUAL_LOSE_TROPHIES;
  return 0;
}

// ============================================================
// Ranked MMR rules (fixed points + gentle win-streak bonus)
//   - Start MMR 100, minimum 0.
//   - Win:  opponent forfeit / margin < 10 -> +15
//           margin 10..59 -> +25
//           margin >= 60 -> +30
//   - Loss: forfeit / margin < 10 -> -10
//           margin 10..59 -> -20
//           margin >= 60 -> -25
//   - Streak bonus: 1-2 wins +0 / from 3 wins +2 per extra win / capped at +16 (10+ wins)
//   - A loss (or forfeit) resets the streak to 0. A draw changes nothing.
//   "Margin" = difference of the two players' netCorrect.
// ============================================================
const MMR_START = 100;
const MMR_MIN = 0;

const MMR_WIN_REDUCED = 15;
const MMR_WIN_BASE = 25;
const MMR_WIN_DOMINANT = 30;
const MMR_LOSE_REDUCED = -10;
const MMR_LOSE_BASE = -20;
const MMR_LOSE_HEAVY = -25;

const MMR_CLOSE_MARGIN = 10;
const MMR_DOMINANT_MARGIN = 60;

const STREAK_BONUS_START = 3;
const STREAK_BONUS_STEP = 2;
const STREAK_BONUS_MAX = 16;

function getStreakBonus(streak) {
  if (!Number.isFinite(streak) || streak < STREAK_BONUS_START) return 0;
  return Math.min(STREAK_BONUS_MAX, (streak - STREAK_BONUS_START + 1) * STREAK_BONUS_STEP);
}

function getWinBase(scoreMargin, isNoContest) {
  if (isNoContest) return MMR_WIN_REDUCED;
  if (scoreMargin >= MMR_DOMINANT_MARGIN) return MMR_WIN_DOMINANT;
  if (scoreMargin < MMR_CLOSE_MARGIN) return MMR_WIN_REDUCED;
  return MMR_WIN_BASE;
}

function getLoseBase(scoreMargin, isNoContest) {
  if (isNoContest) return MMR_LOSE_REDUCED;
  if (scoreMargin >= MMR_DOMINANT_MARGIN) return MMR_LOSE_HEAVY;
  if (scoreMargin < MMR_CLOSE_MARGIN) return MMR_LOSE_REDUCED;
  return MMR_LOSE_BASE;
}

// Pure function: computes the final MMR / streak change for one match.
function calculateRankedMmr({ winnerRating, loserRating, winnerPrevStreak, scoreMargin, isNoContest }) {
  const winnerNewStreak = (Number.isFinite(winnerPrevStreak) ? winnerPrevStreak : 0) + 1;
  const winBase = getWinBase(scoreMargin, isNoContest);
  const streakBonus = getStreakBonus(winnerNewStreak);
  const loseBase = getLoseBase(scoreMargin, isNoContest);

  return {
    winner: {
      baseChange: winBase,
      streakBonus,
      newStreak: winnerNewStreak,
      newRating: Math.max(MMR_MIN, winnerRating + winBase + streakBonus)
    },
    loser: {
      baseChange: loseBase,
      newStreak: 0,
      newRating: Math.max(MMR_MIN, loserRating + loseBase)
    }
  };
}

// --- Season / Trophy Reset System ---
const SEASON_SOFT_RESET_RATIO = 0.5;
const SEASON_SOFT_RESET_FLOOR = 0;
const seasonState = {
  lastMmrResetMonth: null,
  lastTrophyResetMonth: null
};

const accountPreResetRatings = {};
const accountMonthlyTrophies = {};

function getCurrentMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function softResetMMR(mmr) {
  return Math.round(mmr * SEASON_SOFT_RESET_RATIO + SEASON_SOFT_RESET_FLOOR);
}

function runSeasonResets() {
  const currentMonth = getCurrentMonth();

  if (seasonState.lastMmrResetMonth !== currentMonth) {
    for (const [id, rating] of Object.entries(userRatings)) {
      const sock = io.sockets.sockets.get(id);
      const playerId = sock && sock.data ? sock.data.playerId : null;
      if (playerId) {
        accountPreResetRatings[playerId] = rating;
      }
      userRatings[id] = softResetMMR(rating);
      if (playerId) {
        accountRatings[playerId] = userRatings[id];
      }
    }
    seasonState.lastMmrResetMonth = currentMonth;
    console.log(`[Season] MMR soft reset applied for month ${currentMonth}`);
  }

  if (seasonState.lastTrophyResetMonth !== currentMonth) {
    for (const [id] of Object.entries(userTrophies)) {
      userTrophies[id] = 0;
    }
    for (const [pid] of Object.entries(accountTrophies)) {
      accountMonthlyTrophies[pid] = 0;
    }
    seasonState.lastTrophyResetMonth = currentMonth;
    console.log(`[Season] Trophy leaderboard reset for month ${currentMonth}`);
  }
}

// Word pool: 300 unique words. Must match WORD_POOL in index.html exactly.
const timeModeWordPool = [
  "the", "be", "to", "of", "and", "a", "in", "that", "have", "it",
  "for", "not", "on", "with", "he", "as", "you", "do", "at", "this",
  "but", "his", "by", "from", "they", "we", "say", "her", "she", "or",
  "an", "will", "my", "one", "all", "would", "there", "their", "what", "so",
  "up", "out", "if", "about", "who", "get", "which", "go", "me", "when",
  "make", "can", "like", "time", "no", "just", "him", "know", "take", "people",
  "into", "year", "your", "good", "some", "could", "them", "see", "other", "than",
  "then", "now", "look", "only", "come", "its", "over", "think", "also", "back",
  "after", "use", "two", "how", "our", "work", "first", "well", "way", "even",
  "new", "want", "because", "any", "these", "give", "day", "most", "us", "code",
  "program", "system", "run", "fast", "type", "keyboard", "match", "win", "play", "speed",
  "man", "find", "here", "thing", "tell", "many", "very", "through", "should", "call",
  "world", "school", "still", "try", "last", "ask", "need", "too", "feel", "three",
  "state", "never", "become", "between", "high", "really", "something", "another", "family", "own",
  "leave", "put", "old", "while", "mean", "keep", "student", "why", "let", "great",
  "same", "big", "group", "begin", "seem", "country", "help", "talk", "turn", "problem",
  "every", "start", "hand", "might", "show", "part", "against", "place", "such", "again",
  "few", "case", "week", "company", "where", "must", "right", "study", "book", "eye",
  "job", "word", "though", "business", "issue", "side", "kind", "four", "head", "far",
  "black", "long", "both", "little", "house", "since", "provide", "service", "around", "friend",
  "important", "father", "sit", "away", "until", "power", "hour", "game", "often", "yet",
  "line", "end", "among", "ever", "stand", "bad", "lose", "however", "member", "pay",
  "law", "meet", "car", "city", "almost", "include", "continue", "set", "later", "community",
  "much", "name", "five", "once", "white", "least", "learn", "real", "change", "team",
  "minute", "best", "several", "idea", "body", "information", "nothing", "lead", "social", "understand",
  "whether", "watch", "together", "follow", "parent", "stop", "face", "anything", "create", "public",
  "already", "speak", "others", "read", "level", "allow", "add", "office", "spend", "door",
  "health", "person", "art", "sure", "history", "within", "grow", "result", "open", "morning",
  "walk", "reason", "low", "research", "early", "food", "before", "moment", "himself", "air",
  "teacher", "force", "offer", "enough", "education", "across", "although", "remember", "foot", "second"
];

if (timeModeWordPool.length !== 300 || new Set(timeModeWordPool).size !== timeModeWordPool.length) {
  console.warn(`[WordPool] Warning: words=${timeModeWordPool.length}, unique=${new Set(timeModeWordPool).size} (expected 300 unique words)`);
}

const ALLOWED_TIME_DURATIONS = [30, 60, 120];
const DEFAULT_TIME_DURATION = 60;

// Server-driven countdown: 3 -> 2 -> 1 -> START broadcast once per second. Client clocks are not used.
const COUNTDOWN_SECONDS = 3;
const COUNTDOWN_TICK_MS = 1000;

// Casual wins required to unlock Ranked.
const RANKED_UNLOCK_WINS = 3;

// Net Chars scoring: the client sends `typed` (the full string currently on screen) with each progress event,
// and the server compares it to room.text itself. Characters typed correctly and then erased do not count.
//   false: progress without `typed` falls back to the client-sent netCorrect (legacy clients)
//   true:  progress without `typed` is ignored
const REQUIRE_TYPED_SNAPSHOT = false;

// --- Anti-Cheat ---
const ANTICHEAT_MIN_INTERVAL_MS = 20;
const ANTICHEAT_MIN_INTERVAL_STRIKE_COUNT = 5;
const ANTICHEAT_UNIFORMITY_WINDOW = 12;
const ANTICHEAT_UNIFORMITY_STDDEV_MS = 3;
const ANTICHEAT_UNIFORMITY_MEAN_MAX_MS = 90;
const ANTICHEAT_MAX_WPM = 250;
const ANTICHEAT_MAX_WPM_MIN_CHARS = 40;
const ANTICHEAT_DELTA_HISTORY_CAP = 400;

const userRatings = {};
const userStreaks = {};
const userNames = {};
const userAvatars = {};
const userNormalWins = {};
const accountNormalWins = {};
const waitingNormalPlayers = {};
const userTrophies = {};
const accountTrophies = {};
const accountRatings = {};
const accountStreaks = {};
const accountNames = {};

// ============================================================
// Persistent storage (ranks.json) / leaderboard submission validation / admin API
// ============================================================
const crypto = require('crypto');
const fs = require('fs');

const RANKS_FILE = path.join(__dirname, 'ranks.json');

// Set the ADMIN_SECRET environment variable in production. The default is for testing only.
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'admin123';
if (!process.env.ADMIN_SECRET) {
  console.warn('[Admin] Warning: ADMIN_SECRET is not set, using the default (admin123). Change it before deploying.');
}

const RANK_MAX_WPM = ANTICHEAT_MAX_WPM;
const RANK_MIN_ELAPSED_MS = 10000;
const RANK_MIN_DELTAS = 30;
const RANK_MAX_DELTAS = 5000;
const RANK_MIN_MEAN_INTERVAL_MS = ANTICHEAT_MIN_INTERVAL_MS;
const RANK_UNIFORM_STDDEV_MS = 8;
const RANK_UNIFORM_MEAN_MAX_MS = 120;
const RANK_CROSSCHECK_ENABLED = true;
const RANK_PENDING_TTL_MS = 60000;

// rankRecords[playerId] = { playerId, name, bests: { '30': {...}, '60': {...}, '120': {...} } }
const rankRecords = {};

let ranksSaveTimer = null;

function buildRanksSnapshot() {
  return {
    version: 1,
    savedAt: new Date().toISOString(),
    records: rankRecords,
    accounts: {
      ratings: accountRatings,
      trophies: accountTrophies,
      monthlyTrophies: accountMonthlyTrophies,
      normalWins: accountNormalWins,
      streaks: accountStreaks,
      names: accountNames
    },
    season: seasonState
  };
}

function saveRanksNow() {
  try {
    const tmpFile = RANKS_FILE + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(buildRanksSnapshot()));
    fs.renameSync(tmpFile, RANKS_FILE); // write to a temp file then swap, so a crash never corrupts the existing file
  } catch (err) {
    console.error('[Ranks] Save failed:', err.message);
  }
}

function scheduleRanksSave() {
  if (ranksSaveTimer) return;
  ranksSaveTimer = setTimeout(() => {
    ranksSaveTimer = null;
    saveRanksNow();
  }, 2000);
}

function loadRanks() {
  try {
    if (!fs.existsSync(RANKS_FILE)) {
      console.log('[Ranks] ranks.json not found, starting fresh.');
      return;
    }
    const data = JSON.parse(fs.readFileSync(RANKS_FILE, 'utf8'));
    const acc = data.accounts || {};
    Object.assign(rankRecords, data.records || {});
    Object.assign(accountRatings, acc.ratings || {});
    Object.assign(accountTrophies, acc.trophies || {});
    Object.assign(accountMonthlyTrophies, acc.monthlyTrophies || {});
    Object.assign(accountNormalWins, acc.normalWins || {});
    Object.assign(accountStreaks, acc.streaks || {});
    Object.assign(accountNames, acc.names || {});
    Object.assign(seasonState, data.season || {});
    console.log(`[Ranks] Loaded ranks.json: ${Object.keys(accountRatings).length} accounts, ${Object.keys(rankRecords).length} records`);
  } catch (err) {
    console.error('[Ranks] Load failed (the file may be corrupted):', err.message);
  }
}

loadRanks();
setInterval(saveRanksNow, 30000);
['SIGINT', 'SIGTERM'].forEach((sig) => {
  process.on(sig, () => { saveRanksNow(); process.exit(0); });
});

// pending: record computed by the server in endGame { wpm, grossWpm, elapsedMs, ... }
// rawDeltas: keystroke intervals (ms) sent by the client
function validateRankSubmission(pending, rawDeltas) {
  if (pending.wpm > RANK_MAX_WPM || pending.grossWpm > RANK_MAX_WPM) {
    return { ok: false, code: 'WPM_LIMIT', message: `Records above ${RANK_MAX_WPM} WPM cannot be submitted.` };
  }
  if (pending.elapsedMs < RANK_MIN_ELAPSED_MS) {
    return { ok: false, code: 'TOO_SHORT', message: 'Matches that are too short cannot be submitted to the leaderboard.' };
  }

  if (!Array.isArray(rawDeltas) || rawDeltas.length < RANK_MIN_DELTAS || rawDeltas.length > RANK_MAX_DELTAS) {
    return { ok: false, code: 'INVALID_DELTAS', message: 'Invalid keystroke data.' };
  }
  if (!rawDeltas.every((d) => Number.isFinite(d) && d >= 0 && d < 10000)) {
    return { ok: false, code: 'INVALID_DELTAS', message: 'Keystroke data contains abnormal values.' };
  }

  if (rawDeltas.length < pending.totalTyped * 0.5) {
    return { ok: false, code: 'DELTAS_MISMATCH', message: 'Keystroke data does not match the actual number of keystrokes.' };
  }

  const n = rawDeltas.length;
  const sum = rawDeltas.reduce((a, b) => a + b, 0);
  const mean = sum / n;

  if (RANK_CROSSCHECK_ENABLED && (sum < pending.elapsedMs * 0.5 || sum > pending.elapsedMs * 1.5)) {
    return { ok: false, code: 'TIME_MISMATCH', message: 'Keystroke timing does not match the match duration.' };
  }

  if (mean < RANK_MIN_MEAN_INTERVAL_MS) {
    return { ok: false, code: 'MACRO_MIN_INTERVAL', message: 'Abnormally fast input was detected.' };
  }

  const variance = rawDeltas.reduce((a, b) => a + (b - mean) * (b - mean), 0) / n;
  const stddev = Math.sqrt(variance);
  if (mean <= RANK_UNIFORM_MEAN_MAX_MS && stddev < RANK_UNIFORM_STDDEV_MS) {
    return { ok: false, code: 'MACRO_UNIFORM_TIMING', message: 'Submission rejected: keystroke intervals are too uniform.' };
  }

  return { ok: true, mean, stddev };
}

// --- Admin API ---
app.use(express.json({ limit: '10kb' }));

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// The key is read from the x-admin-secret header or body.secret.
function requireAdmin(req, res) {
  const provided = req.get('x-admin-secret') || (req.body && req.body.secret) || '';
  if (!provided || !safeEqual(provided, ADMIN_SECRET)) {
    console.warn(`[Admin] Auth failed: ${req.ip} ${req.path}`);
    res.status(401).json({ success: false, message: 'Unauthorized' });
    return false;
  }
  return true;
}

// Resets an online socket's in-memory ranking values and pushes them to the client.
function resetOnlineSocketRanking(socketId) {
  const sock = io.sockets.sockets.get(socketId);
  if (!sock) return;
  userRatings[socketId] = MMR_START;
  userStreaks[socketId] = 0;
  userTrophies[socketId] = 0;
  userNormalWins[socketId] = 0;
  sock.data.pendingRank = null;
  sendInitUser(sock);
  sock.emit('unlockStatus', unlockPayload(sock));
  sock.emit('trophyUpdate', { trophies: 0 });
}

// POST /api/admin/reset - reset all rankings
app.post('/api/admin/reset', (req, res) => {
  if (!requireAdmin(req, res)) return;

  [rankRecords, accountRatings, accountTrophies, accountMonthlyTrophies, accountNormalWins, accountStreaks, accountPreResetRatings]
    .forEach((obj) => { Object.keys(obj).forEach((k) => delete obj[k]); });
  for (const socketId of io.sockets.sockets.keys()) resetOnlineSocketRanking(socketId);

  saveRanksNow();
  console.log('[Admin] All rankings reset');
  res.json({ success: true, message: 'All rankings reset.' });
});

// POST /api/admin/delete - delete one player's ranking data   body: { "playerId": "Player #ABC123" }
app.post('/api/admin/delete', (req, res) => {
  if (!requireAdmin(req, res)) return;

  const playerId = sanitizePlayerId(req.body && req.body.playerId);
  if (!playerId) {
    res.status(400).json({ success: false, message: 'Invalid playerId.' });
    return;
  }

  const existed = !!(rankRecords[playerId] || accountRatings[playerId] !== undefined || accountTrophies[playerId] !== undefined);
  [rankRecords, accountRatings, accountTrophies, accountMonthlyTrophies, accountNormalWins, accountStreaks, accountPreResetRatings]
    .forEach((obj) => { delete obj[playerId]; });
  if (playerIdToSocket[playerId]) resetOnlineSocketRanking(playerIdToSocket[playerId]);

  saveRanksNow();
  console.log(`[Admin] Player ranking deleted: ${playerId} (existed=${existed})`);
  res.json({ success: true, playerId, existed });
});

const ALLOWED_AVATARS = ['😀', '😎', '🤖', '🐱', '🐶', '🦊', '🐼', '🐵', '🔥', '⚡', '🎯', '🚀'];
const DEFAULT_AVATAR = ALLOWED_AVATARS[0];

// Always read ratings through this so an MMR of 0 is not treated as falsy.
function getRating(socketId) {
  return Number.isFinite(userRatings[socketId]) ? userRatings[socketId] : MMR_START;
}

function getStreak(socketId) {
  return Number.isFinite(userStreaks[socketId]) ? userStreaks[socketId] : 0;
}

// --- Anti-Abuse ---
// IP-based checks are removed for testing. Only the same playerId (account) is checked.
const playerIdToSocket = {};

function isAbusivePair(socketA, socketB) {
  if (!socketA || !socketB) return false;
  const pidA = socketA.data && socketA.data.playerId;
  const pidB = socketB.data && socketB.data.playerId;
  return !!(pidA && pidB && pidA === pidB);
}

function generatePlayerCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function generatePlayerNick(code) {
  return `Player #${code}`;
}

// Rank tag for nicknames (only players in the top 100 get a [#rank] tag)
function buildPlayerTags(playerId, topRankList) {
  if (!topRankList) return '';
  const idx = topRankList.findIndex(entry => entry.playerId === playerId);
  if (idx === -1) return '';
  const rank = idx + 1;
  if (rank <= 100) return `[#${rank}]`;
  return '';
}

function appendDynamicTag(baseNick, rankTag) {
  const base = baseNick || '';
  const coreName = base.replace(/\[[^\]]*\]\s*/g, '').trim();
  if (!coreName) return rankTag.trim();
  return `${coreName} ${rankTag}`.trim();
}

// ============================================================
// Rankings are computed per account (playerId), whether or not the account is online.
//   - One entry per playerId (deduped).
//   - Online: latest in-memory values. Offline: persisted account values.
//   - Sort: score desc, then Casual wins desc, then playerId (fully deterministic).
// ============================================================

// sortBy: 'rating' (MMR, default) | 'trophy'
function buildTopRankList(sortBy = 'rating') {
  const byAccount = new Map();

  for (const [socketId, sock] of io.sockets.sockets) {
    const playerId = sock.data && sock.data.playerId;
    if (!playerId) continue;
    byAccount.set(playerId, {
      playerId,
      rating: Number.isFinite(userRatings[socketId]) ? userRatings[socketId] : (accountRatings[playerId] ?? MMR_START),
      trophies: Number.isFinite(userTrophies[socketId]) ? userTrophies[socketId] : (accountTrophies[playerId] ?? 0),
      wins: Number.isFinite(userNormalWins[socketId]) ? userNormalWins[socketId] : (accountNormalWins[playerId] ?? 0)
    });
  }

  for (const playerId of Object.keys(accountRatings)) {
    if (byAccount.has(playerId)) continue;
    byAccount.set(playerId, {
      playerId,
      rating: accountRatings[playerId] ?? MMR_START,
      trophies: accountTrophies[playerId] ?? 0,
      wins: accountNormalWins[playerId] ?? 0
    });
  }

  const list = Array.from(byAccount.values());

  const primaryKey = sortBy === 'trophy' ? 'trophies' : 'rating';
  list.sort((a, b) => {
    if (b[primaryKey] !== a[primaryKey]) return b[primaryKey] - a[primaryKey];
    if (b.wins !== a.wins) return b.wins - a.wins;
    return a.playerId.localeCompare(b.playerId);
  });

  return list.slice(0, 100);
}

function buildRankTagForSocket(socketId) {
  const sock = io.sockets.sockets.get(socketId);
  const playerId = sock && sock.data ? sock.data.playerId : null;
  if (!playerId) return '';
  const topRankList = buildTopRankList('rating');
  return buildPlayerTags(playerId, topRankList);
}

// Returns the current global rank (1-100), or null if outside the top 100 or not identified.
function getPlayerRankInfo(socketId, sortBy = 'rating') {
  const sock = io.sockets.sockets.get(socketId);
  const playerId = sock && sock.data ? sock.data.playerId : null;
  if (!playerId) return null;
  const topRankList = buildTopRankList(sortBy);
  const idx = topRankList.findIndex(entry => entry.playerId === playerId);
  return idx === -1 ? null : idx + 1;
}

const waitingRankedPlayers = [];
const rooms = {};
const customRooms = {}; // { CODE: { mode, duration, isRanked, players: [socket] } }

// --- Rematch System ---
const REMATCH_TIMEOUT_MS = 10000;
const RECENT_MATCH_TTL_MS = 60000;
const recentMatches = {};
const pendingRematches = {};

function cleanupPendingRematch(roomId) {
  const pending = pendingRematches[roomId];
  if (pending) {
    clearTimeout(pending.timeoutId);
    delete pendingRematches[roomId];
  }
}

// --- Report System ---
const reportLogs = [];
const reportedInMatch = {};
const reportCounts = {};
const reportableMatches = {};
const REPORTABLE_MATCH_TTL_MS = 10 * 60 * 1000;
const REPORT_ALERT_THRESHOLDS = [3, 5, 10];

function registerReport(entry) {
  const c = reportCounts[entry.targetId] || (reportCounts[entry.targetId] = {
    total: 0, uniqueReporters: new Set(), byReason: {}, lastReportedAt: null
  });
  c.total += 1;
  c.uniqueReporters.add(entry.reporterId);
  c.byReason[entry.reason] = (c.byReason[entry.reason] || 0) + 1;
  c.lastReportedAt = entry.timestamp;
  return c;
}

// GET /api/admin/reports - most-reported players first (needs the x-admin-secret header)
app.get('/api/admin/reports', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const reports = Object.entries(reportCounts)
    .map(([playerId, c]) => ({
      playerId,
      name: accountNames[playerId] || playerId,
      total: c.total,
      uniqueReporters: c.uniqueReporters.size,
      byReason: c.byReason,
      lastReportedAt: c.lastReportedAt
    }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 100);
  res.json({ success: true, reports });
});

const DISCORD_REPORT_WEBHOOK = process.env.DISCORD_REPORT_WEBHOOK || '';

function sendDiscordReportWebhook(entry) {
  if (!DISCORD_REPORT_WEBHOOK) return;

  const reasonLabels = {
    cheating: 'Cheating / Auto-typer',
    inappropriate_name: 'Inappropriate Name',
    other: 'Other'
  };

  const embed = {
    title: '🚨 NEW USER REPORT',
    color: 0xff4444,
    fields: [
      { name: 'Reporter', value: `${entry.reporterName} (\`${entry.reporterId}\`)`, inline: true },
      { name: 'Target',   value: `${entry.targetName} (\`${entry.targetId}\`)`,   inline: true },
      { name: 'Reason',   value: reasonLabels[entry.reason] || entry.reason,       inline: true },
      { name: 'Room',     value: entry.roomId,                                     inline: true },
      { name: 'Time (UTC)', value: entry.timestamp,                                inline: true }
    ],
    footer: { text: 'Typing Multiplayer — Report System' },
    timestamp: entry.timestamp
  };

  fetch(DISCORD_REPORT_WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ embeds: [embed] })
  })
    .then((res) => {
      if (!res.ok) console.error(`[Discord] Webhook failed: ${res.status} ${res.statusText}`);
      else console.log('[Discord] Report webhook sent successfully.');
    })
    .catch((err) => console.error('[Discord] Webhook error:', err.message));
}

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

const TIERS = [
  { min: 1600, label: 'Challenger', color: '#f97316', icon: '🔥' },
  { min: 1300, label: 'Master', color: '#a855f7', icon: '👑' },
  { min: 1000, label: 'Diamond', color: '#38bdf8', icon: '💎' },
  { min: 750, label: 'Platinum', color: '#14b8a6', icon: '💠' },
  { min: 500, label: 'Gold', color: '#e2b714', icon: '🥇' },
  { min: 300, label: 'Silver', color: '#c0c0c0', icon: '🥈' },
  { min: 150, label: 'Bronze', color: '#cd7f32', icon: '🥉' },
  { min: -Infinity, label: 'Iron', color: '#8b8f98', icon: '⛓️' }
];

function getTierInfo(rating) {
  const safeRating = Number.isFinite(rating) ? rating : MMR_START;
  return TIERS.find((t) => safeRating >= t.min) || TIERS[TIERS.length - 1];
}

function timeModeWordCount(duration) {
  return Math.max(200, Math.ceil(duration * 6));
}

function isEasyTransition(prevWord, nextWord) {
  if (!prevWord) return false;
  if (prevWord === nextWord) return true;
  if (prevWord.length <= 3 && nextWord.length <= 3) return true;
  if (prevWord[prevWord.length - 1] === nextWord[0]) return true;
  return false;
}

function pickNextWord(pool, prevWord) {
  const candidates = pool.filter(w => !isEasyTransition(prevWord, w));
  const source = candidates.length > 0 ? candidates : pool;
  return source[Math.floor(Math.random() * source.length)];
}

// Both match text and practice text are drawn at random from the 300-word pool.
function generateRandomText(targetWordCount) {
  const words = [];
  let prevWord = null;
  for (let i = 0; i < targetWordCount; i++) {
    const word = pickNextWord(timeModeWordPool, prevWord);
    words.push(word);
    prevWord = word;
  }
  return words.join(' ');
}

function generateUniqueText(mode, duration, previousText = '') {
  const targetCount = timeModeWordCount(duration);
  let newText = generateRandomText(targetCount);
  let attempts = 0;
  while (newText === previousText && attempts < 10) {
    newText = generateRandomText(targetCount);
    attempts++;
  }
  return newText;
}

// ============================================================
// ★ AI 봇 매칭 (일반전 대기열 전용)
// ============================================================
const BOT_WAIT_MS = 5000;           // 이 시간 동안 상대가 없으면 봇을 투입
const BOT_WPM_MIN = 55;
const BOT_WPM_MAX = 70;
const BOT_TYPO_RATE = 0.04;         // 글자당 오타(후 정정) 확률
const BOT_MATCH_REWARDS = true;     // false: 봇전은 트로피/MMR/승수/WPM랭킹 변동 없음, true: 일반전처럼 정산

function randInt(min, max) {
  return Math.floor(min + Math.random() * (max - min + 1));
}

// 봇 프로필: 실제 유저와 같은 "Player #XXXXXX" 형식의 이름 + 40~60 WPM
function createBotProfile(humanSocket) {
  let name;
  let tries = 0;
  do {
    name = `Player #${generatePlayerCode()}`;
  } while ((accountNames[name] || accountRatings[name] !== undefined) && ++tries < 10); // 실제 계정과 겹치지 않게

  return {
    id: `bot_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name,
    avatar: ALLOWED_AVATARS[randInt(0, ALLOWED_AVATARS.length - 1)],
    wpm: Math.round((BOT_WPM_MIN + Math.random() * (BOT_WPM_MAX - BOT_WPM_MIN)) * 10) / 10,
    rating: Math.max(0, getRating(humanSocket.id) + randInt(-30, 30)),
    trophies: Math.max(0, (userTrophies[humanSocket.id] || 0) + randInt(-20, 20)),
    timer: null
  };
}

// startMatch가 playerB로 받아도 에러가 나지 않도록, 소켓처럼 행동하는 가짜 객체
function createBotSocket(profile) {
  return {
    id: profile.id,
    connected: true,
    isBot: true,
    data: { playerId: null, lastText: '', roomId: null },
    join() {}, leave() {}, emit() {}
  };
}

// --- 대기 5초 타이머 ---
function clearBotWait(socket) {
  if (socket && socket.data && socket.data.botWaitTimer) {
    clearTimeout(socket.data.botWaitTimer);
    socket.data.botWaitTimer = null;
  }
}

function scheduleBotMatch(socket, matchKey, mode, duration) {
  clearBotWait(socket);
  socket.data.botWaitTimer = setTimeout(() => {
    socket.data.botWaitTimer = null;
    const queue = waitingNormalPlayers[matchKey];
    if (!socket.connected || !Array.isArray(queue)) return;
    const idx = queue.indexOf(socket);
    if (idx === -1) return;                 // 그 사이 진짜 유저와 매칭됐거나 취소했다면 아무것도 안 함
    queue.splice(idx, 1);
    if (queue.length === 0) delete waitingNormalPlayers[matchKey];
    startBotMatch(socket, mode, duration);
  }, BOT_WAIT_MS);
}

// --- 봇과 방 생성 ---
function startBotMatch(humanSocket, mode, duration) {
  const profile = createBotProfile(humanSocket);
  const botSocket = createBotSocket(profile);

  // startMatch가 읽는 값들 (경기가 끝나면 cleanupBot이 지운다)
  userRatings[profile.id] = profile.rating;
  userStreaks[profile.id] = 0;
  userNames[profile.id] = profile.name;
  userAvatars[profile.id] = profile.avatar;
  userTrophies[profile.id] = profile.trophies;
  userNormalWins[profile.id] = 0;

  clearPracticeSession(humanSocket.id);
  // 보상 없음이면 친선과 동일하게 처리 (isFriendly=true), 보상 있음이면 일반전
  startMatch(humanSocket, botSocket, mode, duration, false, undefined, !BOT_MATCH_REWARDS);

  const room = rooms[humanSocket.data.roomId];
  if (!room) { cleanupBot({ bot: profile }); return; }
  room.bot = profile;                       // 이후 START 시점에 타이핑이 시작된다
}

// --- 봇 타이핑 (START 신호 직후 호출됨) ---
function startBotTyping(roomId) {
  const room = rooms[roomId];
  if (!room || !room.bot || room.ended) return;
  const bot = room.bot;
  const botPlayer = room.players[bot.id];
  const humanId = Object.keys(room.players).find((id) => id !== bot.id);
  let speedMul = 1;
  let nextDriftAt = Date.now() + 2000;

  const step = () => {
    const r = rooms[roomId];
    if (!r || r.ended || !r.bot) { bot.timer = null; return; }   // 방이 끝났으면 체인을 끊는다

    // 2~3초마다 속도를 ±15% 정도 흔든다
    if (Date.now() >= nextDriftAt) {
      speedMul = 0.85 + Math.random() * 0.3;
      nextDriftAt = Date.now() + 1500 + Math.random() * 2000;
    }

    // 글자 하나당 기본 간격 = 60000 / (WPM * 5) ms, 여기에 랜덤 흔들림
    let delay = (60000 / (bot.wpm * 5)) / speedMul * (0.7 + Math.random() * 0.6);

    if (Math.random() < BOT_TYPO_RATE) {
      // 오타 후 정정: 위치는 그대로, 시간만 쓰고 타수/오류만 올라간다
      botPlayer.totalTyped += 2;
      botPlayer.totalErrors += 1;
      delay += 150 + Math.random() * 250;
    } else {
      botPlayer.charIndex = Math.min(r.text.length, botPlayer.charIndex + 1);
      botPlayer.totalTyped += 1;
    }

    botPlayer.netCorrect = botPlayer.charIndex;     // 봇은 항상 정타 위치에만 서 있다
    botPlayer.percent = Math.min(100, Math.floor((botPlayer.charIndex / r.text.length) * 100));
    botPlayer.accuracy = botPlayer.totalTyped > 0
      ? Math.max(0, Math.round(((botPlayer.totalTyped - botPlayer.totalErrors) / botPlayer.totalTyped) * 100))
      : 100;

    // 진짜 유저의 progress 이벤트와 같은 모양으로 사람에게 보낸다
    io.to(humanId).emit('opponentProgress', {
      percent: botPlayer.percent,
      accuracy: botPlayer.accuracy,
      charIndex: botPlayer.charIndex,
      netCorrect: botPlayer.netCorrect,
      totalTyped: botPlayer.totalTyped,
      totalErrors: botPlayer.totalErrors
    });

    if (botPlayer.charIndex >= r.text.length) {     // 봇이 끝까지 쳤다면 (사실상 거의 없음)
      botPlayer.finished = true;
      botPlayer.finishTime = Date.now();
      bot.timer = null;
      endGame(roomId, bot.id);
      return;
    }
    bot.timer = setTimeout(step, delay);
  };

  bot.timer = setTimeout(step, 300 + Math.random() * 500);   // 첫 글자까지의 반응 시간
}

// --- 정리: 타이머 + 봇용 메모리 값 ---
function cleanupBot(room) {
  const bot = room && room.bot;
  if (!bot) return;
  if (bot.timer) { clearTimeout(bot.timer); bot.timer = null; }
  delete userRatings[bot.id];
  delete userStreaks[bot.id];
  delete userNames[bot.id];
  delete userAvatars[bot.id];
  delete userTrophies[bot.id];
  delete userNormalWins[bot.id];
  room.bot = null;
}

function removeFromWaitingQueues(socket) {
  clearBotWait(socket);
  delete soloPracticeSessions[socket.id];
  Object.keys(waitingNormalPlayers).forEach((k) => {
    if (!Array.isArray(waitingNormalPlayers[k])) return;
    waitingNormalPlayers[k] = waitingNormalPlayers[k].filter((s) => s !== socket);
    if (waitingNormalPlayers[k].length === 0) delete waitingNormalPlayers[k];
  });
  for (let i = waitingRankedPlayers.length - 1; i >= 0; i--) {
    if (waitingRankedPlayers[i].socket === socket) waitingRankedPlayers.splice(i, 1);
  }
}

const PRACTICE_TEXT_DURATION = 60;
const soloPracticeSessions = {};

function clearPracticeSession(socketId) {
  delete soloPracticeSessions[socketId];
}

// Validates / normalizes the playerId sent by the client.
// Accepts "Player #XXXXXX" and a bare 6-character code, and always returns "Player #XXXXXX" (uppercase).
function sanitizePlayerId(raw) {
  if (typeof raw !== 'string') return null;
  const id = raw.trim();
  const fullMatch = id.match(/^Player #([A-Z0-9]{6})$/i);
  if (fullMatch) return `Player #${fullMatch[1].toUpperCase()}`;
  if (/^[A-Z0-9]{6}$/i.test(id)) return `Player #${id.toUpperCase()}`;
  return null;
}

function getNormalWins(socket) {
  return userNormalWins[socket.id] || 0;
}

function isRankedUnlocked(socket) {
  return getNormalWins(socket) >= RANKED_UNLOCK_WINS;
}

function unlockPayload(socket) {
  const normalWins = getNormalWins(socket);
  return {
    normalWins,
    requiredWins: RANKED_UNLOCK_WINS,
    rankedUnlocked: normalWins >= RANKED_UNLOCK_WINS
  };
}

function persistNormalWins(socket) {
  if (socket.data && socket.data.playerId) {
    accountNormalWins[socket.data.playerId] = getNormalWins(socket);
    accountRatings[socket.data.playerId] = getRating(socket.id);
    const baseName = (userNames[socket.id] || '').replace(/\[[^\]]*\]\s*/g, '').trim();
    if (baseName) accountNames[socket.data.playerId] = baseName;
  }
}

function persistTrophies(socket) {
  if (socket.data && socket.data.playerId) {
    const pid = socket.data.playerId;
    const currentTrophies = userTrophies[socket.id] || 0;
    accountTrophies[pid] = currentTrophies;
    accountMonthlyTrophies[pid] = currentTrophies;
  }
}

function addNormalWin(socket) {
  if (!socket) return;
  const wasUnlocked = isRankedUnlocked(socket);
  userNormalWins[socket.id] = getNormalWins(socket) + 1;
  persistNormalWins(socket);
  const payload = unlockPayload(socket);
  payload.justUnlocked = !wasUnlocked && payload.rankedUnlocked;
  socket.emit('unlockStatus', payload);
  return payload;
}

function createEmptyPlayerState() {
  return {
    percent: 0, accuracy: 100, charIndex: 0, finished: false, finishTime: null,
    netCorrect: 0, totalTyped: 0, totalErrors: 0,
    // --- Anti-Cheat ---
    deltaHistory: [],
    fastStreak: 0,
    disqualified: false
  };
}

// Counts characters in `typed` that currently sit in the right position with the right letter.
// Characters typed correctly and then erased (Backspace) are not in `typed`, so they never count.
function countCurrentCorrectChars(typed, text) {
  const limit = Math.min(typed.length, text.length);
  let correct = 0;
  for (let i = 0; i < limit; i++) {
    if (typed[i] === text[i]) correct++;
  }
  return correct;
}

// If data.typed (string) exists, the server computes charIndex / netCorrect itself.
// Otherwise (legacy clients, only when REQUIRE_TYPED_SNAPSHOT=false) the client-sent values are used.
// totalTyped / totalErrors / accuracy are cumulative stats and come from the client.
function sanitizeStat(data, sampleText) {
  const sampleTextLength = sampleText.length;
  const accuracy = Number.isFinite(data.accuracy) ? Math.max(0, Math.min(100, data.accuracy)) : 100;
  const totalTyped = Number.isFinite(data.totalTyped) ? Math.max(0, Math.floor(data.totalTyped)) : 0;
  const totalErrors = Number.isFinite(data.totalErrors) ? Math.max(0, Math.floor(data.totalErrors)) : 0;

  if (typeof data.typed === 'string') {
    const typed = data.typed.slice(0, sampleTextLength);
    return {
      accuracy,
      charIndex: typed.length,
      netCorrect: countCurrentCorrectChars(typed, sampleText),
      totalTyped,
      totalErrors,
      hasTypedSnapshot: true
    };
  }

  const charIndex = Number.isFinite(data.charIndex)
    ? Math.max(0, Math.min(sampleTextLength, Math.floor(data.charIndex)))
    : 0;
  const netCorrect = Number.isFinite(data.netCorrect) ? Math.max(0, Math.floor(data.netCorrect)) : 0;
  return { accuracy, charIndex, netCorrect, totalTyped, totalErrors, hasTypedSnapshot: false };
}

function recordAntiCheatDeltas(player, rawDeltas) {
  if (!Array.isArray(rawDeltas)) return;
  const clean = rawDeltas
    .filter((d) => Number.isFinite(d) && d >= 0 && d < 10000)
    .slice(0, 50);

  clean.forEach((delta) => {
    player.deltaHistory.push(delta);
    if (player.deltaHistory.length > ANTICHEAT_DELTA_HISTORY_CAP) player.deltaHistory.shift();
    player.fastStreak = delta < ANTICHEAT_MIN_INTERVAL_MS ? player.fastStreak + 1 : 0;
  });
}

function detectMacroPattern(player) {
  if (player.fastStreak >= ANTICHEAT_MIN_INTERVAL_STRIKE_COUNT) {
    return 'MACRO_MIN_INTERVAL';
  }

  const window = player.deltaHistory.slice(-ANTICHEAT_UNIFORMITY_WINDOW);
  if (window.length >= ANTICHEAT_UNIFORMITY_WINDOW) {
    const mean = window.reduce((a, b) => a + b, 0) / window.length;
    if (mean <= ANTICHEAT_UNIFORMITY_MEAN_MAX_MS) {
      const variance = window.reduce((a, b) => a + (b - mean) * (b - mean), 0) / window.length;
      const stddev = Math.sqrt(variance);
      if (stddev < ANTICHEAT_UNIFORMITY_STDDEV_MS) {
        return 'MACRO_UNIFORM_TIMING';
      }
    }
  }
  return null;
}

function detectSpeedLimit(player, room) {
  if (!room.started || !Number.isFinite(room.startTime)) return null;
  if (player.totalTyped < ANTICHEAT_MAX_WPM_MIN_CHARS) return null;
  const elapsedMs = Date.now() - room.startTime;
  if (elapsedMs <= 0) return null;
  const minutes = elapsedMs / 60000;
  const wpm = (player.totalTyped / 5) / minutes;
  return wpm >= ANTICHEAT_MAX_WPM ? 'SPEED_LIMIT_EXCEEDED' : null;
}

// Disqualifies a detected cheater immediately. Reuses endGame, so the opponent is settled like a normal win
// (Friendly matches settle nothing inside endGame).
function disqualifyPlayer(roomId, cheaterId, reasonCode) {
  const room = rooms[roomId];
  if (!room || room.ended) return;
  const winnerId = Object.keys(room.players).find((id) => id !== cheaterId) || null;
  console.log(`[Anti-Cheat] Disqualified in room ${roomId}: player=${cheaterId} reason=${reasonCode}`);
  endGame(roomId, winnerId, { reason: 'cheat_detected', cheatReason: reasonCode, cheaterId });
}

// ============================================================
// Server-driven countdown
//   - Emits directly to the two player sockets only (io.to(roomId) could mix in old sockets if a code is reused).
//   - { value: 3 } -> { value: 2 } -> { value: 1 } -> { value: 'START' }, one per second.
//   - At START: room.started = true, room.startTime recorded, end timer begins.
// ============================================================
function emitToRoomPlayers(room, event, payload) {
  Object.keys(room.players).forEach((id) => {
    io.to(id).emit(event, payload);
  });
}

function stopCountdown(room) {
  if (room && room.countdownTimerId) {
    clearInterval(room.countdownTimerId);
    room.countdownTimerId = null;
  }
}

function runServerCountdown(roomId) {
  const room = rooms[roomId];
  if (!room || room.ended) return;

  let remaining = COUNTDOWN_SECONDS;
  emitToRoomPlayers(room, 'countdownTick', { value: remaining });

  room.countdownTimerId = setInterval(() => {
    const r = rooms[roomId];
    if (!r || r.ended) {
      if (r) stopCountdown(r);
      return;
    }

    remaining -= 1;

    if (remaining > 0) {
      emitToRoomPlayers(r, 'countdownTick', { value: remaining });
      return;
    }

    stopCountdown(r);
    r.started = true;
    r.startTime = Date.now();
    emitToRoomPlayers(r, 'countdownTick', { value: 'START' });

    r.endTimeoutId = setTimeout(() => endGame(roomId, undefined), r.duration * 1000);
    if (r.bot) startBotTyping(roomId);   // 카운트다운이 끝나는 순간 봇도 같이 출발
  }, COUNTDOWN_TICK_MS);
}

// isFriendly: true for friendly (custom room / friendly rematch) matches. No trophy / MMR / streak / win-count changes.
function startMatch(playerA, playerB, mode, duration, isRanked, customRoomId, isFriendly) {
  isFriendly = isFriendly === true;
  isRanked = isFriendly ? false : isRankedFlag(isRanked);

  const roomId = customRoomId || `room_${playerA.id}_${playerB.id}_${Date.now()}`;
  const prevTextA = playerA.data.lastText || '';
  const text = generateUniqueText(mode, duration, prevTextA);

  playerA.data.lastText = text;
  playerB.data.lastText = text;

  playerA.join(roomId);
  playerB.join(roomId);
  playerA.data.roomId = roomId;
  playerB.data.roomId = roomId;

  const invalidated = isAbusivePair(playerA, playerB);
  if (invalidated) console.log(`[Anti-Abuse] Same-account match created: ${roomId}`);

  rooms[roomId] = {
    mode, text, duration, isRanked,
    isFriendly,
    invalidated,
    started: false,
    startTime: null,
    countdownTimerId: null,
    endTimeoutId: null, ended: false, players: {},
    // Keep { socketId: playerId } so MMR / streak / trophies can still be saved if a socket disconnects before endGame.
    accountIds: {
      [playerA.id]: (playerA.data && playerA.data.playerId) || null,
      [playerB.id]: (playerB.data && playerB.data.playerId) || null
    }
  };
  rooms[roomId].players[playerA.id] = createEmptyPlayerState();
  rooms[roomId].players[playerB.id] = createEmptyPlayerState();

  const ratingA = getRating(playerA.id);
  const ratingB = getRating(playerB.id);
  const nameA = userNames[playerA.id];
  const nameB = userNames[playerB.id];
  const avatarA = userAvatars[playerA.id] || DEFAULT_AVATAR;
  const avatarB = userAvatars[playerB.id] || DEFAULT_AVATAR;
  const tierA = getTierInfo(ratingA);
  const tierB = getTierInfo(ratingB);
  const trophiesA = userTrophies[playerA.id] || 0;
  const trophiesB = userTrophies[playerB.id] || 0;
  // Global rank at match start (null if outside the top 100)
  const rankA = getPlayerRankInfo(playerA.id, isRanked ? 'rating' : 'trophy');
  const rankB = getPlayerRankInfo(playerB.id, isRanked ? 'rating' : 'trophy');

  // gameStart is a setup signal. The real start time comes from countdownTick 'START'.
  // Friendly matches look like Casual to clients; isFriendly is server-internal and never sent.
  const basePayload = {
    roomId,
    mode, text,
    duration: mode === 'time' ? duration : null,
    isRanked,
    isCasual: !isRanked
  };

  playerA.emit('gameStart', {
    ...basePayload,
    myName: nameA, myRating: ratingA, myTier: tierA, myAvatar: avatarA, myTrophies: trophiesA, myRank: rankA, myStreak: getStreak(playerA.id),
    opponentName: nameB, opponentRating: ratingB, opponentTier: tierB, opponentAvatar: avatarB, opponentTrophies: trophiesB, opponentRank: rankB, opponentStreak: getStreak(playerB.id)
  });
  playerB.emit('gameStart', {
    ...basePayload,
    myName: nameB, myRating: ratingB, myTier: tierB, myAvatar: avatarB, myTrophies: trophiesB, myRank: rankB, myStreak: getStreak(playerB.id),
    opponentName: nameA, opponentRating: ratingA, opponentTier: tierA, opponentAvatar: avatarA, opponentTrophies: trophiesA, opponentRank: rankA, opponentStreak: getStreak(playerA.id)
  });

  runServerCountdown(roomId);
}

function endGame(roomId, forcedWinnerId, options = {}) {
  const room = rooms[roomId];
  if (!room || room.ended) return;
  room.ended = true;
  clearTimeout(room.endTimeoutId);
  stopCountdown(room);
  const reason = options.reason || null; // 'forfeit', 'cheat_detected', etc. - passed to clients
  const cheatReason = options.cheatReason || null;
  const cheaterId = options.cheaterId || null;

  const isRankedMatch = isRankedFlag(room.isRanked);
  const isFriendlyMatch = room.isFriendly === true;
  const isCasualMatch = !isRankedMatch && !isFriendlyMatch;

  // MMR / streak apply to Ranked always, to Casual only if CASUAL_MMR_ENABLED, and never to Friendly.
  const mmrApplies = !isFriendlyMatch && (isRankedMatch || CASUAL_MMR_ENABLED);

  const ids = Object.keys(room.players);
  let winnerId = forcedWinnerId;

  if (winnerId === undefined) {
    const [id1, id2] = ids;
    const p1 = room.players[id1];
    const p2 = room.players[id2];

    // netCorrect is recomputed from the on-screen text at every progress event (not cumulative).
    const nc1 = Number.isFinite(p1.netCorrect) ? p1.netCorrect : 0;
    const nc2 = Number.isFinite(p2.netCorrect) ? p2.netCorrect : 0;

    if (nc1 !== nc2) {
      winnerId = nc1 > nc2 ? id1 : id2;
    } else {
      const bothFinished = p1.finished && p2.finished;
      const oneFinished = p1.finished || p2.finished;

      if (bothFinished) {
        if (p1.finishTime !== p2.finishTime) {
          winnerId = p1.finishTime < p2.finishTime ? id1 : id2;
        } else {
          winnerId = null;
        }
      } else if (oneFinished) {
        winnerId = p1.finished ? id1 : id2;
      } else {
        winnerId = null;
      }
    }
  }

  // --- MMR + streak settlement ---
  const ratingChanges = {};
  const mmrResults = {};
  if (mmrApplies) {
    ids.forEach((id) => {
      const cur = getRating(id);
      mmrResults[id] = { old: cur, new: cur, diff: 0, baseChange: 0, streakBonus: 0, streak: getStreak(id) };
    });

    if (!room.invalidated && winnerId !== null) {
      const loserId = ids.find((id) => id !== winnerId);

      const scoreOf = (pid) => (Number.isFinite(room.players[pid].netCorrect) ? room.players[pid].netCorrect : 0);
      const scoreMargin = Math.abs(scoreOf(winnerId) - scoreOf(loserId));
      const isNoContest = reason === 'forfeit' || reason === 'cheat_detected';

      const oldWinner = getRating(winnerId);
      const oldLoser = getRating(loserId);
      const calc = calculateRankedMmr({
        winnerRating: oldWinner,
        loserRating: oldLoser,
        winnerPrevStreak: getStreak(winnerId),
        scoreMargin,
        isNoContest
      });

      userRatings[winnerId] = calc.winner.newRating;
      userRatings[loserId] = calc.loser.newRating;
      userStreaks[winnerId] = calc.winner.newStreak;
      userStreaks[loserId] = 0;

      mmrResults[winnerId] = {
        old: oldWinner, new: calc.winner.newRating, diff: calc.winner.newRating - oldWinner,
        baseChange: calc.winner.baseChange, streakBonus: calc.winner.streakBonus, streak: calc.winner.newStreak
      };
      mmrResults[loserId] = {
        old: oldLoser, new: calc.loser.newRating, diff: calc.loser.newRating - oldLoser,
        baseChange: calc.loser.baseChange, streakBonus: 0, streak: 0
      };
    }

    ids.forEach((id) => {
      const r = mmrResults[id];
      ratingChanges[id] = { old: r.old, new: r.new, diff: r.diff };
    });
  }

  // --- Casual win count (for the Ranked unlock): Casual only ---
  let winnerUnlock = null;
  if (isCasualMatch && !room.invalidated && winnerId !== null) {
    const winnerSocket = io.sockets.sockets.get(winnerId);
    if (winnerSocket) winnerUnlock = addNormalWin(winnerSocket);
  }

  // --- Trophy settlement: Casual only. Ranked / Friendly never change trophies. ---
  const trophyChanges = {};
  ids.forEach((id) => {
    const oldTrophies = userTrophies[id] || 0;

    if (isFriendlyMatch) {
      trophyChanges[id] = { old: oldTrophies, new: oldTrophies, diff: 0 };
      return;
    }

    let change = 0;
    if (!room.invalidated && isCasualMatch) {
      const res = winnerId === null ? 'draw' : (winnerId === id ? 'win' : 'lose');
      change = getCasualTrophyChange(res);
    }
    const newTrophies = Math.max(0, oldTrophies + change);
    userTrophies[id] = newTrophies;
    trophyChanges[id] = { old: oldTrophies, new: newTrophies, diff: newTrophies - oldTrophies };

    const playerSocketForTrophy = io.sockets.sockets.get(id);
    if (playerSocketForTrophy) {
      persistTrophies(playerSocketForTrophy);
      playerSocketForTrophy.emit('trophyUpdate', { trophies: newTrophies });
    } else {
      // Even if the socket is gone (disconnect), always save to the account.
      const pid = room.accountIds && room.accountIds[id];
      if (pid) {
        accountTrophies[pid] = newTrophies;
        accountMonthlyTrophies[pid] = newTrophies;
      }
    }
  });
  if (room.invalidated) console.log(`[Anti-Abuse] Match rewards invalidated: ${roomId}`);

  // Persist MMR / streak by playerId so a player who leaves after losing still takes the MMR loss / streak reset.
  if (mmrApplies) {
    ids.forEach((id) => {
      const sock = io.sockets.sockets.get(id);
      const pid = (room.accountIds && room.accountIds[id]) || (sock && sock.data && sock.data.playerId) || null;
      if (pid) {
        accountRatings[pid] = getRating(id);
        accountStreaks[pid] = getStreak(id);
      }
    });
  }

  console.log(`[EndGame] room=${roomId} isRanked=${isRankedMatch} isFriendly=${isFriendlyMatch} invalidated=${!!room.invalidated} reason=${reason} netCorrect=${JSON.stringify(Object.fromEntries(ids.map((id) => [id, room.players[id].netCorrect])))} trophyDiffs=${JSON.stringify(Object.fromEntries(ids.map((id) => [id, trophyChanges[id] ? trophyChanges[id].diff : null])))} mmr=${mmrApplies ? JSON.stringify(Object.fromEntries(ids.map((id) => [id, { diff: mmrResults[id].diff, streak: mmrResults[id].streak, bonus: mmrResults[id].streakBonus }]))) : 'n/a'}`);

  ids.forEach((id) => {
    const oppId = ids.find((x) => x !== id);
    const playerSocket = io.sockets.sockets.get(id);
    const oppSocket = io.sockets.sockets.get(oppId);
    const oppPlayerId = oppSocket && oppSocket.data ? oppSocket.data.playerId : null;
    const mmrRes = mmrApplies ? mmrResults[id] : null;

    const tc = trophyChanges[id];
    const sentTrophyChange = isFriendlyMatch ? 0 : tc.diff;
    const sentTotalTrophies = isFriendlyMatch ? tc.old : tc.new;

    io.to(id).emit('gameOver', {
      result: winnerId === null ? 'draw' : (winnerId === id ? 'win' : 'lose'),
      myStats: room.players[id],
      opponentStats: room.players[oppId],
      ratingData: mmrRes ? (ratingChanges[id] || null) : null,
      mmrApplied: !!mmrRes,
      mmrChange: mmrRes ? mmrRes.diff : 0,
      mmrData: mmrRes ? {
        old: mmrRes.old,
        new: mmrRes.new,
        diff: mmrRes.diff,
        baseChange: mmrRes.baseChange,
        streakBonus: mmrRes.streakBonus
      } : null,
      streak: mmrRes ? mmrRes.streak : getStreak(id),
      streakBonus: mmrRes ? mmrRes.streakBonus : 0,
      trophyData: { old: tc.old, new: sentTotalTrophies, diff: sentTrophyChange },
      trophyChange: sentTrophyChange,
      totalTrophies: sentTotalTrophies,
      unlock: playerSocket ? unlockPayload(playerSocket) : null,
      justUnlocked: !!(winnerUnlock && winnerId === id && winnerUnlock.justUnlocked),
      invalidated: !!room.invalidated,
      opponentId: oppPlayerId,
      opponentName: userNames[oppId] || 'Opponent',
      reason: reason,
      cheatReason: cheatReason,
      disqualified: cheaterId === id,
      roomId: roomId,
      isRanked: isRankedMatch,
      isCasual: !isRankedMatch,
      showRecord: true
    });
  });

  // Leaderboard submission: the server computes this match's WPM itself and stores it on the socket (single use).
  // Not eligible: Friendly, same-account, forfeit / disconnect / cheat endings, or ending before START.
  ids.forEach((id) => {
    const s = io.sockets.sockets.get(id);
    if (!s || !s.data) return;
    s.data.pendingRank = null;

    const p = room.players[id];
    const eligible = !isFriendlyMatch && !room.invalidated && !reason && room.started
      && Number.isFinite(room.startTime) && p && !p.disqualified;
    if (!eligible) return;

    const elapsedMs = Math.min(room.duration * 1000, Date.now() - room.startTime);
    if (elapsedMs <= 0) return;
    const minutes = elapsedMs / 60000;
    const netCorrect = Number.isFinite(p.netCorrect) ? p.netCorrect : 0;

    s.data.pendingRank = {
      roomId,
      duration: room.duration,
      isRanked: isRankedMatch,
      elapsedMs,
      totalTyped: p.totalTyped,
      accuracy: p.accuracy,
      wpm: Math.round(((netCorrect / 5) / minutes) * 10) / 10,
      grossWpm: Math.round(((p.totalTyped / 5) / minutes) * 10) / 10,
      createdAt: Date.now()
    };
  });
  scheduleRanksSave();

  // Clear the finished roomId from sockets so a reused room ID is never mixed up with another match.
  ids.forEach((id) => {
    const s = io.sockets.sockets.get(id);
    if (s && s.data && s.data.roomId === roomId) s.data.roomId = null;
  });

  // Keep the matchup briefly for rematch requests (only if both are still connected).
  if (ids.every((id) => { const s = io.sockets.sockets.get(id); return s && s.connected; })) {
    recentMatches[roomId] = { playerIds: ids.slice(), mode: room.mode, duration: room.duration, isRanked: isRankedMatch, isFriendly: isFriendlyMatch };
    setTimeout(() => { delete recentMatches[roomId]; }, RECENT_MATCH_TTL_MS);
  }

  // Register participants as reportable for 10 minutes (Friendly matches cannot be reported).
  // The report target is decided here by the server (the opponent account), never by the client.
  {
    const players = {};
    ids.forEach((id) => {
      const pid = room.accountIds && room.accountIds[id];
      if (pid) players[pid] = (userNames[id] || pid).replace(/\[[^\]]*\]\s*/g, '').trim();
    });
    if (!isFriendlyMatch) {
      reportableMatches[roomId] = { players };
      setTimeout(() => { delete reportableMatches[roomId]; delete reportedInMatch[roomId]; }, REPORTABLE_MATCH_TTL_MS);
    }
  }

  cleanupBot(room);   // 봇 타이머 + 봇용 메모리 정리 (결과 전송이 다 끝난 뒤에 해야 상대 이름이 나간다)
  delete rooms[roomId];
}

function sendInitUser(socket) {
  const rankTag = buildRankTagForSocket(socket.id);
  const baseName = (userNames[socket.id] || '').replace(/\[[^\]]*\]\s*/g, '').trim();
  userNames[socket.id] = appendDynamicTag(baseName, rankTag);
  socket.emit('initUser', {
    playerId: socket.data.playerId || null,
    rating: getRating(socket.id),
    streak: getStreak(socket.id),
    trophies: userTrophies[socket.id],
    name: userNames[socket.id],
    avatar: userAvatars[socket.id],
    allowedAvatars: ALLOWED_AVATARS,
    build: BUILD_ID,
    ...unlockPayload(socket),
    rankTag: rankTag
  });
}

io.on('connection', (socket) => {
  runSeasonResets();

  userRatings[socket.id] = Number.isFinite(userRatings[socket.id]) ? userRatings[socket.id] : MMR_START;
  userStreaks[socket.id] = getStreak(socket.id);
  userAvatars[socket.id] = userAvatars[socket.id] || DEFAULT_AVATAR;
  userNormalWins[socket.id] = userNormalWins[socket.id] || 0;
  userTrophies[socket.id] = userTrophies[socket.id] || 0;

  userNames[socket.id] = userNames[socket.id] || 'Connecting...';

  sendInitUser(socket);

  // The client sends its playerId to restore account data. If missing / invalid, the server issues a new one.
  socket.on('identify', (data) => {
    data = data || {};
    let playerId = sanitizePlayerId(data.playerId);

    if (!playerId) {
      playerId = generatePlayerNick(generatePlayerCode());
    }
    socket.data.playerId = playerId;

    // Block duplicate logins: kick the earlier session.
    const existingSocketId = playerIdToSocket[playerId];
    if (existingSocketId && existingSocketId !== socket.id) {
      const existingSocket = io.sockets.sockets.get(existingSocketId);
      if (existingSocket && existingSocket.connected) {
        existingSocket.emit('sessionReplaced');
        setTimeout(() => { try { existingSocket.disconnect(true); } catch (e) {} }, 100);
        console.log(`[Anti-Abuse] Duplicate session kicked: ${playerId}`);
      }
    }
    playerIdToSocket[playerId] = socket.id;

    userNormalWins[socket.id] = accountNormalWins[playerId] || 0;
    userRatings[socket.id] = Number.isFinite(accountRatings[playerId]) ? accountRatings[playerId] : getRating(socket.id);
    userStreaks[socket.id] = Number.isFinite(accountStreaks[playerId]) ? accountStreaks[playerId] : 0;
    userTrophies[socket.id] = accountTrophies[playerId] || 0;

    if (accountNames[playerId]) {
      userNames[socket.id] = accountNames[playerId];
    } else {
      const nick = /^Player #/i.test(playerId) ? playerId : generatePlayerNick(playerId);
      accountNames[playerId] = nick;
      userNames[socket.id] = nick;
    }

    sendInitUser(socket);
    socket.emit('unlockStatus', unlockPayload(socket));
    socket.emit('trophyUpdate', { trophies: userTrophies[socket.id] });
  });

  socket.on('selectMode', (data) => {
    data = data || {};
    removeFromWaitingQueues(socket);

    const isRanked = isRankedFlag(data.isRanked);
    const mode = 'time';
    const duration = ALLOWED_TIME_DURATIONS.includes(data.duration) ? data.duration : DEFAULT_TIME_DURATION;

    if (isRanked && !isRankedUnlocked(socket)) {
      socket.emit('rankedLocked', unlockPayload(socket));
      return;
    }

    if (isRanked) {
      const myRating = getRating(socket.id);
      const candidates = waitingRankedPlayers.filter(
        p => p.socket.id !== socket.id && p.mode === mode && p.duration === duration && p.socket.connected && !isAbusivePair(p.socket, socket)
      );

      if (candidates.length > 0) {
        candidates.sort((a, b) => Math.abs(a.rating - myRating) - Math.abs(b.rating - myRating));
        const bestMatch = candidates[0];
        const idx = waitingRankedPlayers.indexOf(bestMatch);
        if (idx > -1) waitingRankedPlayers.splice(idx, 1);

        startMatch(bestMatch.socket, socket, mode, duration, true);
        clearPracticeSession(socket.id);
        clearPracticeSession(bestMatch.socket.id);
      } else {
        waitingRankedPlayers.push({ socket, rating: myRating, mode, duration });
        socket.emit('waiting', { isRanked: true });
      }
    } else {
      const matchKey = `time_${duration}`;
      const queue = Array.isArray(waitingNormalPlayers[matchKey])
        ? waitingNormalPlayers[matchKey]
        : (waitingNormalPlayers[matchKey] = []);

      for (let i = queue.length - 1; i >= 0; i--) {
        if (!queue[i].connected) queue.splice(i, 1);
      }

      const oppIdx = queue.findIndex(
        (s) => s.connected && s.id !== socket.id && !isAbusivePair(s, socket)
      );

      if (oppIdx > -1) {
        const [opponent] = queue.splice(oppIdx, 1);
        clearBotWait(opponent);
        startMatch(opponent, socket, mode, duration, false);
        clearPracticeSession(socket.id);
        clearPracticeSession(opponent.id);
      } else {
        queue.push(socket);
        socket.emit('waiting', { isRanked: false });
        scheduleBotMatch(socket, matchKey, mode, duration);
      }
    }
  });

  socket.on('cancelSearch', () => {
    removeFromWaitingQueues(socket);
    socket.emit('matchmakingCancelled');
  });

  socket.on('progress', (data) => {
    const room = rooms[socket.data.roomId];
    if (!room || room.ended) return;
    // Ignore input before the START signal.
    if (!room.started) return;
    const player = room.players[socket.id];
    if (!player || player.finished || player.disqualified) return;

    const stat = sanitizeStat(data || {}, room.text);
    if (REQUIRE_TYPED_SNAPSHOT && !stat.hasTypedSnapshot) return;

    const { accuracy, charIndex, netCorrect, totalTyped, totalErrors } = stat;

    // percent is recomputed on the server from charIndex.
    const percent = room.text.length > 0
      ? Math.min(100, Math.floor((charIndex / room.text.length) * 100))
      : 0;

    player.percent = percent;
    player.charIndex = charIndex;
    player.netCorrect = netCorrect;
    player.totalTyped = totalTyped;
    player.totalErrors = totalErrors;
    player.accuracy = totalTyped > 0
      ? Math.max(0, Math.round(((totalTyped - totalErrors) / totalTyped) * 100))
      : 100;

    // --- Anti-Cheat ---
    recordAntiCheatDeltas(player, (data && data.deltas) || []);
    const cheatReason = detectMacroPattern(player) || detectSpeedLimit(player, room);
    if (cheatReason) {
      player.disqualified = true;
      disqualifyPlayer(socket.data.roomId, socket.id, cheatReason);
      return;
    }

    // Finishing 100% ends the match automatically.
    if (percent >= 100 && !player.finished) {
      player.finished = true;
      player.finishTime = Date.now();
      socket.to(socket.data.roomId).emit('opponentProgress', {
        percent: player.percent, accuracy: player.accuracy,
        charIndex: player.charIndex,
        netCorrect: player.netCorrect, totalTyped: player.totalTyped, totalErrors: player.totalErrors
      });
      endGame(socket.data.roomId, socket.id);
      return;
    }

    socket.to(socket.data.roomId).emit('opponentProgress', {
      percent: player.percent, accuracy: player.accuracy,
      charIndex: player.charIndex,
      netCorrect: player.netCorrect, totalTyped: player.totalTyped, totalErrors: player.totalErrors
    });
  });

  socket.on('createRoom', (data) => {
    data = data || {};
    const mode = 'time';
    const duration = ALLOWED_TIME_DURATIONS.includes(data.duration) ? data.duration : DEFAULT_TIME_DURATION;
    let code;
    do { code = generateRoomCode(); } while (customRooms[code]);
    // Custom rooms are always friendly. isRanked from the client is ignored.
    customRooms[code] = { mode, duration, isRanked: false, players: [socket] };
    socket.join(code);
    socket.data.customRoomCode = code;
    socket.emit('roomCreated', { code, mode, duration });
  });

  socket.on('joinRoom', (data) => {
    data = data || {};
    const code = (data.code || '').toUpperCase().trim();
    if (!code || !customRooms[code]) {
      socket.emit('roomError', { message: 'Invalid room code.' });
      return;
    }
    const room = customRooms[code];
    if (room.players.length >= 2) {
      socket.emit('roomError', { message: 'Room is full.' });
      return;
    }
    const hostSocket = room.players[0];
    if (hostSocket && hostSocket.data.playerId && hostSocket.data.playerId === socket.data.playerId) {
      socket.emit('roomError', { message: 'You cannot join your own room.' });
      return;
    }
    room.players.push(socket);
    socket.join(code);
    socket.data.customRoomCode = code;
    socket.emit('roomJoined', { code });
    room.players[0].emit('roomOpponentJoined');

    // Custom rooms use the same server-driven countdown. Only a screen-switch signal is sent here,
    // and the match starts immediately (otherwise the countdown would run twice).
    io.to(code).emit('customRoomCountdown', { seconds: COUNTDOWN_SECONDS });

    const [host, guest] = customRooms[code].players;
    delete customRooms[code];
    // Use a unique roomId per match so a reused room code never mixes with old sockets / rematches / reports.
    const friendlyRoomId = `friendly_${code}_${Date.now()}`;
    host.leave(code);
    guest.leave(code);
    host.data.customRoomCode = null;
    guest.data.customRoomCode = null;
    // Custom rooms are friendly matches: isRanked=false, isFriendly=true
    startMatch(host, guest, room.mode, room.duration, false, friendlyRoomId, true);
  });

  socket.on('cancelRoom', () => {
    const code = socket.data.customRoomCode;
    if (code && customRooms[code]) {
      const room = customRooms[code];
      room.players = room.players.filter(p => p.id !== socket.id);
      if (room.players.length === 0) {
        delete customRooms[code];
      } else {
        room.players[0].emit('roomError', { message: 'Opponent left the room.' });
      }
    }
    socket.data.customRoomCode = null;
  });

  socket.on('requestLeaderboard', (data) => {
    data = data || {};
    const sortBy = data.sortBy || 'rank';

    const rankSortKind = sortBy === 'trophy' ? 'trophy' : 'rating';
    const topList = buildTopRankList(rankSortKind);

    const myId = socket.data && socket.data.playerId;
    const entries = topList.map((entry, idx) => ({
      rank: idx + 1,
      playerId: entry.playerId,
      name: accountNames[entry.playerId] || entry.playerId || 'Guest',
      avatar: DEFAULT_AVATAR,
      rating: entry.rating,
      trophies: entry.trophies,
      isMe: entry.playerId === myId
    }));

    // If my account is outside the top 100, append it separately (rank: null).
    if (myId && !entries.some((e) => e.playerId === myId)) {
      entries.push({
        rank: null,
        playerId: myId,
        name: userNames[socket.id] || 'Guest',
        avatar: userAvatars[socket.id] || DEFAULT_AVATAR,
        rating: getRating(socket.id),
        trophies: accountMonthlyTrophies[myId] || userTrophies[socket.id] || 0,
        isMe: true
      });
    }

    socket.emit('leaderboardData', { sortBy, entries: entries.slice(0, 50) });
  });

  // Report: client -> { roomId?: string, reason?: 'cheating' }
  // The target is always decided by the server as the opponent of that match.
  socket.on('reportMatch', (data) => {
    data = data || {};
    const reply = (payload) => socket.emit('reportResult', payload);
    console.log(`[Reported] Request received: socket=${socket.id} player=${socket.data && socket.data.playerId} roomId=${data.roomId}`);
    const reporterId = socket.data && socket.data.playerId;

    if (!reporterId) {
      return reply({ success: false, code: 'NOT_IDENTIFIED', message: 'Unable to verify your connection.' });
    }

    // 1) Find the match: the live room if in progress, otherwise reportableMatches (within 10 minutes)
    const roomId = (typeof data.roomId === 'string' && data.roomId) ? data.roomId : (socket.data.roomId || null);
    let participants = null; // { playerId: name }
    const liveRoom = roomId ? rooms[roomId] : null;
    if (liveRoom && liveRoom.bot) {
      return reply({ success: false, code: 'NO_TARGET', message: 'This match cannot be reported.' });
    }
    if (liveRoom && liveRoom.isFriendly === true) {
      return reply({ success: false, code: 'FRIENDLY_MATCH', message: 'Friendly matches cannot be reported.' });
    }
    if (liveRoom && liveRoom.accountIds) {
      participants = {};
      Object.entries(liveRoom.accountIds).forEach(([sid, pid]) => {
        if (pid) participants[pid] = (userNames[sid] || pid).replace(/\[[^\]]*\]\s*/g, '').trim();
      });
    } else if (roomId && reportableMatches[roomId]) {
      participants = reportableMatches[roomId].players;
    }

    if (!participants || !participants[reporterId]) {
      return reply({ success: false, code: 'NO_MATCH', message: 'No match available to report. (Only within 10 minutes after a match ends)' });
    }

    // 2) Target = the opponent in this match
    const targetId = Object.keys(participants).find((pid) => pid !== reporterId);
    if (!targetId) {
      return reply({ success: false, code: 'NO_TARGET', message: 'Could not find an opponent to report.' });
    }

    // 3) One report per player per match
    if (!reportedInMatch[roomId]) reportedInMatch[roomId] = new Set();
    if (reportedInMatch[roomId].has(reporterId)) {
      return reply({ success: false, code: 'ALREADY_REPORTED', message: 'You have already reported this match.', roomId });
    }
    reportedInMatch[roomId].add(reporterId);

    const reportEntry = {
      timestamp: new Date().toISOString(),
      reporterId,
      reporterName: (userNames[socket.id] || reporterId).replace(/\[[^\]]*\]\s*/g, '').trim(),
      targetId,
      targetName: participants[targetId] || targetId,
      roomId,
      reason: 'cheating'
    };

    reportLogs.push(reportEntry);
    if (reportLogs.length > 1000) reportLogs.shift();

    // 4) Aggregate + log
    const counts = registerReport(reportEntry);
    console.log(`[Reported] ${reportEntry.reporterName}(${reporterId}) -> ${reportEntry.targetName}(${targetId}) reason=cheating room=${roomId} | total ${counts.total} (unique reporters ${counts.uniqueReporters.size})`);
    if (REPORT_ALERT_THRESHOLDS.includes(counts.total)) {
      console.warn(`[Reported][ALERT] ${targetId} reached ${counts.total} total reports (unique reporters ${counts.uniqueReporters.size}) -> needs review`);
    }

    sendDiscordReportWebhook(reportEntry);

    reply({ success: true, code: 'OK', message: 'Your report has been submitted.', roomId });
  });

  // Leaderboard submission: client -> { roomId, deltas:[ms,...] }
  // Result is sent as 'rankSubmitResult': { success, code, message, isNewBest, wpm, accuracy, duration }
  socket.on('submitRank', (data) => {
    data = data || {};
    const reply = (payload) => socket.emit('rankSubmitResult', payload);
    const pid = socket.data && socket.data.playerId;
    const pending = socket.data && socket.data.pendingRank;

    if (!pid || !pending || Date.now() - pending.createdAt > RANK_PENDING_TTL_MS) {
      socket.data.pendingRank = null;
      return reply({ success: false, code: 'NO_PENDING', message: 'No match record available to submit.' });
    }
    if (data.roomId !== pending.roomId) {
      return reply({ success: false, code: 'ROOM_MISMATCH', message: 'Match information does not match.' });
    }
    socket.data.pendingRank = null; // single use

    const check = validateRankSubmission(pending, data.deltas);
    if (!check.ok) {
      console.log(`[RankSubmit] Rejected: ${pid} code=${check.code} wpm=${pending.wpm} gross=${pending.grossWpm}`);
      return reply({ success: false, code: check.code, message: check.message });
    }

    const key = String(pending.duration);
    const record = rankRecords[pid] || (rankRecords[pid] = { playerId: pid, name: '', bests: {} });
    record.name = (userNames[socket.id] || accountNames[pid] || pid).replace(/\[[^\]]*\]\s*/g, '').trim();
    const prev = record.bests[key];
    const isNewBest = !prev || pending.wpm > prev.wpm;
    if (isNewBest) {
      record.bests[key] = {
        wpm: pending.wpm,
        accuracy: pending.accuracy,
        isRanked: pending.isRanked,
        achievedAt: new Date().toISOString()
      };
      saveRanksNow();
    }

    console.log(`[RankSubmit] Accepted: ${pid} ${key}s wpm=${pending.wpm} newBest=${isNewBest}`);
    reply({
      success: true,
      isNewBest,
      wpm: pending.wpm,
      accuracy: pending.accuracy,
      duration: pending.duration,
      bestWpm: record.bests[key].wpm
    });
  });

  // WPM leaderboard query: client -> { duration: 30|60|120 }  /  response: 'wpmLeaderboardData'
  socket.on('requestWpmLeaderboard', (data) => {
    data = data || {};
    const duration = ALLOWED_TIME_DURATIONS.includes(data.duration) ? data.duration : DEFAULT_TIME_DURATION;
    const key = String(duration);
    const myId = socket.data && socket.data.playerId;

    const entries = Object.values(rankRecords)
      .filter((r) => r.bests && r.bests[key])
      .sort((a, b) => {
        if (b.bests[key].wpm !== a.bests[key].wpm) return b.bests[key].wpm - a.bests[key].wpm;
        return String(a.bests[key].achievedAt).localeCompare(String(b.bests[key].achievedAt));
      })
      .slice(0, 50)
      .map((r, i) => ({
        rank: i + 1,
        playerId: r.playerId,
        name: accountNames[r.playerId] || r.name || r.playerId,
        wpm: r.bests[key].wpm,
        accuracy: r.bests[key].accuracy,
        isMe: r.playerId === myId
      }));

    socket.emit('wpmLeaderboardData', { duration, entries });
  });

  socket.on('requestSoloPractice', () => {
    const text = generateUniqueText('practice', PRACTICE_TEXT_DURATION, socket.data.lastText || '');
    socket.data.lastText = text;
    soloPracticeSessions[socket.id] = { text };
    socket.emit('soloPracticeStart', { text });
  });

  socket.on('requestPracticeText', () => {
    const session = soloPracticeSessions[socket.id];
    if (!session) return;
    const text = generateUniqueText('practice', PRACTICE_TEXT_DURATION, session.text);
    session.text = text;
    socket.data.lastText = text;
    socket.emit('practiceText', { text });
  });

  socket.on('exitPractice', () => {
    clearPracticeSession(socket.id);
    socket.emit('practiceEnded');
  });

  socket.on('leaveMatch', () => {
    const roomId = socket.data.roomId;
    const room = rooms[roomId];
    // Ignore if this socket is not a participant of the room.
    if (!room || room.ended || !room.players[socket.id]) return;
    const remainingId = Object.keys(room.players).find((id) => id !== socket.id);
    if (!remainingId) return;
    endGame(roomId, remainingId, { reason: 'forfeit' });
  });

  // --- Rematch ---
  socket.on('requestRematch', (data) => {
    data = data || {};
    const roomId = data.roomId;
    const match = recentMatches[roomId];
    if (!match || !match.playerIds.includes(socket.id)) {
      socket.emit('rematchError', { message: 'Match no longer available for rematch.' });
      return;
    }
    const oppId = match.playerIds.find((id) => id !== socket.id);
    const oppSocket = oppId ? io.sockets.sockets.get(oppId) : null;
    if (!oppSocket || !oppSocket.connected) {
      socket.emit('rematchError', { message: 'Opponent is no longer available.' });
      cleanupPendingRematch(roomId);
      delete recentMatches[roomId];
      return;
    }

    let pending = pendingRematches[roomId];
    if (!pending) {
      pending = pendingRematches[roomId] = {
        accepted: new Set(),
        timeoutId: setTimeout(() => {
          match.playerIds.forEach((id) => {
            const s = io.sockets.sockets.get(id);
            if (s) s.emit('rematchTimeout');
          });
          cleanupPendingRematch(roomId);
          delete recentMatches[roomId];
        }, REMATCH_TIMEOUT_MS)
      };
    }

    const alreadyRequestedByOpp = pending.accepted.has(oppSocket.id);
    pending.accepted.add(socket.id);

    if (!alreadyRequestedByOpp) {
      oppSocket.emit('rematchRequested', { roomId });
    }

    if (pending.accepted.size === 2) {
      clearTimeout(pending.timeoutId);
      delete pendingRematches[roomId];
      delete recentMatches[roomId];
      const p1 = io.sockets.sockets.get(match.playerIds[0]);
      const p2 = io.sockets.sockets.get(match.playerIds[1]);
      if (p1 && p1.connected && p2 && p2.connected) {
        // A rematch inherits the previous match type (Casual / Ranked / Friendly).
        startMatch(p1, p2, match.mode, match.duration, isRankedFlag(match.isRanked), undefined, match.isFriendly === true);
      } else {
        match.playerIds.forEach((id) => {
          const s = io.sockets.sockets.get(id);
          if (s) s.emit('rematchError', { message: 'Opponent disconnected.' });
        });
      }
    }
  });

  socket.on('declineRematch', (data) => {
    data = data || {};
    const roomId = data.roomId;
    const match = recentMatches[roomId];
    if (!match || !match.playerIds.includes(socket.id)) return;
    const oppId = match.playerIds.find((id) => id !== socket.id);
    const oppSocket = oppId ? io.sockets.sockets.get(oppId) : null;
    if (oppSocket) oppSocket.emit('rematchDeclined');
    cleanupPendingRematch(roomId);
    delete recentMatches[roomId];
  });

  socket.on('disconnect', () => {
    removeFromWaitingQueues(socket);
    clearPracticeSession(socket.id);

    const myPid = socket.data.playerId;
    if (myPid && playerIdToSocket[myPid] === socket.id) delete playerIdToSocket[myPid];

    // If a rematch was pending, notify the opponent and clean up.
    for (const [rid, match] of Object.entries(recentMatches)) {
      if (match.playerIds.includes(socket.id)) {
        const oppId = match.playerIds.find((id) => id !== socket.id);
        const oppSocket = oppId ? io.sockets.sockets.get(oppId) : null;
        if (oppSocket) oppSocket.emit('rematchDeclined');
        cleanupPendingRematch(rid);
        delete recentMatches[rid];
      }
    }

    const cCode = socket.data.customRoomCode;
    if (cCode && customRooms[cCode]) {
      customRooms[cCode].players = customRooms[cCode].players.filter((p) => p.id !== socket.id);
      if (customRooms[cCode].players.length === 0) delete customRooms[cCode];
      else customRooms[cCode].players[0].emit('roomError', { message: 'Opponent left the room.' });
    }

    const roomId = socket.data.roomId;
    const room = rooms[roomId];
    // Forfeit only if this socket is actually a participant of the room.
    if (room && !room.ended && room.players[socket.id]) {
      const remainingId = Object.keys(room.players).find((id) => id !== socket.id);
      if (remainingId) {
        // Reuse endGame: Casual settles trophies / win count, Ranked settles MMR / streak, Friendly settles nothing.
        endGame(roomId, remainingId, { reason: 'forfeit' });
      } else {
        clearTimeout(room.endTimeoutId);
        stopCountdown(room);
        delete rooms[roomId];
      }
    }

    // Per-socket temporary data is already saved to the account (playerId), so remove it.
    delete userRatings[socket.id];
    delete userStreaks[socket.id];
    delete userNames[socket.id];
    delete userAvatars[socket.id];
    delete userNormalWins[socket.id];
    delete userTrophies[socket.id];
  });
});

server.listen(PORT, () => console.log(`Server running: http://localhost:${PORT} [build: ${BUILD_ID}]`));