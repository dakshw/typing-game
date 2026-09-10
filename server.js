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
  lastMmrResetMonth: null,   // 'YYYY-MM' of last MMR soft reset
  lastTrophyResetMonth: null // 'YYYY-MM' of last trophy leaderboard reset
};

// 소프트 리셋 이전 레이팅 (시즌 종료 시점 스냅샷)
const accountPreResetRatings = {}; // { playerId: rating }

// 이번 달 트로피 (리더보드용 — 매월 1일 리셋)
const accountMonthlyTrophies = {}; // { playerId: number }

function getCurrentMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function softResetMMR(mmr) {
  return Math.round(mmr * SEASON_SOFT_RESET_RATIO + SEASON_SOFT_RESET_FLOOR);
}

function runSeasonResets() {
  const currentMonth = getCurrentMonth();

  // --- MMR 소프트 리셋 (월간) ---
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

  // --- 트로피 월간 리셋 ---
  if (seasonState.lastTrophyResetMonth !== currentMonth) {
    for (const [id] of Object.entries(userTrophies)) {
      userTrophies[id] = 0;
    }
    // 계정별 월간 트로피도 초기화 (누적은 accountTrophies에 보존)
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

const userRatings = {};
const userNames = {};
const userAvatars = {};
const userNormalWins = {};
const accountNormalWins = {};
const waitingNormalPlayers = {};
const userTrophies = {};
const accountTrophies = {};
const accountRatings = {}; // { playerId: rating } — 재접속 시 레이팅 복구용
const accountNames = {}; // { playerId: 'Player #XXXXXX' } — 재접속 시 닉네임 복구용
// 프로필에서 선택 가능한 아바타 이모지 화이트리스트.
const ALLOWED_AVATARS = ['😀', '😎', '🤖', '🐱', '🐶', '🦊', '🐼', '🐵', '🔥', '⚡', '🎯', '🚀'];
const DEFAULT_AVATAR = ALLOWED_AVATARS[0];

// Player # + 6자리 랜덤 숫자 형태의 닉네임 생성
function generatePlayerCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function generatePlayerNick(playerId) {
  return `Player #${playerId}`;
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

// 현재 서버 메모리 기준 정상 MMR 랭킹 상위 100명 리스트를 만든다.
function buildTopRankList() {
  const list = [];
  for (const [id, rating] of Object.entries(userRatings)) {
    list.push({ id, rating });
  }
  list.sort((a, b) => b.rating - a.rating);
  return list.slice(0, 100);
}

// 주어진 소켓 ID에 대해, 현재 전역 랭킹 순위 기반 태그를 생성한다.
function buildRankTagForSocket(socketId) {
  const topRankList = buildTopRankList();
  return buildPlayerTags(socketId, topRankList);
}

const waitingRankedPlayers = [];
const rooms = {};
const customRooms = {}; // { CODE: { mode, duration, isRanked, players: [socket] } }

// --- Report System ---
const reportLogs = []; // 보고서 메모리 저장소 (운영용 로그)
const reportedInMatch = {}; // { roomId_SetKey: Set<reporterPlayerId> } — 같은 경기 중복 신고 방지

// Discord Webhook — report_player 이벤트 발생 시 자동 알림 발송.
// 환경변수 DISCORD_REPORT_WEBHOOK 에 웹훅 URL을 설정하면 활성화된다.
const DISCORD_REPORT_WEBHOOK = process.env.DISCORD_REPORT_WEBHOOK || '';

function sendDiscordReportWebhook(entry) {
  if (!DISCORD_REPORT_WEBHOOK) return; // URL이 없으면 아무 작업도 하지 않는다.

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
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // I/O/0/1 제외로 혼동 방지
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// LoL 스타일 티어 시스템: 레이팅 구간별로 아이언~챌린저를 부여한다.
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

// 두 단어가 "너무 치기 쉬운 조합"인지 판정
function isEasyTransition(prevWord, nextWord) {
  if (!prevWord) return false;
  if (prevWord === nextWord) return true; // 같은 단어 연속
  if (prevWord.length <= 3 && nextWord.length <= 3) return true; // 짧은 단어끼리 연속 (예: "of the")
  if (prevWord[prevWord.length - 1] === nextWord[0]) return true; // 앞단어 끝글자 = 다음단어 첫글자
  return false;
}

function pickNextWord(pool, prevWord) {
  const candidates = pool.filter(w => !isEasyTransition(prevWord, w));
  const source = candidates.length > 0 ? candidates : pool; // 후보가 없으면 제약 풀어줌 (무한루프 방지)
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

// 매칭 대기열(일반전/경쟁전)에서 해당 소켓을 제거한다. cancelSearch, disconnect 양쪽에서 재사용.
function removeFromWaitingQueues(socket) {
  delete soloPracticeSessions[socket.id];
  Object.keys(waitingNormalPlayers).forEach((k) => {
    if (waitingNormalPlayers[k] === socket) delete waitingNormalPlayers[k];
  });
  const rIdx = waitingRankedPlayers.findIndex((p) => p.socket === socket);
  if (rIdx > -1) waitingRankedPlayers.splice(rIdx, 1);
}

// --- 솔로 연습 모드 (Solo Practice Mode) ---
// 유저가 [Enter Solo Practice] 버튼을 직접 눌렀을 때만 진입한다 (자동 카운트다운 없음).
// 대기열은 그대로 유지되므로, 연습 중에도 실제 유저 매칭이 성사되면 즉시 대전으로 전환된다.
const PRACTICE_TEXT_DURATION = 60; // 연습 텍스트 청크 길이 기준 (분당 단어 수 환산용)

const soloPracticeSessions = {}; // { socketId: { text } }

// 매칭 성사/취소/접속 종료 시 연습 세션을 정리한다.
function clearPracticeSession(socketId) {
  delete soloPracticeSessions[socketId];
}

// 닉네임/아바타 사용자 입력 검증 함수는 더 이상 사용하지 않는다.
// 닉네임은 서버 접속 순번 기반 Player #번호로만 부여하고,
// 아바타는 허용되는 이모지 화이트리스트에 없으면 기본값으로 처리한다.
function sanitizePlayerId(raw) {
  if (typeof raw !== 'string') return null;
  const id = raw.trim();
  // Player #XXXXXX 형태(6자리 영문+숫자) 허용
  if (/^Player #[A-Z0-9]{6}$/.test(id)) return id;
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
    // 태그 없는 기본 이름만 저장 (태그는 매 연결 시 재생성)
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
    accountTrophies[pid] = currentTrophies;  // 누적 (DB 역할)
    accountMonthlyTrophies[pid] = currentTrophies; // 이번 달 리더보드용
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
  return { percent: 0, accuracy: 100, charIndex: 0, finished: false, finishTime: null, netCorrect: 0, totalTyped: 0, totalErrors: 0 };
}

// 클라이언트가 보내는 progress/finished 데이터는 항상 이 함수를 통해 정제한다.
// 정확도 하한선(예: 90% 이상만 인정) 같은 게이트는 절대 여기에 추가하지 않는다.
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

  rooms[roomId] = {
    mode, text, startTime, duration, isRanked,
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
  const basePayload = {
  
    mode, text, startTime,
    duration: mode === 'time' ? duration : null,
    isRanked
  };

  // 각 플레이어에게 "나"와 "상대" 관점으로 개인화된 데이터를 보낸다.
  // (레이팅/티어/닉네임/아바타는 방송이 아니라 소켓별로 따로 보내야 me/opponent 구분이 명확함)
    playerA.emit('gameStart', {
    ...basePayload,
    myName: nameA, myRating: ratingA, myTier: tierA, myAvatar: avatarA, myTrophies: trophiesA,
    opponentName: nameB, opponentRating: ratingB, opponentTier: tierB, opponentAvatar: avatarB, opponentTrophies: trophiesB
  });
  playerB.emit('gameStart', {
    ...basePayload,
    myName: nameB, myRating: ratingB, myTier: tierB, myAvatar: avatarB, myTrophies: trophiesB,
    opponentName: nameA, opponentRating: ratingA, opponentTier: tierA, opponentAvatar: avatarA, opponentTrophies: trophiesA
  });

  const timeoutMs = COUNTDOWN_MS + duration * 1000;
  rooms[roomId].endTimeoutId = setTimeout(() => endGame(roomId, undefined), timeoutMs);
}

function endGame(roomId, forcedWinnerId) {
  const room = rooms[roomId];
  if (!room || room.ended) return;
  room.ended = true;
  clearTimeout(room.endTimeoutId);

  const ids = Object.keys(room.players);
  let winnerId = forcedWinnerId;

  if (winnerId === undefined) {
    const [id1, id2] = ids;
    const p1 = room.players[id1];
    const p2 = room.players[id2];

    const nc1 = Number.isFinite(p1.netCorrect) ? p1.netCorrect : 0;
    const nc2 = Number.isFinite(p2.netCorrect) ? p2.netCorrect : 0;

    if (nc1 !== nc2) {
      // 유효 글자 수(Net Correct Chars)가 더 높은 쪽이 승리
      winnerId = nc1 > nc2 ? id1 : id2;
    } else {
      // netCorrect 동점이면 완주 우선, 없으면 draw
      const bothFinished = p1.finished && p2.finished;
      const oneFinished = p1.finished || p2.finished;

      if (bothFinished) {
        // 둘 다 완주: 더 빨리 완주한 쪽이 승리 (동시 완주는 draw)
        if (p1.finishTime !== p2.finishTime) {
          winnerId = p1.finishTime < p2.finishTime ? id1 : id2;
        } else {
          winnerId = null; // 동시 완주 → draw
        }
      } else if (oneFinished) {
        // 한 명만 완주: 완주한 쪽이 무조건 승리
        winnerId = p1.finished ? id1 : id2;
      } else {
        // 아무도 미완주: draw
        winnerId = null;
      }
    }
  }

  let ratingChanges = {};
  if (room.isRanked && winnerId !== null) {
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
  if (!room.isRanked && winnerId !== null) {
    const winnerSocket = io.sockets.sockets.get(winnerId);
    if (winnerSocket) winnerUnlock = addNormalWin(winnerSocket);
  }

  // --- 트로피 변동 계산 (시간 모드 배율 적용) ---
  const trophyChanges = {};
  ids.forEach((id) => {
    const res = winnerId === null ? 'draw' : (winnerId === id ? 'win' : 'lose');
    const change = getTrophyChange(res, room.duration);
    userTrophies[id] = Math.max(0, (userTrophies[id] || 0) + change);
    trophyChanges[id] = { new: userTrophies[id], diff: change };
    const playerSocketForTrophy = io.sockets.sockets.get(id);
    if (playerSocketForTrophy) persistTrophies(playerSocketForTrophy);
  });

  // 경쟁전 레이팅 영구 저장
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
      opponentId: oppPlayerId,
      opponentName: userNames[oppId] || 'Opponent',
      roomId: roomId
    });
  });

  delete rooms[roomId];
}

function sendInitUser(socket) {
  const rankTag = buildRankTagForSocket(socket.id);
  const baseName = (userNames[socket.id] || '').replace(/\[[^\]]*\]\s*/g, '').trim();
  userNames[socket.id] = appendDynamicTag(baseName, rankTag);
  socket.emit('initUser', {
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

  // 임시 이름 (identify 이후 실제 이름으로 교체됨)
  userNames[socket.id] = userNames[socket.id] || 'Connecting...';

  // 초기 initUser (identify 전 임시 상태)
  sendInitUser(socket);

  // 클라이언트가 playerId를 보내면 기존 계정 데이터 복구 + 닉네임 재전송
  socket.on('identify', (data) => {
    data = data || {};
    const playerId = sanitizePlayerId(data.playerId);
    if (!playerId) {
      socket.emit('unlockStatus', unlockPayload(socket));
      return;
    }
    socket.data.playerId = playerId;
    userNormalWins[socket.id] = accountNormalWins[playerId] || 0;
    userRatings[socket.id] = accountRatings[playerId] || userRatings[socket.id];
    userTrophies[socket.id] = accountTrophies[playerId] || 0;

    // 기존 닉네임이 있으면 복구, 없으면 새 Player #XXXXXX 생성
    if (accountNames[playerId]) {
      userNames[socket.id] = accountNames[playerId];
    } else {
      const newId = generatePlayerCode();
      const nick = generatePlayerNick(newId);
      accountNames[playerId] = nick;
      userNames[socket.id] = nick;
    }

    // 랭킹 태그 재생성 후 클라이언트에 전달
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
        p => p.socket.id !== socket.id && p.mode === mode && p.duration === duration && p.socket.connected
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
      const opponent = waitingNormalPlayers[matchKey];

      if (opponent && opponent.connected && opponent.id !== socket.id) {
        delete waitingNormalPlayers[matchKey];
        startMatch(opponent, socket, mode, duration, false);
        clearPracticeSession(socket.id);
        clearPracticeSession(opponent.id);
      } else {
        waitingNormalPlayers[matchKey] = socket;
        socket.emit('waiting', { isRanked: false });
      }
    }
  });

  socket.on('progress', (data) => {
    const room = rooms[socket.data.roomId];
    if (!room || room.ended) return;
    const player = room.players[socket.id];
    if (!player || player.finished) return;

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

  // 매칭 대기 중 사용자가 취소를 누르면 대기열에서만 제거한다.
  // 이미 매칭이 성사되어 방이 생성된 이후라면(gameStart 발송됨) 취소는 무시된다 —
  // 이 경우 클라이언트는 곧 도착하는 gameStart 이벤트로 자연스럽게 게임 화면으로 전환된다.
  // --- 비밀방(커스텀 룸) 생성/입장 ---
  socket.on('createRoom', (data) => {
    data = data || {};
    const mode = 'time';
    const duration = ALLOWED_TIME_DURATIONS.includes(data.duration) ? data.duration : DEFAULT_TIME_DURATION;
    // 유니크 코드 생성 (중복 방지)
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
    room.players.push(socket);
    socket.join(code);
    socket.data.customRoomCode = code;
    socket.emit('roomJoined', { code });
    // 방장에게도 알림
    room.players[0].emit('roomOpponentJoined');
    // 2명이 모였으므로 3초 후 게임 시작
    const countdownSec = 3;
    io.to(code).emit('customRoomCountdown', { seconds: countdownSec });
    setTimeout(() => {
      if (!customRooms[code]) return; // 취소된 방 무시
      const [host, guest] = customRooms[code].players;
      delete customRooms[code]; // 대기 상태 해제
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

  // --- 리더보드 ---
  socket.on('requestLeaderboard', (data) => {
    data = data || {};
    const sortBy = data.sortBy || 'rank'; // 'rank' | 'trophy'

    // 전체 유저 데이터를 배열로 변환
    const entries = [];
    const seenIds = new Set();

    // account 기반 데이터 (재접속해도 유지되는 데이터)
    for (const [id, rating] of Object.entries(userRatings)) {
      const sock = io.sockets.sockets.get(id);
      const playerId = sock && sock.data ? sock.data.playerId : null;
      if (playerId && !seenIds.has(playerId)) {
        seenIds.add(playerId);
        entries.push({
          playerId,
          name: userNames[id] || 'Guest',
          avatar: userAvatars[id] || DEFAULT_AVATAR,
          rating: userRatings[id] || 1000,
          trophies: accountMonthlyTrophies[playerId] || userTrophies[id] || 0,
          isMe: playerId === (socket.data && socket.data.playerId)
        });
      }
    }

    // 현재 소켓의 데이터가 entries에 없으면 추가
    const myId = socket.data && socket.data.playerId;
    if (myId && !seenIds.has(myId)) {
      seenIds.add(myId);
      entries.push({
        playerId: myId,
        name: userNames[socket.id] || 'Guest',
        avatar: userAvatars[socket.id] || DEFAULT_AVATAR,
        rating: userRatings[socket.id] || 1000,
        trophies: accountMonthlyTrophies[myId] || userTrophies[socket.id] || 0,
        isMe: true
      });
    }

    // 정렬
    if (sortBy === 'rank') {
      entries.sort((a, b) => b.rating - a.rating);
    } else if (sortBy === 'trophy') {
      entries.sort((a, b) => b.trophies - a.trophies);
    }

    // 상위 50개만 전송
    const top = entries.slice(0, 50);
    socket.emit('leaderboardData', { sortBy, entries: top });
  });

  // --- Report ---
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

    // 본인 신고 방지
    if (reporterId === targetId) {
      socket.emit('reportResult', { success: false, message: 'You cannot report yourself.' });
      return;
    }

    // 같은 경기 중복 신고 방지
    if (!reportedInMatch[roomId]) reportedInMatch[roomId] = new Set();
    if (reportedInMatch[roomId].has(reporterId)) {
      socket.emit('reportResult', { success: false, message: 'You already reported in this match.' });
      return;
    }
    reportedInMatch[roomId].add(reporterId);

    // 사유 검증
    const validReasons = ['cheating', 'inappropriate_name', 'other'];
    const cleanReason = validReasons.includes(reason) ? reason : 'other';

    // 타겟 유저 이름 조회
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

    // Discord 웹훅으로 신고 알림 발송
    sendDiscordReportWebhook(reportEntry);

    socket.emit('reportResult', { success: true, message: 'Report submitted. Thank you!' });
  });

  // --- 솔로 연습 모드 ---
  // 유저가 [Enter Solo Practice] 버튼을 눌렀을 때 호출된다. 대기열은 유지된다.
  socket.on('requestSoloPractice', () => {
    const text = generateUniqueText('practice', PRACTICE_TEXT_DURATION, socket.data.lastText || '');
    socket.data.lastText = text;
    soloPracticeSessions[socket.id] = { text };
    socket.emit('soloPracticeStart', { text });
  });

  // 연습 중에도 대기열에 남아 있어 실제 유저 매칭 성사 시 gameStart가 즉시 발송되어
  // 클라이언트가 자연스럽게 대전 화면으로 전환된다.
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

  socket.on('cancelSearch', () => {
    removeFromWaitingQueues(socket);
    clearPracticeSession(socket.id);
  });

  socket.on('disconnect', () => {
    removeFromWaitingQueues(socket);
    clearPracticeSession(socket.id);

    const room = rooms[socket.data.roomId];
    if (room && !room.ended) {
      room.ended = true;
      clearTimeout(room.endTimeoutId);

      const remainingId = Object.keys(room.players).find((id) => id !== socket.id);
      const remainingSocket = remainingId ? io.sockets.sockets.get(remainingId) : null;
      let remainingUnlock = remainingSocket ? unlockPayload(remainingSocket) : null;
      let justUnlocked = false;

      if (!room.isRanked && remainingSocket) {
        const afterWin = addNormalWin(remainingSocket);
        remainingUnlock = afterWin;
        justUnlocked = !!(afterWin && afterWin.justUnlocked);
      }

      socket.to(socket.data.roomId).emit('opponentLeft', {
        unlock: remainingUnlock,
        justUnlocked
      });
      delete rooms[socket.data.roomId];
    }
  });
});

server.listen(PORT, () => console.log(`서버 실행 중: http://localhost:${PORT}`));
