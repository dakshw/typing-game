const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;
app.use(express.static(path.join(__dirname, 'public')));

function getTrophyChange(result, duration) {
  const base = result === 'win' ? 10 : result === 'lose' ? -3 : 0;
  const multiplier = duration === 30 ? 0.8 : duration === 120 ? 1.5 : 1.0;
  return Math.round(base * multiplier);
}

// --- Season / Trophy Reset System ---
const SEASON_SOFT_RESET_RATIO = 0.5;
const SEASON_SOFT_RESET_FLOOR = 500;

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
  "program", "system", "run", "fast", "type", "keyboard", "match", "win", "play", "speed"
];

const ALLOWED_TIME_DURATIONS = [30, 60, 120];
const DEFAULT_TIME_DURATION = 60;
const COUNTDOWN_MS = 3000;

const RANKED_UNLOCK_WINS = 3;
// --- Anti-Cheat: 타이핑 검증 ---
const ANTICHEAT_MIN_INTERVAL_MS = 20;          // 이 값 미만 간격이 연속되면 매크로 의심
const ANTICHEAT_MIN_INTERVAL_STRIKE_COUNT = 5;  // 연속 위반이 이 횟수 이상이면 즉시 판정
const ANTICHEAT_UNIFORMITY_WINDOW = 12;         // 정속 패턴 판정에 쓰는 최근 입력 개수
const ANTICHEAT_UNIFORMITY_STDDEV_MS = 3;       // 표준편차가 이 값 미만이면 "정밀한 정속 입력"으로 의심
const ANTICHEAT_UNIFORMITY_MEAN_MAX_MS = 90;    // 위 판정은 평균 간격도 충분히 빠를 때만 적용 (느리지만 꾸준한 사람도 있으므로)
const ANTICHEAT_MAX_WPM = 250;                  // 지속 최고 속도 제한
const ANTICHEAT_MAX_WPM_MIN_CHARS = 40;         // 이 정도 타이핑 후부터 WPM 판정 시작 (초반 표본 부족 방지)
const ANTICHEAT_DELTA_HISTORY_CAP = 400;        // 플레이어별 delta 보관 최대 개수 (메모리 보호)

const userRatings = {};
const userNames = {};
const userAvatars = {};
const userNormalWins = {};
const accountNormalWins = {};
const waitingNormalPlayers = {}; // { matchKey: [socket, ...] } — 대기열 (동일 계정 매칭 방지 필터 적용)
const userTrophies = {};
const accountTrophies = {};
const accountRatings = {};
const accountNames = {};
const ALLOWED_AVATARS = ['😀', '😎', '🤖', '🐱', '🐶', '🦊', '🐼', '🐵', '🔥', '⚡', '🎯', '🚀'];
const DEFAULT_AVATAR = ALLOWED_AVATARS[0];

// --- 중복 접속 / 어뷰징 방지 (Anti-Abuse) ---
// [주의] 테스트 목적으로 IP 기반 판정은 완전히 제거됨. 동일 playerId(계정) 기준으로만 판정한다.
const playerIdToSocket = {}; // { playerId: socketId } — 동일 계정 다중 접속 차단용

// 두 소켓이 같은 계정(playerId)에서 접속했는지 판정한다.
// true면 매칭이 성립되지 않고, 이미 진행된 대전(커스텀 룸 등)이라면 보상이 무효화된다.
function isAbusivePair(socketA, socketB) {
  if (!socketA || !socketB) return false;
  const pidA = socketA.data && socketA.data.playerId;
  const pidB = socketB.data && socketB.data.playerId;
  return !!(pidA && pidB && pidA === pidB);
}

// Player # + 6자리 랜덤 숫자 형태의 닉네임 생성
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

// 랭킹 순위 기반 닉네임 태그 생성 (100위 이내에만 [#순위] 태그 부여)
function buildPlayerTags(playerId, topRankList) {
  if (!topRankList) return '';
  const idx = topRankList.findIndex(entry => entry.playerId === playerId);
  if (idx === -1) return '';
  const rank = idx + 1;
  if (rank <= 100) return `[#${rank}]`;
  return '';
}

