const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;
const BUILD_ID = 'friendly-v20'; // [v20] 실행 중인 서버가 최신 파일인지 확인하는 용도 (화면 우측 하단에도 표시됨)
app.use(express.static(path.join(__dirname, 'public')));

// ★ 랭크전 여부 판정은 반드시 이 함수 하나만 사용한다.
//   오직 boolean true 일 때만 Ranked. (문자열 "false", 1, undefined 등은 전부 Casual 취급)
function isRankedFlag(value) {
  return value === true;
}

// ★ Casual 매치에서도 MMR(레이팅)을 변동시킬지 여부.
//   false(기본): Casual은 트로피만 변동, MMR/연승은 Ranked 전용 (랭크 매치메이킹/리더보드 MMR 보호)
//   true: Casual에서도 Ranked와 동일하게 MMR/연승이 증감한다.
const CASUAL_MMR_ENABLED = false;

// ============================================================
// ★ 트로피는 Casual(일반전) 전용이다.
//   - Ranked 경기는 승/패/무 상관없이 트로피가 절대 변동하지 않는다. (Ranked는 MMR/연승만 변동)
//   - ★ 친선(커스텀 룸) 경기도 승/패/무/기권 상관없이 트로피·MMR·연승·일반전 승수가 절대 변동하지 않는다.
//     (결과 화면은 일반전과 똑같이 WIN / LOSE + "+0 Trophies"로 표시된다.)
//   - 승리: +10 트로피 (상대 기권승 포함) / 패배: 0 (트로피 절대 안 깎임) / 무승부: 0
//   - 내가 기권(이탈)하면 패배 처리 → 0 (손해도 보상도 없음)
//   - 연승 보너스 없음, 시간 모드 배율 없음 (항상 정확히 +10, 누적형)
//   - 같은 계정끼리 붙은 판(invalidated)은 변동 없음.
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
// ★ Ranked MMR 규칙 (고정 점수제 + 부드러운 연승 보너스)
//   - 시작 MMR 100, 최소 0점 (0 미만으로 내려가지 않음)
//   - 승리: 상대 기권승 / 점수차 10 미만 +15
//           점수차 10 이상 ~ 60 미만 +25   (정확히 10점 차이는 +25 구간)
//           점수차 60 이상 압승 +30
//   - 패배: 내가 기권패 / 점수차 10 미만 -10
//           점수차 10 이상 ~ 60 미만 -20
//           점수차 60 이상 완패 -25
//     (패배 감점은 승리 점수보다 5점씩 적다 → 승률 50% 유저도 천천히 등반 가능)
//   - 연승 보너스: 1~2연승 +0 / 3연승부터 1연승 늘 때마다 +2 (3연승 +2, 4연승 +4 ...) / 10연승 이상 +16 고정
//   - 패배(또는 기권)하면 연승 0으로 리셋. 무승부는 MMR/연승 모두 변동 없음.
//   "점수차" = 두 플레이어의 netCorrect(순 정타 글자 수) 차이.
//   (수치를 바꾸고 싶으면 아래 상수만 수정하면 된다.)
// ============================================================
const MMR_START = 100;
const MMR_MIN = 0;

const MMR_WIN_REDUCED = 15;          // 기권승 / 점수차 10 미만 신승
const MMR_WIN_BASE = 25;             // 점수차 10 이상 ~ 60 미만
const MMR_WIN_DOMINANT = 30;         // 점수차 60 이상 압승
const MMR_LOSE_REDUCED = -10;        // 기권패 / 점수차 10 미만 패배
const MMR_LOSE_BASE = -20;           // 점수차 10 이상 ~ 60 미만 패배
const MMR_LOSE_HEAVY = -25;          // 점수차 60 이상 완패

const MMR_CLOSE_MARGIN = 10;         // 이 값 미만 차이는 접전(신승/석패)
const MMR_DOMINANT_MARGIN = 60;      // 이 값 이상 차이면 압승/완패

const STREAK_BONUS_START = 3;        // 이 연승부터 보너스 시작
const STREAK_BONUS_STEP = 2;         // 연승 1회 증가당 추가 보너스
const STREAK_BONUS_MAX = 16;         // 보너스 상한 (10연승 이상 고정)

// 현재 연승 수(방금 이긴 판을 포함한 값)에 대한 보너스 MMR
function getStreakBonus(streak) {
  if (!Number.isFinite(streak) || streak < STREAK_BONUS_START) return 0;
  return Math.min(STREAK_BONUS_MAX, (streak - STREAK_BONUS_START + 1) * STREAK_BONUS_STEP);
}

// 승자 기본 점수 (연승 보너스 제외)
function getWinBase(scoreMargin, isNoContest) {
  if (isNoContest) return MMR_WIN_REDUCED;                    // 기권승(상대 이탈/부정행위 실격)
  if (scoreMargin >= MMR_DOMINANT_MARGIN) return MMR_WIN_DOMINANT;
  if (scoreMargin < MMR_CLOSE_MARGIN) return MMR_WIN_REDUCED;
  return MMR_WIN_BASE;
}

// 패자 기본 점수
function getLoseBase(scoreMargin, isNoContest) {
  if (isNoContest) return MMR_LOSE_REDUCED;                   // 기권패는 점수차와 무관하게 -10
  if (scoreMargin >= MMR_DOMINANT_MARGIN) return MMR_LOSE_HEAVY;
  if (scoreMargin < MMR_CLOSE_MARGIN) return MMR_LOSE_REDUCED;
  return MMR_LOSE_BASE;
}

// 한 판의 최종 MMR/연승 변동을 계산한다. (상태를 직접 바꾸지 않는 순수 함수)
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
      newRating: Math.max(MMR_MIN, loserRating + loseBase)   // 0점 밑으로 내려가지 않음
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

// ★ 단어 풀: 총 300개 (중복 없음). index.html의 WORD_POOL 배열과 반드시 동일해야 한다.
//   - 1~110번: 기존 단어 / 111~300번: 신규 추가 단어
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

// 안전장치: 단어 풀이 300개가 아니거나 중복이 있으면 서버 시작 시 경고를 출력한다.
if (timeModeWordPool.length !== 300 || new Set(timeModeWordPool).size !== timeModeWordPool.length) {
  console.warn(`[WordPool] 경고: 단어 수=${timeModeWordPool.length}, 고유 단어 수=${new Set(timeModeWordPool).size} (300개/중복 없음이어야 함)`);
}

const ALLOWED_TIME_DURATIONS = [30, 60, 120];
const DEFAULT_TIME_DURATION = 60;