// 기존 닉네임에 붙은 [#...] 태그를 모두 떼어내고, 새로 받은 랭킹 태그를 붙여 반환한다.
function appendDynamicTag(baseNick, rankTag) {
  const base = baseNick || '';
  const coreName = base.replace(/\[[^\]]*\]\s*/g, '').trim();
  if (!coreName) return rankTag.trim();
  return `${coreName} ${rankTag}`.trim();
}

// ============================================================
// ★ 수정됨: 랭킹 계산은 "현재 접속 중인 소켓" 단위가 아니라
//   "계정(playerId)" 단위로, 그리고 접속 여부와 무관하게
//   서버가 알고 있는 전체 계정 데이터(accountRatings 등)를 기준으로 계산한다.
//
//   기존 버그:
//   1) userRatings는 socket.id를 key로 사용하는데, 소켓 disconnect 시
//      해당 항목이 정리(삭제)되지 않아 접속 종료된 "유령 소켓" 데이터가
//      영구적으로 랭킹 풀에 남아 계속 누적됨.
//   2) 매 접속(새로고침)마다 새로운 socket.id가 생성되어 기본값(1000점 등)으로
//      랭킹 풀에 추가되므로, 동점자가 많아지고 동점 처리 시 정렬 기준이
//      명시적이지 않아(=Object 삽입 순서에 의존) 순위가 접속할 때마다
//      달라지는 것처럼(사실상 무작위처럼) 보였음.
//   3) buildPlayerTags는 entry.playerId를 찾는데, 기존 buildTopRankList는
//      entry.id(=socket.id)만 채워서 반환했기 때문에 닉네임 랭크 태그는
//      항상 매칭 실패로 빈 문자열이 되는 별도 버그도 있었음(이번에 같이 수정).
//
//   수정 후:
//   - playerId(계정)별로 유일하게 하나의 항목만 존재하도록 dedupe.
//   - 접속 중이면 최신 socket 기준 값(userRatings 등), 아니면 영구 저장된
//     accountRatings/accountTrophies/accountNormalWins 값을 사용.
//   - 1차: rating(또는 trophy) 내림차순, 2차: 승수(wins) 내림차순,
//     3차: playerId 문자열 비교(완전한 동점자까지 결정론적으로 순서 고정)
//     로 정렬해 동일 입력에 대해 항상 동일한 순위가 나오도록 보장.
// ============================================================

// 현재 서버가 알고 있는 전체 계정 기준 랭킹 리스트(상위 100명)를 만든다.
// sortBy: 'rating' (MMR 기준, 기본값) | 'trophy' (트로피 기준)
function buildTopRankList(sortBy = 'rating') {
  const byAccount = new Map();

  // 1) 현재 접속 중인 소켓들의 최신 값을 계정 단위로 모은다.
  for (const [socketId, sock] of io.sockets.sockets) {
    const playerId = sock.data && sock.data.playerId;
    if (!playerId) continue; // 아직 identify 되지 않은 소켓은 랭킹에서 제외
    byAccount.set(playerId, {
      playerId,
      rating: Number.isFinite(userRatings[socketId]) ? userRatings[socketId] : (accountRatings[playerId] ?? 1000),
      trophies: Number.isFinite(userTrophies[socketId]) ? userTrophies[socketId] : (accountTrophies[playerId] ?? 0),
      wins: Number.isFinite(userNormalWins[socketId]) ? userNormalWins[socketId] : (accountNormalWins[playerId] ?? 0)
    });
  }

  // 2) 현재 접속하지 않은(오프라인) 계정도 영구 저장된 값 기준으로 포함시킨다.
  for (const playerId of Object.keys(accountRatings)) {
    if (byAccount.has(playerId)) continue;
    byAccount.set(playerId, {
      playerId,
      rating: accountRatings[playerId] ?? 1000,
      trophies: accountTrophies[playerId] ?? 0,
      wins: accountNormalWins[playerId] ?? 0
    });
  }

  const list = Array.from(byAccount.values());

  const primaryKey = sortBy === 'trophy' ? 'trophies' : 'rating';
  list.sort((a, b) => {
    if (b[primaryKey] !== a[primaryKey]) return b[primaryKey] - a[primaryKey]; // 1차: 점수 내림차순
    if (b.wins !== a.wins) return b.wins - a.wins;                             // 2차: 일반전 승수 내림차순
    return a.playerId.localeCompare(b.playerId);                               // 3차: 계정ID 사전순(완전 동률 결정론적 처리)
  });

  return list.slice(0, 100);
}