// ★ 서버 주도 카운트다운: 3 -> 2 -> 1 -> START 를 서버가 1초 간격으로 직접 방송한다.
//   클라이언트 시계(Date.now)는 전혀 사용하지 않는다.
const COUNTDOWN_SECONDS = 3;
const COUNTDOWN_TICK_MS = 1000;

// ★ 랭크 해금에 필요한 일반전 승수. (일반전 3승 달성 시 경쟁전 해금)
const RANKED_UNLOCK_WINS = 3;

// ★ [v15] Net Chars 산정 방식.
//   클라이언트가 progress 이벤트에 `typed`(현재 화면에 입력되어 있는 문자열 전체)를 보내면,
//   서버가 room.text와 자리별로 직접 비교해서 netCorrect / charIndex를 계산한다.
//   → 입력 도중 맞게 쳤다가 Backspace로 지우고 틀리게 고친 글자는 점수에 포함되지 않는다.
//   false(기본): typed가 없는 옛 클라이언트는 기존처럼 클라이언트가 보낸 netCorrect를 사용 (구버전 호환, 버그 유지됨)
//   true: typed가 없는 progress는 통째로 무시 (index.html 수정 완료 후 켜는 것을 권장)
const REQUIRE_TYPED_SNAPSHOT = false;

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
const userStreaks = {};     // { socketId: 현재 Ranked 연승 수 }
const userNames = {};
const userAvatars = {};
const userNormalWins = {};
const accountNormalWins = {};
const waitingNormalPlayers = {}; // { matchKey: [socket, ...] } — 대기열 (동일 계정 매칭 방지 필터 적용)
const userTrophies = {};
const accountTrophies = {};
const accountRatings = {};
const accountStreaks = {};  // { playerId: 현재 Ranked 연승 수 } — 재접속해도 유지
const accountNames = {};

// ============================================================
// ★ [랭킹 시스템] 영구 저장(ranks.json) / 랭킹 등록 검증 / 어드민 API
// ============================================================
const crypto = require('crypto');
const fs = require('fs');

const RANKS_FILE = path.join(__dirname, 'ranks.json');

// ★ 어드민 비밀키: 배포 시 반드시 환경변수 ADMIN_SECRET 으로 교체할 것. (기본값은 테스트용)
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'admin123';
if (!process.env.ADMIN_SECRET) {
  console.warn('[Admin] 경고: ADMIN_SECRET 환경변수가 없어 기본값(admin123)을 사용 중입니다. 배포 전에 반드시 바꾸세요.');
}

// --- 랭킹 등록 검증 기준 (수치는 여기서만 수정) ---
const RANK_MAX_WPM = ANTICHEAT_MAX_WPM;     // 250 WPM 초과 기록은 등록 거부
const RANK_MIN_ELAPSED_MS = 10000;          // 너무 짧은 판(10초 미만)은 기록 등록 불가
const RANK_MIN_DELTAS = 30;                 // 키 간격 표본 최소 개수
const RANK_MAX_DELTAS = 5000;               // 비정상적으로 큰 배열 방어
const RANK_MIN_MEAN_INTERVAL_MS = ANTICHEAT_MIN_INTERVAL_MS; // 평균 간격이 이보다 짧으면 사람이 아님
const RANK_UNIFORM_STDDEV_MS = 8;           // 표준편차가 이 값 미만이면 "매크로처럼 일정한 속도"로 의심
const RANK_UNIFORM_MEAN_MAX_MS = 120;       // 위 판정은 평균 간격이 이 값 이하(충분히 빠를 때)만 적용
const RANK_CROSSCHECK_ENABLED = true;       // 간격 합계와 실제 경기 시간이 크게 안 맞으면 거부 (끄려면 false)
const RANK_PENDING_TTL_MS = 60000;          // 경기 종료 후 이 시간 안에 등록 요청해야 함

// 플레이어별 최고 기록: rankRecords[playerId] = { playerId, name, bests: { '30': {...}, '60': {...}, '120': {...} } }
const rankRecords = {};

// --- 파일 저장 / 불러오기 ---
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
    fs.renameSync(tmpFile, RANKS_FILE); // 쓰는 도중 서버가 꺼져도 기존 파일이 깨지지 않도록 임시파일 → 교체
  } catch (err) {
    console.error('[Ranks] 저장 실패:', err.message);
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
      console.log('[Ranks] ranks.json 없음 → 새로 시작합니다.');
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
    console.log(`[Ranks] ranks.json 불러옴: 계정 ${Object.keys(accountRatings).length}개, 기록 ${Object.keys(rankRecords).length}명`);
  } catch (err) {
    console.error('[Ranks] 불러오기 실패 (파일이 손상되었을 수 있음):', err.message);
  }
}

loadRanks();
setInterval(saveRanksNow, 30000); // 안전장치: 30초마다 자동 저장
['SIGINT', 'SIGTERM'].forEach((sig) => {
  process.on(sig, () => { saveRanksNow(); process.exit(0); });
});

// --- 랭킹 등록 검증 ---
// pending: endGame에서 서버가 직접 계산해 둔 기록 { wpm, grossWpm, elapsedMs, ... }
// rawDeltas: 클라이언트가 보낸 키 입력 간격(ms) 배열
function validateRankSubmission(pending, rawDeltas) {
  // 1) WPM 상한선 (서버 계산값 기준)
  if (pending.wpm > RANK_MAX_WPM || pending.grossWpm > RANK_MAX_WPM) {
    return { ok: false, code: 'WPM_LIMIT', message: `${RANK_MAX_WPM} WPM을 초과한 기록은 등록할 수 없습니다.` };
  }
  if (pending.elapsedMs < RANK_MIN_ELAPSED_MS) {
    return { ok: false, code: 'TOO_SHORT', message: '너무 짧은 경기는 랭킹에 등록할 수 없습니다.' };
  }

  // 2) 키 간격 배열 형식 검증
  if (!Array.isArray(rawDeltas) || rawDeltas.length < RANK_MIN_DELTAS || rawDeltas.length > RANK_MAX_DELTAS) {
    return { ok: false, code: 'INVALID_DELTAS', message: '키 입력 기록이 올바르지 않습니다.' };
  }
  if (!rawDeltas.every((d) => Number.isFinite(d) && d >= 0 && d < 10000)) {
    return { ok: false, code: 'INVALID_DELTAS', message: '키 입력 기록에 비정상 값이 있습니다.' };
  }

  // 3) 표본 개수가 실제 타수와 너무 동떨어지면(짧은 가짜 배열) 거부
  if (rawDeltas.length < pending.totalTyped * 0.5) {
    return { ok: false, code: 'DELTAS_MISMATCH', message: '키 입력 기록이 실제 입력 수와 맞지 않습니다.' };
  }

  const n = rawDeltas.length;
  const sum = rawDeltas.reduce((a, b) => a + b, 0);
  const mean = sum / n;

  // 4) 간격 합계가 실제 경기 시간과 너무 다르면 거부 (가짜 배열 방어)
  if (RANK_CROSSCHECK_ENABLED && (sum < pending.elapsedMs * 0.5 || sum > pending.elapsedMs * 1.5)) {
    return { ok: false, code: 'TIME_MISMATCH', message: '키 입력 시간이 경기 시간과 맞지 않습니다.' };
  }

  // 5) 사람이 칠 수 없는 평균 속도
  if (mean < RANK_MIN_MEAN_INTERVAL_MS) {
    return { ok: false, code: 'MACRO_MIN_INTERVAL', message: '비정상적으로 빠른 입력이 감지되었습니다.' };
  }

  // 6) 표준편차 검사: 빠른데 간격이 너무 일정하면 매크로로 의심
  const variance = rawDeltas.reduce((a, b) => a + (b - mean) * (b - mean), 0) / n;
  const stddev = Math.sqrt(variance);
  if (mean <= RANK_UNIFORM_MEAN_MAX_MS && stddev < RANK_UNIFORM_STDDEV_MS) {
    return { ok: false, code: 'MACRO_UNIFORM_TIMING', message: '입력 간격이 기계처럼 일정하여 등록이 거부되었습니다.' };
  }

  return { ok: true, mean, stddev };
}

// --- 어드민 API ---
app.use(express.json({ limit: '10kb' }));

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// 헤더 x-admin-secret 또는 body.secret 으로 키를 받는다.
function requireAdmin(req, res) {
  const provided = req.get('x-admin-secret') || (req.body && req.body.secret) || '';
  if (!provided || !safeEqual(provided, ADMIN_SECRET)) {
    console.warn(`[Admin] 인증 실패: ${req.ip} ${req.path}`);
    res.status(401).json({ success: false, message: 'Unauthorized' });
    return false;
  }
  return true;
}

// 접속 중인 소켓의 메모리 상 랭킹 값을 초기값으로 되돌리고 클라이언트에 반영한다.
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

// POST /api/admin/reset  — 전체 랭킹 초기화
app.post('/api/admin/reset', (req, res) => {
  if (!requireAdmin(req, res)) return;

  [rankRecords, accountRatings, accountTrophies, accountMonthlyTrophies, accountNormalWins, accountStreaks, accountPreResetRatings]
    .forEach((obj) => { Object.keys(obj).forEach((k) => delete obj[k]); });
  for (const socketId of io.sockets.sockets.keys()) resetOnlineSocketRanking(socketId);

  saveRanksNow();
  console.log('[Admin] 전체 랭킹 초기화 완료');
  res.json({ success: true, message: 'All rankings reset.' });
});

// POST /api/admin/delete  — 특정 플레이어 ID 랭킹 삭제   body: { "playerId": "Player #ABC123" }
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
  console.log(`[Admin] 플레이어 랭킹 삭제: ${playerId} (existed=${existed})`);
  res.json({ success: true, playerId, existed });
});

const ALLOWED_AVATARS = ['😀', '😎', '🤖', '🐱', '🐶', '🦊', '🐼', '🐵', '🔥', '⚡', '🎯', '🚀'];
const DEFAULT_AVATAR = ALLOWED_AVATARS[0];

// MMR이 0점일 때도 falsy 취급되어 1000으로 돌아가지 않도록, 항상 이 함수로 읽는다.
function getRating(socketId) {
  return Number.isFinite(userRatings[socketId]) ? userRatings[socketId] : MMR_START;
}

function getStreak(socketId) {
  return Number.isFinite(userStreaks[socketId]) ? userStreaks[socketId] : 0;
}

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
// ★ 랭킹 계산은 "현재 접속 중인 소켓" 단위가 아니라
//   "계정(playerId)" 단위로, 그리고 접속 여부와 무관하게
//   서버가 알고 있는 전체 계정 데이터(accountRatings 등)를 기준으로 계산한다.
//
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
      rating: Number.isFinite(userRatings[socketId]) ? userRatings[socketId] : (accountRatings[playerId] ?? MMR_START),
      trophies: Number.isFinite(userTrophies[socketId]) ? userTrophies[socketId] : (accountTrophies[playerId] ?? 0),
      wins: Number.isFinite(userNormalWins[socketId]) ? userNormalWins[socketId] : (accountNormalWins[playerId] ?? 0)
    });
  }

  // 2) 현재 접속하지 않은(오프라인) 계정도 영구 저장된 값 기준으로 포함시킨다.
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
const recentMatches = {}; // { roomId: { playerIds: [idA, idB], mode, duration, isRanked, isFriendly } } — 방금 끝난 경기 정보
const pendingRematches = {}; // { roomId: { accepted: Set<socketId>, timeoutId } } — 재경기 수락 대기 상태

function cleanupPendingRematch(roomId) {
  const pending = pendingRematches[roomId];
  if (pending) {
    clearTimeout(pending.timeoutId);
    delete pendingRematches[roomId];
  }
}

// --- Report System ---
const reportLogs = [];                 // 최근 신고 로그 (최대 1000건만 메모리에 보관)
const reportedInMatch = {};            // { roomId: Set<reporterPlayerId> } — 한 경기에서 한 명당 1회만 신고 가능
const reportCounts = {};               // { targetPlayerId: { total, uniqueReporters:Set, byReason:{}, lastReportedAt } }
const reportableMatches = {};          // { roomId: { players: { playerId: name } } } — 종료된 경기의 신고 가능 목록
const REPORTABLE_MATCH_TTL_MS = 10 * 60 * 1000;  // 경기 종료 후 10분 동안만 신고 가능
const REPORT_ALERT_THRESHOLDS = [3, 5, 10];       // 누적 신고가 이 횟수에 도달하면 서버 로그에 경고

// 신고 1건을 누적 집계에 반영하고, 갱신된 집계를 반환한다.
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

// GET /api/admin/reports — 누적 신고가 많은 순서 (헤더 x-admin-secret 필요)
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
  { min: 1600, label: '챌린저', color: '#f97316', icon: '🔥' },
  { min: 1300, label: '마스터', color: '#a855f7', icon: '👑' },
  { min: 1000, label: '다이아몬드', color: '#38bdf8', icon: '💎' },
  { min: 750, label: '플래티넘', color: '#14b8a6', icon: '💠' },
  { min: 500, label: '골드', color: '#e2b714', icon: '🥇' },
  { min: 300, label: '실버', color: '#c0c0c0', icon: '🥈' },
  { min: 150, label: '브론즈', color: '#cd7f32', icon: '🥉' },
  { min: -Infinity, label: '아이언', color: '#8b8f98', icon: '⛓️' }
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