// 주어진 소켓 ID에 대해, 현재 전역 랭킹 순위 기반 태그를 생성한다.
function buildRankTagForSocket(socketId) {
  const sock = io.sockets.sockets.get(socketId);
  const playerId = sock && sock.data ? sock.data.playerId : null;
  if (!playerId) return '';
  const topRankList = buildTopRankList('rating');
  return buildPlayerTags(playerId, topRankList);
}

// 주어진 소켓 ID의 현재 전역 순위(1~100)를 반환. 100위 밖이거나 미식별 소켓이면 null.
// sortBy: 'rating' (기본값, MMR 기준) | 'trophy'
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
const REMATCH_TIMEOUT_MS = 10000; // 재경기 수락 대기 시간 (10초)
const RECENT_MATCH_TTL_MS = 60000; // 경기 종료 후 재경기 요청이 가능한 유효 시간
const recentMatches = {}; // { roomId: { playerIds: [idA, idB], mode, duration, isRanked } } — 방금 끝난 경기 정보
const pendingRematches = {}; // { roomId: { accepted: Set<socketId>, timeoutId } } — 재경기 수락 대기 상태

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
  { min: 1900, label: '챌린저', color: '#f97316', icon: '🔥' },
  { min: 1700, label: '마스터', color: '#a855f7', icon: '👑' },
  { min: 1500, label: '다이아몬드', color: '#38bdf8', icon: '💎' },
  { min: 1300, label: '플래티넘', color: '#14b8a6', icon: '💠' },
  { min: 1100, label: '골드', color: '#e2b714', icon: '🥇' },
  { min: 900, label: '실버', color: '#c0c0c0', icon: '🥈' },
  { min: 700, label: '브론즈', color: '#cd7f32', icon: '🥉' },
  { min: -Infinity, label: '아이언', color: '#8b8f98', icon: '⛓️' }
];

function getTierInfo(rating) {
  const safeRating = Number.isFinite(rating) ? rating : 1000;
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

function calculateNewRatings(winnerRating, loserRating) {
  const K = 32;
  const expectedWinner = 1 / (1 + Math.pow(10, (loserRating - winnerRating) / 400));
  const expectedLoser = 1 - expectedWinner;

  const newWinnerRating = Math.round(winnerRating + K * (1 - expectedWinner));
  const newLoserRating = Math.round(Math.max(0, loserRating + K * (0 - expectedLoser)));

  return { newWinnerRating, newLoserRating };
}

function removeFromWaitingQueues(socket) {
  delete soloPracticeSessions[socket.id];
  Object.keys(waitingNormalPlayers).forEach((k) => {
    if (!Array.isArray(waitingNormalPlayers[k])) return;
    waitingNormalPlayers[k] = waitingNormalPlayers[k].filter((s) => s !== socket);
    if (waitingNormalPlayers[k].length === 0) delete waitingNormalPlayers[k];
  });
  const rIdx = waitingRankedPlayers.findIndex((p) => p.socket === socket);
  if (rIdx > -1) waitingRankedPlayers.splice(rIdx, 1);
}

const PRACTICE_TEXT_DURATION = 60;
const soloPracticeSessions = {};

function clearPracticeSession(socketId) {
  delete soloPracticeSessions[socketId];
}

// 클라이언트가 보내는 playerId를 검증/정규화한다.
// "Player #XXXXXX" 형태와 순수 6자리 코드("XXXXXX") 형태 모두 허용하고,
// 항상 "Player #XXXXXX" (대문자 코드) 표준 형태로 통일해서 반환한다.
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
    accountRatings[socket.data.playerId] = userRatings[socket.id] || 1000;
    const baseName = (userNames[socket.id] || '').replace(/\[[^\]]*\]\s*/g, '').trim();
    if (baseName) accountNames[socket.data.playerId] = baseName;
  }
}