// 대전(1v1) 텍스트와 연습 모드 텍스트 모두 이 함수를 통해 300개 단어 풀(timeModeWordPool)에서 무작위 추출된다.
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

function removeFromWaitingQueues(socket) {
  delete soloPracticeSessions[socket.id];
  Object.keys(waitingNormalPlayers).forEach((k) => {
    if (!Array.isArray(waitingNormalPlayers[k])) return;
    waitingNormalPlayers[k] = waitingNormalPlayers[k].filter((s) => s !== socket);
    if (waitingNormalPlayers[k].length === 0) delete waitingNormalPlayers[k];
  });
  // 랭크 대기열에 같은 소켓이 중복으로 들어가 있어도 전부 제거한다.
  for (let i = waitingRankedPlayers.length - 1; i >= 0; i--) {
    if (waitingRankedPlayers[i].socket === socket) waitingRankedPlayers.splice(i, 1);
  }
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
    deltaHistory: [],   // 최근 keystroke 간격(ms) 기록 (서버 메모리에만 보관, 검증용)
    fastStreak: 0,      // 연속으로 임계치 미만 간격이 발생한 횟수
    disqualified: false
  };
}

// ★ [v15] 현재 화면에 입력되어 있는 문자열(typed)에서 "실제로 올바른 위치에 올바른 글자로" 놓여 있는 글자 수를 센다.
//   - 과거에 맞게 쳤다가 지운(Backspace) 글자는 typed에 남아 있지 않으므로 절대 포함되지 않는다.
//   - 오타로 덮어쓴 자리는 typed[i] !== text[i] 이므로 포함되지 않는다.
//   - text 길이를 넘어선 입력은 무시한다.
function countCurrentCorrectChars(typed, text) {
  const limit = Math.min(typed.length, text.length);
  let correct = 0;
  for (let i = 0; i < limit; i++) {
    if (typed[i] === text[i]) correct++;
  }
  return correct;
}

// ★ [v15] sanitizeStat: 이제 sampleText(문자열 전체)를 받는다.
//   - data.typed(문자열)가 있으면: charIndex / netCorrect를 서버가 직접 계산 (클라이언트가 보낸 값은 무시)
//   - data.typed가 없으면: 구버전 호환용으로 클라이언트가 보낸 charIndex / netCorrect 사용 (REQUIRE_TYPED_SNAPSHOT=false일 때만)
//   - totalTyped / totalErrors / accuracy 는 "누적 통계"이므로 기존대로 클라이언트 값을 사용 (Net Chars 점수와는 무관)
function sanitizeStat(data, sampleText) {
  const sampleTextLength = sampleText.length;
  const accuracy = Number.isFinite(data.accuracy) ? Math.max(0, Math.min(100, data.accuracy)) : 100;
  const totalTyped = Number.isFinite(data.totalTyped) ? Math.max(0, Math.floor(data.totalTyped)) : 0;
  const totalErrors = Number.isFinite(data.totalErrors) ? Math.max(0, Math.floor(data.totalErrors)) : 0;

  if (typeof data.typed === 'string') {
    const typed = data.typed.slice(0, sampleTextLength); // 비정상적으로 긴 문자열 방어
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

// 지속 최고 속도(WPM) 제한 감지 — START 신호를 보낸 시각(room.startTime) 기준 누적 타수로 계산.
function detectSpeedLimit(player, room) {
  if (!room.started || !Number.isFinite(room.startTime)) return null;
  if (player.totalTyped < ANTICHEAT_MAX_WPM_MIN_CHARS) return null;
  const elapsedMs = Date.now() - room.startTime;
  if (elapsedMs <= 0) return null;
  const minutes = elapsedMs / 60000;
  const wpm = (player.totalTyped / 5) / minutes;
  return wpm >= ANTICHEAT_MAX_WPM ? 'SPEED_LIMIT_EXCEEDED' : null;
}

// 감지된 부정행위자를 즉시 몰수패 처리한다. endGame을 그대로 재사용하므로
// 상대는 (Casual이면 트로피/정상승수, Ranked라면 MMR)까지 일반 승리와 동일하게 정산된다.
// (친선 매치는 endGame 안에서 어떤 보상도 정산되지 않는다.)
function disqualifyPlayer(roomId, cheaterId, reasonCode) {
  const room = rooms[roomId];
  if (!room || room.ended) return;
  const winnerId = Object.keys(room.players).find((id) => id !== cheaterId) || null;
  console.log(`[Anti-Cheat] Disqualified in room ${roomId}: player=${cheaterId} reason=${reasonCode}`);
  endGame(roomId, winnerId, { reason: 'cheat_detected', cheatReason: reasonCode, cheaterId });
}

// ============================================================
// ★ 서버 주도 카운트다운
//   - 방 안의 "두 플레이어 소켓"에게만 직접 emit 한다.
//     (io.to(roomId)를 쓰면 커스텀룸 코드가 재사용될 때 이전 경기 소켓이 섞일 수 있음)
//   - 1초 간격으로 { value: 3 } -> { value: 2 } -> { value: 1 } -> { value: 'START' }
//   - START를 보내는 그 시점에 room.started = true, room.startTime 기록, 종료 타이머 시작.
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

    // ★ START — 양쪽 클라이언트가 동시에 입력창을 열고 타이머를 시작한다.
    stopCountdown(r);
    r.started = true;
    r.startTime = Date.now(); // 서버 내부 기록용 (Anti-Cheat WPM 계산에만 사용)
    emitToRoomPlayers(r, 'countdownTick', { value: 'START' });

    // 종료 타이머는 START 시점부터 duration 만큼
    r.endTimeoutId = setTimeout(() => endGame(roomId, undefined), r.duration * 1000);
  }, COUNTDOWN_TICK_MS);
}