function persistRatings(socket) {
  if (socket.data && socket.data.playerId) {
    accountRatings[socket.data.playerId] = userRatings[socket.id] || 1000;
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
    deltaHistory: [],   // 최근 keystroke 간격(ms) 기록 (서버 메모리에만 보관, 검증용)
    fastStreak: 0,      // 연속으로 임계치 미만 간격이 발생한 횟수
    disqualified: false
  };
}

function sanitizeStat(data, sampleTextLength) {
  const accuracy = Number.isFinite(data.accuracy) ? Math.max(0, Math.min(100, data.accuracy)) : 100;
  const charIndex = Number.isFinite(data.charIndex)
    ? Math.max(0, Math.min(sampleTextLength, Math.floor(data.charIndex)))
    : 0;
  const netCorrect = Number.isFinite(data.netCorrect) ? Math.max(0, Math.floor(data.netCorrect)) : 0;
  const totalTyped = Number.isFinite(data.totalTyped) ? Math.max(0, Math.floor(data.totalTyped)) : 0;
  const totalErrors = Number.isFinite(data.totalErrors) ? Math.max(0, Math.floor(data.totalErrors)) : 0;
  return { accuracy, charIndex, netCorrect, totalTyped, totalErrors };
}
// 클라이언트가 보낸 keystroke 간격(ms) 배치를 플레이어 상태에 반영한다.
// 개수/값 범위를 서버에서 재검증해 비정상적으로 큰 배열이나 음수·과대값 주입을 막는다.
function recordAntiCheatDeltas(player, rawDeltas) {
  if (!Array.isArray(rawDeltas)) return;
  const clean = rawDeltas
    .filter((d) => Number.isFinite(d) && d >= 0 && d < 10000)
    .slice(0, 50); // 한 번에 비정상적으로 큰 배열을 보내는 것 자체도 조작 신호이므로 상한

  clean.forEach((delta) => {
    player.deltaHistory.push(delta);
    if (player.deltaHistory.length > ANTICHEAT_DELTA_HISTORY_CAP) player.deltaHistory.shift();
    player.fastStreak = delta < ANTICHEAT_MIN_INTERVAL_MS ? player.fastStreak + 1 : 0;
  });
}

// 매크로/오토핫키형 패턴 감지: (1) 연속 초단타, (2) 사람이 치기 힘든 수준의 균일(정속) 타건
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

// 지속 최고 속도(WPM) 제한 감지 — 매치 시작 시각(room.startTime) 기준 누적 타수로 계산.
function detectSpeedLimit(player, room) {
  if (player.totalTyped < ANTICHEAT_MAX_WPM_MIN_CHARS) return null;
  const elapsedMs = Date.now() - room.startTime;
  if (elapsedMs <= 0) return null;
  const minutes = elapsedMs / 60000;
  const wpm = (player.totalTyped / 5) / minutes;
  return wpm >= ANTICHEAT_MAX_WPM ? 'SPEED_LIMIT_EXCEEDED' : null;
}

// 감지된 부정행위자를 즉시 몰수패 처리한다. endGame을 그대로 재사용하므로
// 상대는 랭크 MMR/트로피/정상승수까지 일반 승리와 동일하게 정산된다.
function disqualifyPlayer(roomId, cheaterId, reasonCode) {
  const room = rooms[roomId];
  if (!room || room.ended) return;
  const winnerId = Object.keys(room.players).find((id) => id !== cheaterId) || null;
  console.log(`[Anti-Cheat] Disqualified in room ${roomId}: player=${cheaterId} reason=${reasonCode}`);
  endGame(roomId, winnerId, { reason: 'cheat_detected', cheatReason: reasonCode, cheaterId });
}

function startMatch(playerA, playerB, mode, duration, isRanked, customRoomId) {
  const roomId = customRoomId || `room_${playerA.id}_${playerB.id}_${Date.now()}`;
  const prevTextA = playerA.data.lastText || '';
  const text = generateUniqueText(mode, duration, prevTextA);

  playerA.data.lastText = text;
  playerB.data.lastText = text;

  const startTime = Date.now() + COUNTDOWN_MS;

  playerA.join(roomId);
  playerB.join(roomId);
  playerA.data.roomId = roomId;
  playerB.data.roomId = roomId;

  const invalidated = isAbusivePair(playerA, playerB);
  if (invalidated) console.log(`[Anti-Abuse] Same-account match created: ${roomId}`);

  rooms[roomId] = {
    mode, text, startTime, duration, isRanked,
    invalidated,
    endTimeoutId: null, ended: false, players: {}
  };
  rooms[roomId].players[playerA.id] = createEmptyPlayerState();
  rooms[roomId].players[playerB.id] = createEmptyPlayerState();

  const ratingA = userRatings[playerA.id];
  const ratingB = userRatings[playerB.id];
  const nameA = userNames[playerA.id];
  const nameB = userNames[playerB.id];
  const avatarA = userAvatars[playerA.id] || DEFAULT_AVATAR;
  const avatarB = userAvatars[playerB.id] || DEFAULT_AVATAR;
  const tierA = getTierInfo(ratingA);
  const tierB = getTierInfo(ratingB);
  const trophiesA = userTrophies[playerA.id] || 0;
  const trophiesB = userTrophies[playerB.id] || 0;
  // 매치 시작 시점 기준 전역 순위 (100위 밖이면 null)
  const rankA = getPlayerRankInfo(playerA.id, isRanked ? 'rating' : 'trophy');
  const rankB = getPlayerRankInfo(playerB.id, isRanked ? 'rating' : 'trophy');

  const basePayload = {
    mode, text, startTime,
    duration: mode === 'time' ? duration : null,
    isRanked
  };

  playerA.emit('gameStart', {
    ...basePayload,
    myName: nameA, myRating: ratingA, myTier: tierA, myAvatar: avatarA, myTrophies: trophiesA, myRank: rankA,
    opponentName: nameB, opponentRating: ratingB, opponentTier: tierB, opponentAvatar: avatarB, opponentTrophies: trophiesB, opponentRank: rankB
  });
  playerB.emit('gameStart', {
    ...basePayload,
    myName: nameB, myRating: ratingB, myTier: tierB, myAvatar: avatarB, myTrophies: trophiesB, myRank: rankB,
    opponentName: nameA, opponentRating: ratingA, opponentTier: tierA, opponentAvatar: avatarA, opponentTrophies: trophiesA, opponentRank: rankA
  });

  const timeoutMs = COUNTDOWN_MS + duration * 1000;
  rooms[roomId].endTimeoutId = setTimeout(() => endGame(roomId, undefined), timeoutMs);
}