// isFriendly: true면 친선(커스텀 룸 / 친선 재경기) 매치. 트로피·MMR·연승·일반전 승수 모두 변동 없음.
function startMatch(playerA, playerB, mode, duration, isRanked, customRoomId, isFriendly) {
  // ★ 친선 여부는 오직 boolean true만 인정한다.
  isFriendly = isFriendly === true;
  // ★ 랭크 여부를 엄격한 boolean으로 고정한다. (true 외에는 전부 Casual) 친선은 무조건 Ranked 아님.
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
    isFriendly,              // ★ 친선(연습) 매치: 트로피/MMR/승수 일절 변동 없음 (서버 내부 전용)
    invalidated,
    started: false,          // ★ START 신호 전송 후 true
    startTime: null,         // ★ START 신호 전송 시각 (서버 내부용)
    countdownTimerId: null,
    endTimeoutId: null, ended: false, players: {},
    // ★ 소켓이 이미 끊긴 뒤에 endGame이 호출돼도(이탈 몰수패) 계정에 MMR/연승/트로피를 저장할 수 있도록
    //   매치 시작 시점의 { socketId: playerId } 를 방에 보관해 둔다.
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
  // 매치 시작 시점 기준 전역 순위 (100위 밖이면 null)
  const rankA = getPlayerRankInfo(playerA.id, isRanked ? 'rating' : 'trophy');
  const rankB = getPlayerRankInfo(playerB.id, isRanked ? 'rating' : 'trophy');

  // ★ gameStart는 "셋업" 신호다. startTime은 더 이상 보내지 않는다.
  //   실제 시작 시점은 이후 countdownTick의 'START'가 결정한다.
  // ★ [v19] 친선도 클라이언트에는 "일반전(Casual)"으로만 보인다. isFriendly는 서버 내부 전용이며 클라이언트로 보내지 않는다.
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

  // ★ 서버가 1초 간격으로 3 -> 2 -> 1 -> START 방송
  runServerCountdown(roomId);
}

function endGame(roomId, forcedWinnerId, options = {}) {
  const room = rooms[roomId];
  if (!room || room.ended) return;
  room.ended = true;
  clearTimeout(room.endTimeoutId);
  stopCountdown(room); // ★ 카운트다운 도중 종료(이탈 등)되면 틱 방송을 멈춘다
  const reason = options.reason || null; // 'forfeit', 'cheat_detected' 등 — 클라이언트에 전달
  const cheatReason = options.cheatReason || null;
  const cheaterId = options.cheaterId || null;

  // ★ 이 판이 Ranked인지 / 친선인지 / 일반전(Casual)인지 판정한다.
  //   - 친선(커스텀 룸): 트로피·MMR·연승·일반전 승수 전부 변동 없음 (순수 연습)
  const isRankedMatch = isRankedFlag(room.isRanked);
  const isFriendlyMatch = room.isFriendly === true;
  const isCasualMatch = !isRankedMatch && !isFriendlyMatch;

  // ★ MMR/연승 변동 적용 여부: Ranked는 항상, Casual은 CASUAL_MMR_ENABLED가 true일 때만. 친선은 절대 아님.
  //   트로피는 이 값과 무관하게 Casual에서만 정산된다. (Ranked/친선은 트로피 변동 없음)
  const mmrApplies = !isFriendlyMatch && (isRankedMatch || CASUAL_MMR_ENABLED);

  const ids = Object.keys(room.players);
  let winnerId = forcedWinnerId;

  if (winnerId === undefined) {
    const [id1, id2] = ids;
    const p1 = room.players[id1];
    const p2 = room.players[id2];

    // ★ [v15] netCorrect는 progress 수신 시점마다 "현재 화면 기준"으로 재계산된 값이다.
    //   (누적 정타 수가 아니므로, 지웠다가 틀리게 고친 글자는 여기에 반영되지 않는다.)
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

  // --- MMR(레이팅) + 연승 정산: Ranked 전용 (CASUAL_MMR_ENABLED=true면 Casual도 포함) ---
  //   mmrResults[id] = 클라이언트에 내려줄 "완결된" 결과 (변동 없음이면 diff 0 / streak는 현재값)
  const ratingChanges = {};
  const mmrResults = {};
  if (mmrApplies) {
    ids.forEach((id) => {
      const cur = getRating(id);
      mmrResults[id] = { old: cur, new: cur, diff: 0, baseChange: 0, streakBonus: 0, streak: getStreak(id) };
    });

    if (!room.invalidated && winnerId !== null) {
      const loserId = ids.find((id) => id !== winnerId);

      // 점수차 = 두 플레이어 netCorrect(순 정타 글자 수) 차이
      const scoreOf = (pid) => (Number.isFinite(room.players[pid].netCorrect) ? room.players[pid].netCorrect : 0);
      const scoreMargin = Math.abs(scoreOf(winnerId) - scoreOf(loserId));
      // 기권/이탈/부정행위 실격으로 끝난 판은 "기권승/기권패"로 취급
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
      userStreaks[loserId] = 0; // 패배/기권 시 연승 리셋

      mmrResults[winnerId] = {
        old: oldWinner, new: calc.winner.newRating, diff: calc.winner.newRating - oldWinner,
        baseChange: calc.winner.baseChange, streakBonus: calc.winner.streakBonus, streak: calc.winner.newStreak
      };
      mmrResults[loserId] = {
        old: oldLoser, new: calc.loser.newRating, diff: calc.loser.newRating - oldLoser, // 0점 하한이 걸리면 실제 반영값
        baseChange: calc.loser.baseChange, streakBonus: 0, streak: 0
      };
    }

    ids.forEach((id) => {
      const r = mmrResults[id];
      ratingChanges[id] = { old: r.old, new: r.new, diff: r.diff };
    });
  }

  // --- 일반전 승수(랭크 해금용): Casual에서만 카운트. (친선/Ranked는 제외) ---
  let winnerUnlock = null;
  if (isCasualMatch && !room.invalidated && winnerId !== null) {
    const winnerSocket = io.sockets.sockets.get(winnerId);
    if (winnerSocket) winnerUnlock = addNormalWin(winnerSocket);
  }

  // --- 트로피 정산: ★ Casual(일반전) 전용. Ranked/친선은 트로피가 절대 변동하지 않는다. ---
  //   - Casual: 승 +10 / 패 0 / 무 0 (getCasualTrophyChange)
  //   - Ranked: 승/패/무 모두 0 (MMR/연승만 변동)
  //   - 친선: 승/패/무/기권 모두 0, 저장/이벤트 전송도 하지 않는다 (기존 데이터 보호)
  //           → 결과 화면에는 { old, new: old, diff: 0 } 이 내려가서 "+0 Trophies (Total 현재값)"으로 표시된다.
  //   - 0 미만으로 내려가지 않도록 하한 처리 (diff는 실제로 반영된 값 기준)
  //   - 같은 계정끼리 붙은 판(invalidated)은 보상 무효 (diff 0)
  const trophyChanges = {};
  ids.forEach((id) => {
    const oldTrophies = userTrophies[id] || 0;

    // ★ 친선: 트로피 값 / 계정 저장 / trophyUpdate 이벤트 모두 건드리지 않는다.
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
      // 결과 화면 외의 UI(로비 헤더 등)도 즉시 최신 트로피로 갱신되도록 별도 이벤트도 보낸다.
      playerSocketForTrophy.emit('trophyUpdate', { trophies: newTrophies });
    } else {
      // 이탈(disconnect)로 소켓이 이미 사라진 경우에도 계정에는 반드시 저장한다.
      const pid = room.accountIds && room.accountIds[id];
      if (pid) {
        accountTrophies[pid] = newTrophies;
        accountMonthlyTrophies[pid] = newTrophies;
      }
    }
  });
  if (room.invalidated) console.log(`[Anti-Abuse] Match rewards invalidated: ${roomId}`);

  // MMR/연승 영구 저장: MMR이 적용된 판에서만 수행한다.
  //   소켓이 이미 끊긴 이탈자(패자)도 저장되도록 room.accountIds(playerId)를 기준으로 기록한다.
  //   (이걸 소켓 기준으로만 저장하면, 지고 나서 튕기는 방식으로 MMR 하락/연승 리셋을 피할 수 있다)
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

  // [진단 로그] 이 판이 Ranked/친선이었는지, 트로피/MMR 변동이 얼마였는지 서버 콘솔에서 바로 확인할 수 있다.
  console.log(`[EndGame] room=${roomId} isRanked=${isRankedMatch} isFriendly=${isFriendlyMatch} invalidated=${!!room.invalidated} reason=${reason} netCorrect=${JSON.stringify(Object.fromEntries(ids.map((id) => [id, room.players[id].netCorrect])))} trophyDiffs=${JSON.stringify(Object.fromEntries(ids.map((id) => [id, trophyChanges[id] ? trophyChanges[id].diff : null])))} mmr=${mmrApplies ? JSON.stringify(Object.fromEntries(ids.map((id) => [id, { diff: mmrResults[id].diff, streak: mmrResults[id].streak, bonus: mmrResults[id].streakBonus }]))) : 'n/a'}`);

  ids.forEach((id) => {
    const oppId = ids.find((x) => x !== id);
    const playerSocket = io.sockets.sockets.get(id);
    const oppSocket = io.sockets.sockets.get(oppId);
    const oppPlayerId = oppSocket && oppSocket.data ? oppSocket.data.playerId : null;
    const mmrRes = mmrApplies ? mmrResults[id] : null;

    // ★ [v19] 친선은 무조건 0 / 기존 트로피 그대로. 값 자체를 여기서 한 번 더 고정한다.
    const tc = trophyChanges[id];
    const sentTrophyChange = isFriendlyMatch ? 0 : tc.diff;
    const sentTotalTrophies = isFriendlyMatch ? tc.old : tc.new;

    io.to(id).emit('gameOver', {
      result: winnerId === null ? 'draw' : (winnerId === id ? 'win' : 'lose'),
      myStats: room.players[id],
      opponentStats: room.players[oppId],
      // MMR이 적용되지 않은 판(기본 설정의 Casual, 친선)은 ratingData가 null (기존 클라이언트 호환용 { old, new, diff })
      ratingData: mmrRes ? (ratingChanges[id] || null) : null,
      // ★ 완결된 MMR 변동량 + 연승 상태 (Ranked 전용, Casual/친선이면 mmrChange 0 / mmrData null)
      mmrApplied: !!mmrRes,
      mmrChange: mmrRes ? mmrRes.diff : 0,            // 실제 반영된 MMR 변동량 (+15, -10, +30 ...)
      mmrData: mmrRes ? {
        old: mmrRes.old,
        new: mmrRes.new,
        diff: mmrRes.diff,
        baseChange: mmrRes.baseChange,                // 연승 보너스를 제외한 기본 승패 점수
        streakBonus: mmrRes.streakBonus               // 이번 판에 붙은 연승 보너스 (0 / +2 ~ +16)
      } : null,
      streak: mmrRes ? mmrRes.streak : getStreak(id), // 이 판 이후의 현재 Ranked 연승 수 (패배 시 0)
      streakBonus: mmrRes ? mmrRes.streakBonus : 0,   // MMR 연승 보너스 (Ranked 전용)
      // ★ 트로피 데이터는 항상 내려가지만, Ranked/친선 판에서는 diff가 항상 0이다: { old, new, diff }
      trophyData: { old: tc.old, new: sentTotalTrophies, diff: sentTrophyChange },
      trophyChange: sentTrophyChange,         // 친선: 항상 0 (Casual: +10 / 0, Ranked: 0)
      totalTrophies: sentTotalTrophies,       // 친선: 기존 트로피 그대로
      unlock: playerSocket ? unlockPayload(playerSocket) : null,
      justUnlocked: !!(winnerUnlock && winnerId === id && winnerUnlock.justUnlocked),
      invalidated: !!room.invalidated,
      opponentId: oppPlayerId,
      opponentName: userNames[oppId] || 'Opponent',
      reason: reason,
      cheatReason: cheatReason,
      disqualified: cheaterId === id,
      roomId: roomId,
      isRanked: isRankedMatch,                // 친선: 항상 false
      isCasual: !isRankedMatch,               // 친선도 일반전과 같은 결과 화면
      // ★ [v19] isFriendly 는 클라이언트로 보내지 않는다 (UI 분기 원천 차단). 재경기 판정은 recentMatches 에서 서버가 처리.
      showRecord: true                        // WIN / LOSE 및 Trophies 줄을 항상 표시
    });
  });

  // ★ [랭킹 등록 대기] 서버가 가진 값만으로 이 판의 기록(WPM)을 계산해 소켓에 1회용으로 보관한다.
  //   - 친선 / 같은 계정 매치 / 기권·이탈·부정행위 종료 / START 이전 종료는 등록 대상이 아니다.
  //   - 클라이언트는 이후 'submitRank' 로 roomId + deltas(키 간격 배열)만 보낸다. WPM은 클라이언트 값을 쓰지 않는다.
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
      wpm: Math.round(((netCorrect / 5) / minutes) * 10) / 10,          // 순 WPM (정타 기준)
      grossWpm: Math.round(((p.totalTyped / 5) / minutes) * 10) / 10,   // 총 타수 기준 WPM (검증용)
      createdAt: Date.now()
    };
  });
  scheduleRanksSave(); // 이번 판의 MMR/트로피/승수 변동을 ranks.json에 반영

  // ★ [v17] 끝난 방의 roomId가 소켓에 남아 다른 판(재사용된 방 ID 등)과 엮이지 않도록 정리한다.
  ids.forEach((id) => {
    const s = io.sockets.sockets.get(id);
    if (s && s.data && s.data.roomId === roomId) s.data.roomId = null;
  });

  // 재경기 요청을 위해 방금 끝난 매치업 정보를 잠시 보관한다 (양쪽 모두 연결 상태일 때만).
  if (ids.every((id) => { const s = io.sockets.sockets.get(id); return s && s.connected; })) {
    recentMatches[roomId] = { playerIds: ids.slice(), mode: room.mode, duration: room.duration, isRanked: isRankedMatch, isFriendly: isFriendlyMatch };
    setTimeout(() => { delete recentMatches[roomId]; }, RECENT_MATCH_TTL_MS);
  }

  // ★ [신고] 이 판의 참가자(playerId)를 신고 가능 목록에 등록한다. (종료 후 10분)
  //   신고 대상은 클라이언트가 보낸 값이 아니라 여기 기록된 "상대 계정"으로 서버가 결정한다.
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

  delete rooms[roomId];
}