function endGame(roomId, forcedWinnerId, options = {}) {
  const room = rooms[roomId];
  if (!room || room.ended) return;
  room.ended = true;
  clearTimeout(room.endTimeoutId);
    const reason = options.reason || null; // 'forfeit', 'cheat_detected' 등 — 클라이언트에 전달
  const cheatReason = options.cheatReason || null;
  const cheaterId = options.cheaterId || null;

  const ids = Object.keys(room.players);
  let winnerId = forcedWinnerId;

  if (winnerId === undefined) {
    const [id1, id2] = ids;
    const p1 = room.players[id1];
    const p2 = room.players[id2];

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

  let ratingChanges = {};
  if (room.isRanked && !room.invalidated && winnerId !== null) {
    const loserId = ids.find(id => id !== winnerId);
    const wRating = userRatings[winnerId] || 1000;
    const lRating = userRatings[loserId] || 1000;

    const { newWinnerRating, newLoserRating } = calculateNewRatings(wRating, lRating);
    userRatings[winnerId] = newWinnerRating;
    userRatings[loserId] = newLoserRating;

    ratingChanges[winnerId] = { old: wRating, new: newWinnerRating, diff: newWinnerRating - wRating };
    ratingChanges[loserId] = { old: lRating, new: newLoserRating, diff: newLoserRating - lRating };
  }

  let winnerUnlock = null;
  if (!room.isRanked && !room.invalidated && winnerId !== null) {
    const winnerSocket = io.sockets.sockets.get(winnerId);
    if (winnerSocket) winnerUnlock = addNormalWin(winnerSocket);
  }

  const trophyChanges = {};
  if (!room.invalidated) {
    ids.forEach((id) => {
      const res = winnerId === null ? 'draw' : (winnerId === id ? 'win' : 'lose');
      const change = getTrophyChange(res, room.duration);
      userTrophies[id] = Math.max(0, (userTrophies[id] || 0) + change);
      trophyChanges[id] = { new: userTrophies[id], diff: change };
      const playerSocketForTrophy = io.sockets.sockets.get(id);
      if (playerSocketForTrophy) persistTrophies(playerSocketForTrophy);
    });
  } else {
    console.log(`[Anti-Abuse] Match rewards invalidated: ${roomId}`);
  }

  if (room.isRanked) {
    ids.forEach((id) => {
      const sock = io.sockets.sockets.get(id);
      if (sock) persistRatings(sock);
    });
  }

  ids.forEach((id) => {
    const oppId = ids.find((x) => x !== id);
    const playerSocket = io.sockets.sockets.get(id);
    const oppSocket = io.sockets.sockets.get(oppId);
    const oppPlayerId = oppSocket && oppSocket.data ? oppSocket.data.playerId : null;

        io.to(id).emit('gameOver', {
      result: winnerId === null ? 'draw' : (winnerId === id ? 'win' : 'lose'),
      myStats: room.players[id],
      opponentStats: room.players[oppId],
      ratingData: room.isRanked ? ratingChanges[id] : null,
      trophyData: trophyChanges[id],
      unlock: playerSocket ? unlockPayload(playerSocket) : null,
      justUnlocked: !!(winnerUnlock && winnerId === id && winnerUnlock.justUnlocked),
      invalidated: !!room.invalidated,
      opponentId: oppPlayerId,
      opponentName: userNames[oppId] || 'Opponent',
           reason: reason,
      cheatReason: cheatReason,
      disqualified: cheaterId === id,
      roomId: roomId
    });  
  });

  // 재경기 요청을 위해 방금 끝난 매치업 정보를 잠시 보관한다 (양쪽 모두 연결 상태일 때만).
  if (ids.every((id) => { const s = io.sockets.sockets.get(id); return s && s.connected; })) {
    recentMatches[roomId] = { playerIds: ids.slice(), mode: room.mode, duration: room.duration, isRanked: room.isRanked };
    setTimeout(() => { delete recentMatches[roomId]; }, RECENT_MATCH_TTL_MS);
  }

  delete rooms[roomId];
}

function sendInitUser(socket) {
  const rankTag = buildRankTagForSocket(socket.id);
  const baseName = (userNames[socket.id] || '').replace(/\[[^\]]*\]\s*/g, '').trim();
  userNames[socket.id] = appendDynamicTag(baseName, rankTag);
  socket.emit('initUser', {
    playerId: socket.data.playerId || null, // 클라이언트가 localStorage에 그대로 저장할 확정 ID
    rating: userRatings[socket.id],
    trophies: userTrophies[socket.id],
    name: userNames[socket.id],
    avatar: userAvatars[socket.id],
    allowedAvatars: ALLOWED_AVATARS,
    ...unlockPayload(socket),
    rankTag: rankTag
  });
}

io.on('connection', (socket) => {
  runSeasonResets();

  userRatings[socket.id] = userRatings[socket.id] || 1000;
  userAvatars[socket.id] = userAvatars[socket.id] || DEFAULT_AVATAR;
  userNormalWins[socket.id] = userNormalWins[socket.id] || 0;
  userTrophies[socket.id] = userTrophies[socket.id] || 0;

  userNames[socket.id] = userNames[socket.id] || 'Connecting...';

  sendInitUser(socket);

  // 클라이언트가 playerId를 보내면 기존 계정 데이터 복구 + 닉네임 재전송.
  // playerId가 없거나 유효하지 않으면 서버가 새로 발급해서 클라이언트에 내려준다.
  socket.on('identify', (data) => {
    data = data || {};
    let playerId = sanitizePlayerId(data.playerId);

    if (!playerId) {
      playerId = generatePlayerNick(generatePlayerCode());
    }
    socket.data.playerId = playerId;

    // 동일 계정 중복 접속 차단: 먼저 접속해 있던 세션을 강제 종료(Kick)한다.
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
    userRatings[socket.id] = accountRatings[playerId] || userRatings[socket.id];
    userTrophies[socket.id] = accountTrophies[playerId] || 0;

    // 기존 닉네임이 있으면 복구. 없으면 playerId 자체를 표시 닉네임으로 사용한다.
    if (accountNames[playerId]) {
      userNames[socket.id] = accountNames[playerId];
    } else {
      const nick = /^Player #/i.test(playerId) ? playerId : generatePlayerNick(playerId);
      accountNames[playerId] = nick;
      userNames[socket.id] = nick;
    }

    // 랭킹 태그 재생성 + playerId 포함해서 클라이언트에 전달
    sendInitUser(socket);
    socket.emit('unlockStatus', unlockPayload(socket));
    socket.emit('trophyUpdate', { trophies: userTrophies[socket.id] });
  });

  socket.on('selectMode', (data) => {
    data = data || {};
    const isRanked = !!data.isRanked;
    const mode = 'time';
    const duration = ALLOWED_TIME_DURATIONS.includes(data.duration) ? data.duration : DEFAULT_TIME_DURATION;

    if (isRanked && !isRankedUnlocked(socket)) {
      socket.emit('rankedLocked', unlockPayload(socket));
      return;
    }

    if (isRanked) {
      const myRating = userRatings[socket.id];
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
        startMatch(opponent, socket, mode, duration, false);
        clearPracticeSession(socket.id);
        clearPracticeSession(opponent.id);
      } else {
        queue.push(socket);
        socket.emit('waiting', { isRanked: false });
      }
    }
  });

    socket.on('progress', (data) => {
    const room = rooms[socket.data.roomId];
    if (!room || room.ended) return;
    const player = room.players[socket.id];
    if (!player || player.finished || player.disqualified) return;

    const { accuracy, charIndex, netCorrect, totalTyped, totalErrors } = sanitizeStat(data || {}, room.text.length);

    // percent는 charIndex 기반으로 서버에서 재계산해 클라이언트 위조/오차를 방지한다.
    const percent = room.text.length > 0
      ? Math.min(100, Math.floor((charIndex / room.text.length) * 100))
      : 0;

    player.percent = percent;
    player.charIndex = charIndex;
    player.netCorrect = netCorrect;
    player.totalTyped = totalTyped;
    player.totalErrors = totalErrors;
    // accuracy는 서버에서 총입력/누적오류 기반으로 재계산 (오타 1회면 영구 100% 불가 반영)
    player.accuracy = totalTyped > 0
      ? Math.max(0, Math.round(((totalTyped - totalErrors) / totalTyped) * 100))
      : 100;

    // --- Anti-Cheat 검증 ---
    // 클라이언트가 보낸 keystroke 간격 배치를 반영한 뒤 매크로/정속 패턴과 지속 최고속도를 검사한다.
    // 위반 감지 시 그 즉시 이 판을 종료하고 해당 플레이어를 몰수패 처리한다.
    recordAntiCheatDeltas(player, (data && data.deltas) || []);
    const cheatReason = detectMacroPattern(player) || detectSpeedLimit(player, room);
    if (cheatReason) {
      player.disqualified = true;
      disqualifyPlayer(socket.data.roomId, socket.id, cheatReason);
      return;
    }

    // 100% 완주 시 자동으로 playerFinished 처리

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
    const countdownSec = 3;
    io.to(code).emit('customRoomCountdown', { seconds: countdownSec });
    setTimeout(() => {
      if (!customRooms[code]) return;
      const [host, guest] = customRooms[code].players;
      delete customRooms[code];
      startMatch(host, guest, room.mode, room.duration, room.isRanked, code);
    }, countdownSec * 1000);
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
    const topList = buildTopRankList(rankSortKind); // ★ 계정 단위로 정렬된 리스트를 그대로 재사용

    const myId = socket.data && socket.data.playerId;
    const entries = topList.map((entry) => ({
      playerId: entry.playerId,
      name: accountNames[entry.playerId] || entry.playerId || 'Guest',
      avatar: DEFAULT_AVATAR,
      rating: entry.rating,
      trophies: entry.trophies,
      isMe: entry.playerId === myId
    }));

    // 내 계정이 상위 100위 밖이라 리스트에 없다면 별도로 채워서 내려준다(기존 동작 유지).
    if (myId && !entries.some((e) => e.playerId === myId)) {
      entries.push({
        playerId: myId,
        name: userNames[socket.id] || 'Guest',
        avatar: userAvatars[socket.id] || DEFAULT_AVATAR,
        rating: userRatings[socket.id] || 1000,
        trophies: accountMonthlyTrophies[myId] || userTrophies[socket.id] || 0,
        isMe: true
      });
    }

    socket.emit('leaderboardData', { sortBy, entries: entries.slice(0, 50) });
  });

  socket.on('report_player', (data) => {
    data = data || {};
    const reporterId = socket.data && socket.data.playerId;
    const targetId = data.targetPlayerId;
    const roomId = data.roomId;
    const reason = data.reason;

    if (!reporterId || !targetId || !roomId || !reason) {
      socket.emit('reportResult', { success: false, message: 'Missing required fields.' });
      return;
    }

    if (reporterId === targetId) {
      socket.emit('reportResult', { success: false, message: 'You cannot report yourself.' });
      return;
    }

    if (!reportedInMatch[roomId]) reportedInMatch[roomId] = new Set();
    if (reportedInMatch[roomId].has(reporterId)) {
      socket.emit('reportResult', { success: false, message: 'You already reported in this match.' });
      return;
    }
    reportedInMatch[roomId].add(reporterId);

    const validReasons = ['cheating', 'inappropriate_name', 'other'];
    const cleanReason = validReasons.includes(reason) ? reason : 'other';

    let targetName = 'Unknown';
    for (const [sid, s] of io.sockets.sockets) {
      if (s.data && s.data.playerId === targetId) {
        targetName = userNames[sid] || 'Unknown';
        break;
      }
    }

    const reportEntry = {
      timestamp: new Date().toISOString(),
      reporterId,
      reporterName: userNames[socket.id] || 'Unknown',
      targetId,
      targetName,
      roomId,
      reason: cleanReason,
      matchStats: data.matchStats || {}
    };

    reportLogs.push(reportEntry);
    console.log(`[Report] ${reportEntry.reporterName}(${reporterId}) reported ${reportEntry.targetName}(${targetId}) for "${cleanReason}" in room ${roomId}`);

    sendDiscordReportWebhook(reportEntry);

    socket.emit('reportResult', { success: true, message: 'Report submitted. Thank you!' });
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
    if (!room || room.ended) return;
    const remainingId = Object.keys(room.players).find((id) => id !== socket.id);
    if (!remainingId) return;
    endGame(roomId, remainingId, { reason: 'forfeit' });
  });
    // --- 재경기(Rematch) ---
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
        startMatch(p1, p2, match.mode, match.duration, match.isRanked);
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

    // 재경기 대기/제안 중이었다면 상대에게 알리고 정리한다.
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
    if (room && !room.ended) {
      const remainingId = Object.keys(room.players).find((id) => id !== socket.id);
      if (remainingId) {
        // 남은 플레이어에게 몰수승(forfeit win) 처리.
        // endGame을 그대로 재사용해서 랭크전 MMR, 트로피, 일반전 승수까지
        // 정상 경기 종료와 완전히 동일한 경로로 정산한다.
        endGame(roomId, remainingId, { reason: 'forfeit' });
      } else {
        clearTimeout(room.endTimeoutId);
        delete rooms[roomId];
      }
    }

    // ★ 소켓 기준으로 남아있던 임시 랭킹 데이터(userRatings 등)는 계정(playerId)에
    //   이미 persist* 함수들을 통해 저장되어 있으므로, 소켓 자체 항목은 정리한다.
    //   (정리하지 않으면 접속 종료된 유령 소켓 항목이 buildTopRankList의
    //    "현재 접속 중" 루프에는 더 이상 잡히지 않지만, 메모리에 무한히
    //    쌓이는 것을 막기 위해 명시적으로 삭제한다.)
    delete userRatings[socket.id];
    delete userNames[socket.id];
    delete userAvatars[socket.id];
    delete userNormalWins[socket.id];
    delete userTrophies[socket.id];
  });
});

server.listen(PORT, () => console.log(`서버 실행 중: http://localhost:${PORT}`));