function sendInitUser(socket) {
  const rankTag = buildRankTagForSocket(socket.id);
  const baseName = (userNames[socket.id] || '').replace(/\[[^\]]*\]\s*/g, '').trim();
  userNames[socket.id] = appendDynamicTag(baseName, rankTag);
  socket.emit('initUser', {
    playerId: socket.data.playerId || null, // 클라이언트가 localStorage에 그대로 저장할 확정 ID
    rating: getRating(socket.id),
    streak: getStreak(socket.id),           // 현재 Ranked 연승 수
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
    // MMR이 0점이어도 falsy로 취급되어 1000으로 되돌아가지 않도록 Number.isFinite로 판정한다.
    userRatings[socket.id] = Number.isFinite(accountRatings[playerId]) ? accountRatings[playerId] : getRating(socket.id);
    userStreaks[socket.id] = Number.isFinite(accountStreaks[playerId]) ? accountStreaks[playerId] : 0;
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
    // ★ 기존 대기 흔적 제거: 취소 없이 다시 선택하거나 연타해도 같은 소켓이 큐에 중복 등록되지 않는다.
    removeFromWaitingQueues(socket);

    // ★ 오직 boolean true 만 Ranked. 그 외 값(문자열 "false", 1, undefined 등)은 전부 Casual.
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
        startMatch(opponent, socket, mode, duration, false);
        clearPracticeSession(socket.id);
        clearPracticeSession(opponent.id);
      } else {
        queue.push(socket);
        socket.emit('waiting', { isRanked: false });
      }
    }
  });

  // ★ 일반/랭크 매칭 대기 취소 (클라이언트: emit('cancelSearch'))
  //   대기열(일반/랭크)에서 이 소켓을 완전히 제거한다.
  socket.on('cancelSearch', () => {
    removeFromWaitingQueues(socket);
    socket.emit('matchmakingCancelled');
  });

  socket.on('progress', (data) => {
    const room = rooms[socket.data.roomId];
    if (!room || room.ended) return;
    // ★ START 신호 전에 들어온 입력은 무시한다 (카운트다운 중 선입력/조작 방지)
    if (!room.started) return;
    const player = room.players[socket.id];
    if (!player || player.finished || player.disqualified) return;

    // ★ [v15] typed 스냅샷이 있으면 서버가 charIndex / netCorrect를 현재 화면 기준으로 직접 계산한다.
    const stat = sanitizeStat(data || {}, room.text);
    if (REQUIRE_TYPED_SNAPSHOT && !stat.hasTypedSnapshot) return;

    const { accuracy, charIndex, netCorrect, totalTyped, totalErrors } = stat;

    // percent는 charIndex 기반으로 서버에서 재계산해 클라이언트 위조/오차를 방지한다.
    const percent = room.text.length > 0
      ? Math.min(100, Math.floor((charIndex / room.text.length) * 100))
      : 0;

    player.percent = percent;
    player.charIndex = charIndex;
    player.netCorrect = netCorrect; // ★ [v15] 현재 화면에 올바르게 입력되어 있는 글자 수 (누적값 아님 → 감소할 수 있음)
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
    // ★ 커스텀 룸은 항상 친선(연습). 클라이언트가 isRanked를 보내도 무시한다.
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

    // ★ 커스텀룸도 일반 매치와 동일하게 서버 주도 카운트다운(countdownTick)을 사용한다.
    //   기존처럼 3초를 별도로 기다린 뒤 startMatch를 호출하면 카운트다운이 이중(3초 + 3초)이 되므로,
    //   여기서는 화면 전환 신호만 보내고 즉시 매치를 시작한다.
    io.to(code).emit('customRoomCountdown', { seconds: COUNTDOWN_SECONDS });

    const [host, guest] = customRooms[code].players;
    delete customRooms[code];
    // ★ [v17] 방 코드를 그대로 roomId로 쓰면 코드가 재사용될 때 이전 판 소켓/재경기/신고 기록과 섞일 수 있다.
    //   → 매 판마다 고유한 roomId를 사용한다. (방 코드는 대기실 용도로만 쓰인다)
    const friendlyRoomId = `friendly_${code}_${Date.now()}`;
    host.leave(code);
    guest.leave(code);
    host.data.customRoomCode = null;
    guest.data.customRoomCode = null;
    // ★ 커스텀 룸은 친선(연습) 매치: isRanked=false, isFriendly=true 고정
    //   → 승/패/기권 상관없이 트로피·MMR·연승·일반전 승수 전부 변동 없음
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
        rating: getRating(socket.id),
        trophies: accountMonthlyTrophies[myId] || userTrophies[socket.id] || 0,
        isMe: true
      });
    }

    socket.emit('leaderboardData', { sortBy, entries: entries.slice(0, 50) });
  });

  // ★ 신고 접수: 클라이언트 → { roomId?: string, reason?: 'cheating' }
  //   신고 대상은 서버가 "그 경기의 상대"로 직접 결정한다. (클라이언트가 보낸 대상 ID는 사용하지 않음)
  //   - roomId 생략(경기 중) 시 현재 내 방을 사용한다.
  //   - 사유는 핵/매크로 의심('cheating')으로 단일화되어 있다.
  socket.on('reportMatch', (data) => {
    data = data || {};
    const reply = (payload) => socket.emit('reportResult', payload);
    console.log(`[Reported] 요청 수신: socket=${socket.id} player=${socket.data && socket.data.playerId} roomId=${data.roomId}`);
    const reporterId = socket.data && socket.data.playerId;

    if (!reporterId) {
      return reply({ success: false, code: 'NOT_IDENTIFIED', message: '접속 정보를 확인할 수 없습니다.' });
    }

    // 1) 신고할 경기 확인: 진행 중이면 현재 방, 종료됐으면 reportableMatches(10분 이내)
    const roomId = (typeof data.roomId === 'string' && data.roomId) ? data.roomId : (socket.data.roomId || null);
    let participants = null; // { playerId: name }
    const liveRoom = roomId ? rooms[roomId] : null;
    if (liveRoom && liveRoom.isFriendly === true) {
      return reply({ success: false, code: 'FRIENDLY_MATCH', message: '친선 경기는 신고할 수 없습니다.' });
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
      return reply({ success: false, code: 'NO_MATCH', message: '신고할 수 있는 경기가 없습니다. (경기 종료 후 10분 이내만 가능)' });
    }

    // 2) 신고 대상 = 이 경기의 상대방
    const targetId = Object.keys(participants).find((pid) => pid !== reporterId);
    if (!targetId) {
      return reply({ success: false, code: 'NO_TARGET', message: '신고할 상대를 찾을 수 없습니다.' });
    }

    // 3) 한 경기에서 한 명당 1회
    if (!reportedInMatch[roomId]) reportedInMatch[roomId] = new Set();
    if (reportedInMatch[roomId].has(reporterId)) {
      return reply({ success: false, code: 'ALREADY_REPORTED', message: '이 경기는 이미 신고했습니다.', roomId });
    }
    reportedInMatch[roomId].add(reporterId);

    const reportEntry = {
      timestamp: new Date().toISOString(),
      reporterId,
      reporterName: (userNames[socket.id] || reporterId).replace(/\[[^\]]*\]\s*/g, '').trim(),
      targetId,
      targetName: participants[targetId] || targetId,
      roomId,
      reason: 'cheating'   // 사유는 핵/매크로 의심으로 단일화
    };

    reportLogs.push(reportEntry);
    if (reportLogs.length > 1000) reportLogs.shift();

    // 4) 누적 집계 + [Reported] 로그
    const counts = registerReport(reportEntry);
    console.log(`[Reported] ${reportEntry.reporterName}(${reporterId}) → ${reportEntry.targetName}(${targetId}) reason=cheating room=${roomId} | 누적 ${counts.total}회 (고유 신고자 ${counts.uniqueReporters.size}명)`);
    if (REPORT_ALERT_THRESHOLDS.includes(counts.total)) {
      console.warn(`[Reported][ALERT] ${targetId} 누적 신고 ${counts.total}회 도달 (고유 신고자 ${counts.uniqueReporters.size}명) → 확인 필요`);
    }

    sendDiscordReportWebhook(reportEntry);

    reply({ success: true, code: 'OK', message: '신고가 접수되었습니다.', roomId });
  });

  // ★ 랭킹 기록 등록: 클라이언트 → { roomId, deltas:[ms,...] }
  //   결과는 'rankSubmitResult' 로 { success, code, message, isNewBest, wpm, accuracy, duration } 가 내려간다.
  socket.on('submitRank', (data) => {
    data = data || {};
    const reply = (payload) => socket.emit('rankSubmitResult', payload);
    const pid = socket.data && socket.data.playerId;
    const pending = socket.data && socket.data.pendingRank;

    if (!pid || !pending || Date.now() - pending.createdAt > RANK_PENDING_TTL_MS) {
      socket.data.pendingRank = null;
      return reply({ success: false, code: 'NO_PENDING', message: '등록할 수 있는 경기 기록이 없습니다.' });
    }
    if (data.roomId !== pending.roomId) {
      return reply({ success: false, code: 'ROOM_MISMATCH', message: '경기 정보가 일치하지 않습니다.' });
    }
    socket.data.pendingRank = null; // 1회용: 성공/실패와 무관하게 재시도 불가

    const check = validateRankSubmission(pending, data.deltas);
    if (!check.ok) {
      console.log(`[RankSubmit] 거부: ${pid} code=${check.code} wpm=${pending.wpm} gross=${pending.grossWpm}`);
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
      saveRanksNow(); // 새 최고 기록은 즉시 파일에 저장
    }

    console.log(`[RankSubmit] 등록: ${pid} ${key}s wpm=${pending.wpm} newBest=${isNewBest}`);
    reply({
      success: true,
      isNewBest,
      wpm: pending.wpm,
      accuracy: pending.accuracy,
      duration: pending.duration,
      bestWpm: record.bests[key].wpm
    });
  });

  // ★ WPM 랭킹 조회: 클라이언트 → { duration: 30|60|120 }  /  응답: 'wpmLeaderboardData'
  socket.on('requestWpmLeaderboard', (data) => {
    data = data || {};
    const duration = ALLOWED_TIME_DURATIONS.includes(data.duration) ? data.duration : DEFAULT_TIME_DURATION;
    const key = String(duration);
    const myId = socket.data && socket.data.playerId;

    const entries = Object.values(rankRecords)
      .filter((r) => r.bests && r.bests[key])
      .sort((a, b) => {
        if (b.bests[key].wpm !== a.bests[key].wpm) return b.bests[key].wpm - a.bests[key].wpm;
        return String(a.bests[key].achievedAt).localeCompare(String(b.bests[key].achievedAt)); // 동률이면 먼저 달성한 사람
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
    // ★ [v17] 이 방의 참가자가 아니면(다른 판의 방 ID가 남아 있는 경우 등) 절대 처리하지 않는다.
    if (!room || room.ended || !room.players[socket.id]) return;
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
        // 재경기는 직전 경기와 동일한 종류(Casual / Ranked / 친선)를 그대로 이어받는다.
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
    // ★ [v17] 이 방의 참가자가 맞을 때만 몰수패 처리 (다른 판의 방을 잘못 종료시키지 않도록)
    if (room && !room.ended && room.players[socket.id]) {
      const remainingId = Object.keys(room.players).find((id) => id !== socket.id);
      if (remainingId) {
        // 남은 플레이어에게 몰수승(forfeit win) 처리.
        // endGame을 그대로 재사용한다. (Casual이면 트로피/일반전 승수, Ranked라면 MMR/연승 정산,
        // 친선이면 아무것도 정산하지 않는다. 카운트다운 타이머도 endGame에서 정리됨)
        endGame(roomId, remainingId, { reason: 'forfeit' });
      } else {
        clearTimeout(room.endTimeoutId);
        stopCountdown(room);
        delete rooms[roomId];
      }
    }

    // ★ 소켓 기준으로 남아있던 임시 랭킹 데이터(userRatings 등)는 계정(playerId)에
    //   이미 저장되어 있으므로, 소켓 자체 항목은 정리한다.
    delete userRatings[socket.id];
    delete userStreaks[socket.id];
    delete userNames[socket.id];
    delete userAvatars[socket.id];
    delete userNormalWins[socket.id];
    delete userTrophies[socket.id];
  });
});

server.listen(PORT, () => console.log(`서버 실행 중: http://localhost:${PORT} [build: ${BUILD_ID}]`));