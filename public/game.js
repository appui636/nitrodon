// ========================
// IntroDone! Online - game.js
// ========================

const COOKIE_NICKNAME_KEY = 'introdone_nickname';
const COOKIE_EXPIRE_DAYS = 365;

// --- State ---
let ws = null;
let myId = null;
let myNickname = null;
let myRoomKey = null;
let isHost = false;
let currentRoom = null;
let gameState = 'lobby';
let myLastAnswers = [];
let audioPlayTimer = null;
let audioStartTime = 0;
let audioDuration = 0;
let currentQuestion = null;
let totalQuestions = 0;
let currentQIndex = 0;
let buzzerEnabled = false;
let amAnswering = false;
let selectedCategories = new Set(['ALL']);

// ブラウザのautoplay制限を解除するためのフラグ
// ユーザーが何らかの操作をしたらtrueになる
let userInteracted = false;

function ensureUserInteracted() {
  if (!userInteracted) {
    userInteracted = true;
    // 無音の短いaudioを再生してaudioコンテキストをアクティブにする
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const buf = ctx.createBuffer(1, 1, 22050);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      src.start(0);
      src.stop(0.001);
      ctx.close();
    } catch (e) { /* ignore */ }
  }
}

// --- Cookie helpers ---
function setCookie(name, value, days) {
  const expires = new Date(Date.now() + days * 864e5).toUTCString();
  document.cookie = `${name}=${encodeURIComponent(value)}; expires=${expires}; path=/`;
}
function getCookie(name) {
  const val = document.cookie.match('(^|;)\\s*' + name + '\\s*=\\s*([^;]+)');
  return val ? decodeURIComponent(val.pop()) : null;
}

// --- Screen management ---
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById(id);
  if (el) el.classList.add('active');
  // Derive state from screen id: 'screenGame' -> 'game', 'screenAnswerReveal' -> 'answerreveal'
  gameState = id.replace(/^screen/, '').toLowerCase();
  // Scroll to top on screen change
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// --- Toast ---
function toast(msg, type = 'info', duration = 3000) {
  const container = document.getElementById('toastContainer');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => el.remove(), duration);
}

// --- Flash overlay ---
function flashOverlay(type) {
  const el = document.getElementById('resultFlash');
  el.className = `result-flash ${type} show`;
  setTimeout(() => el.classList.remove('show'), 400);
}

// --- WebSocket ---
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}`);

  ws.onopen = () => {
    console.log('WS connected');
  };

  ws.onmessage = (evt) => {
    let msg;
    try { msg = JSON.parse(evt.data); } catch { return; }
    handleServerMessage(msg);
  };

  ws.onerror = (e) => {
    console.error('WS error:', e);
    toast('通信エラーが発生しました', 'error');
  };

  ws.onclose = () => {
    console.log('WS closed');
    // Reconnect after 3 seconds
    setTimeout(connectWS, 3000);
  };
}

function send(msg) {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify(msg));
  }
}

// --- Message handling ---
function handleServerMessage(msg) {
  console.log('Received:', msg.type);

  switch (msg.type) {
    case 'connected':
      myId = msg.id;
      init();
      break;

    case 'nickname_set':
      myNickname = msg.nickname;
      document.getElementById('displayNickname').textContent = myNickname;
      showScreen('screenLobby');
      break;

    case 'room_created':
      myRoomKey = msg.roomKey;
      isHost = true;
      // 修正: settings がない場合は デフォルト値を使用
      const createdSettings = msg.settings || { questionCount: 10, extraSeconds: 0, categories: ['ALL'] };
      setupRoomScreen(msg.players, createdSettings, msg.roomKey, true);
      loadCategories(msg.categories);
      showScreen('screenRoom');
      break;

    case 'room_joined':
      myRoomKey = msg.roomKey;
      isHost = false;
      // 修正: settings がない場合は デフォルト値を使用
      const joinedSettings = msg.settings || { questionCount: 10, extraSeconds: 0, categories: ['ALL'] };
      setupRoomScreen(msg.players, joinedSettings, msg.roomKey, false);
      showScreen('screenRoom');
      break;

    case 'player_joined':
      updatePlayerList('waitingPlayerList', msg.players);
      updatePlayerCount(msg.players);
      toast(`${msg.nickname} が参加しました`, 'info');
      break;

    case 'player_left':
      updatePlayerList('waitingPlayerList', msg.players);
      updatePlayerCount(msg.players);
      toast('プレイヤーが退室しました', 'info');
      break;

    case 'settings_updated':
      updateSettingsSummary(msg.settings);
      updatePlayerList('waitingPlayerList', msg.players);
      break;

    case 'game_starting':
      startCountdown(msg.countdown);
      break;

    case 'question_start':
      currentQuestion = { ...msg };
      currentQIndex = msg.questionIndex;
      totalQuestions = msg.totalQuestions;
      myLastAnswers = myLastAnswers || [];
      startQuestion(msg);
      break;

    case 'buzzer_pressed':
      onBuzzerPressed(msg);
      break;

    case 'answer_result':
      onAnswerResult(msg);
      break;

    case 'question_timeout':
      onQuestionTimeout(msg);
      break;

    case 'game_end':
      onGameEnd(msg);
      break;

    case 'room_reset':
      myLastAnswers = [];
      // 修正: settings がない場合は デフォルト値を使用
      const resetSettings = msg.settings || { questionCount: 10, extraSeconds: 0, categories: ['ALL'] };
      setupRoomScreen(msg.players, resetSettings, myRoomKey, isHost);
      showScreen('screenRoom');
      break;

    case 'room_dissolved':
      toast('部屋が解散されました', 'error');
      myRoomKey = null;
      isHost = false;
      showScreen('screenLobby');
      break;

    case 'error':
      toast(msg.message, 'error');
      break;

    case 'categories':
      loadCategories(msg.categories);
      break;
  }
}

// --- Initialization ---
function init() {
  const nickname = getCookie(COOKIE_NICKNAME_KEY);
  if (nickname) {
    setNickname(nickname);
  } else {
    showScreen('screenNickname');
  }
}

// --- Nickname screen ---
function setNickname(name) {
  name = (name || '').trim();
  if (!name) {
    toast('ニックネームを入力してください', 'error');
    return;
  }
  if (name.length > 20) {
    toast('ニックネームは20字以内です', 'error');
    return;
  }
  myNickname = name;
  setCookie(COOKIE_NICKNAME_KEY, name, COOKIE_EXPIRE_DAYS);
  send({ type: 'set_nickname', nickname: name });
}

// --- Lobby ---
function reloadLobby() {
  send({ type: 'get_rooms' });
}

function createRoom() {
  send({
    type: 'create_room',
    nickname: myNickname,
    settings: {
      questionCount: parseInt(document.getElementById('questionCountSelect').value) || 10,
      extraSeconds: parseInt(document.getElementById('extraSecondsSelect').value) || 0,
      categories: Array.from(selectedCategories),
    }
  });
}

function joinRoom() {
  const key = document.getElementById('joinRoomKeyInput').value.trim().toUpperCase();
  if (!key) {
    toast('コードを入力してください', 'error');
    return;
  }
  send({
    type: 'join_room',
    roomKey: key,
    nickname: myNickname,
  });
}

// --- Room screen setup ---
function setupRoomScreen(players, settings, roomKey, isHostFlag) {
  // 修正: settings が undefined でないか確認
  if (!settings) {
    settings = { questionCount: 10, extraSeconds: 0, categories: ['ALL'] };
  }

  document.getElementById('roomKeyDisplay').textContent = roomKey;
  updatePlayerList('waitingPlayerList', players);
  updatePlayerCount(players);
  updateSettingsSummary(settings);
  updateStartButton(players);

  const startBtn = document.getElementById('startGameBtn');
  const dissolveBtn = document.getElementById('dissolveRoomBtn');
  const categoryCheckboxes = document.querySelectorAll('#categoryList input[type="checkbox"]');

  if (isHostFlag) {
    startBtn.style.display = 'block';
    dissolveBtn.style.display = 'block';
    categoryCheckboxes.forEach(cb => cb.disabled = false);
  } else {
    startBtn.style.display = 'none';
    dissolveBtn.style.display = 'none';
    categoryCheckboxes.forEach(cb => cb.disabled = true);
  }
}

function updatePlayerList(elementId, players) {
  const container = document.getElementById(elementId);
  if (!container) return;
  
  // 修正: players が配列であることを確認
  if (!Array.isArray(players)) {
    players = [];
  }

  container.innerHTML = players.map(p => {
    const hostBadge = p.isHost ? ' 👑' : '';
    return `<div class="player-item">${p.nickname}${hostBadge}</div>`;
  }).join('');
}

function updatePlayerCount(players) {
  // 修正: players が配列であることを確認
  if (!Array.isArray(players)) {
    players = [];
  }

  const el = document.getElementById('playerCount');
  if (el) el.textContent = `${players.length}人`;
  updateStartButton(players);
}

function updateStartButton(players) {
  const btn = document.getElementById('startGameBtn');
  if (btn) btn.disabled = (Array.isArray(players) ? players.length : 0) < 2;
}

function updateSettingsSummary(settings) {
  const el = document.getElementById('settingsSummary');
  if (!el) return;
  
  // 修正: settings と settings.categories が存在することを確認
  if (!settings) {
    settings = { questionCount: 10, extraSeconds: 0, categories: ['ALL'] };
  }

  const categories = Array.isArray(settings.categories) ? settings.categories : ['ALL'];

  el.innerHTML = `
    📋 問題数: <strong style="color:var(--neon-cyan)">${settings.questionCount}問</strong><br>
    ⏱ 追加秒数: <strong style="color:var(--neon-cyan)">+${settings.extraSeconds}秒</strong><br>
    🎵 カテゴリ: <strong style="color:var(--neon-cyan)">${categories.join('、')}</strong>
  `;
}

function copyRoomKey() {
  const key = document.getElementById('roomKeyDisplay').textContent;
  navigator.clipboard.writeText(key).then(() => {
    toast('コードをコピーしました！', 'success');
  });
}

function startGame() {
  send({ type: 'start_game' });
}

function dissolveRoom() {
  if (!confirm('部屋を解散しますか？')) return;
  send({ type: 'dissolve_room' });
}

function leaveRoom() {
  send({ type: 'leave_room' });
}

// --- Categories ---
function loadCategories(categories) {
  if (!Array.isArray(categories)) categories = [];
  
  const container = document.getElementById('categoryList');
  if (!container) return;
  
  container.innerHTML = ['ALL', ...categories].map(cat => `
    <label>
      <input type="checkbox" value="${cat}" ${cat === 'ALL' ? 'checked' : ''} onchange="toggleCategory('${cat}')">
      ${cat}
    </label>
  `).join('');
}

function toggleCategory(cat) {
  if (cat === 'ALL') {
    selectedCategories.clear();
    selectedCategories.add('ALL');
  } else {
    selectedCategories.delete('ALL');
    const cb = document.querySelector(`#categoryList input[value="${cat}"]`);
    if (cb && cb.checked) {
      selectedCategories.add(cat);
    } else {
      selectedCategories.delete(cat);
    }
  }
  updateSettings();
}

function updateSettings() {
  send({
    type: 'update_settings',
    settings: {
      questionCount: parseInt(document.getElementById('questionCountSelect').value) || 10,
      extraSeconds: parseInt(document.getElementById('extraSecondsSelect').value) || 0,
      categories: Array.from(selectedCategories),
    }
  });
}

// --- Game screen ---
function startCountdown(seconds) {
  showScreen('screenCountdown');
  const el = document.getElementById('countdownDisplay');
  let remaining = seconds;
  const interval = setInterval(() => {
    el.textContent = remaining;
    remaining--;
    if (remaining < 0) {
      clearInterval(interval);
      showScreen('screenGame');
    }
  }, 1000);
}

function loadAndPlayAudio(songFile, startTime, duration) {
  ensureUserInteracted();
  
  // 修正: 前の audio 要素を完全に削除
  const oldAudio = document.getElementById('audioPlayer');
  if (oldAudio) {
    oldAudio.pause();
    oldAudio.remove();
  }

  // 新しい audio 要素を毎回作成
  const audio = document.createElement('audio');
  audio.id = 'audioPlayer';
  audio.src = `/music/${songFile}`;
  audio.volume = 0.7;

  // イベントリスナーは once: true で1回だけ実行
  audio.addEventListener('canplay', () => {
    console.log('Audio canplay, seeking to', startTime);
    audio.currentTime = startTime;
    audio.play().catch(err => {
      if (err.name === 'NotAllowedError') {
        showAutoplayPrompt();
      } else {
        onAudioError();
      }
    });
  }, { once: true });

  // ロードエラーハンドラ
  audio.addEventListener('error', () => {
    onAudioError();
  }, { once: true });

  document.body.appendChild(audio);
  audio.load();

  // タイムアウト: 10秒以内にロードされない場合
  setTimeout(() => {
    if (audio && audio.paused && audio.readyState < 2) {
      console.warn('Audio load timeout, continuing anyway');
      onAudioError();
    }
  }, 10000);

  audioStartTime = startTime;
  audioDuration = duration;
}

function showAutoplayPrompt() {
  toast('🔊 ボタンをタップして音声を再生してください', 'info', 5000);
}

function onAudioError() {
  toast('⚠️ 音声の読み込みに失敗しました。ゲームを続行できます', 'error', 3000);
}

function onBuzzerPressed(msg) {
  if (msg.playerId === myId) {
    amAnswering = true;
    buzzerEnabled = false;
    showScreen('screenAnswerInput');
  } else {
    toast(`⏱ ${msg.nickname} が回答中...`, 'info');
  }
}

function onAnswerResult(msg) {
  const isMe = msg.playerId === myId;
  
  // 修正: answer が空文字や "-" でないか確認
  const answerText = (msg.answer && msg.answer.trim() !== '' && msg.answer !== '-') ? msg.answer : '？';
  
  if (msg.correct) {
    flashOverlay('correct');
    toast(`✓ 正解: ${answerText}`, 'success');
    if (isMe) myLastAnswers.push({ correct: true, answer: msg.answer });
  } else {
    flashOverlay('incorrect');
    const userAnswer = isMe ? document.getElementById('answerInput').value : msg.answer;
    toast(`✗ 不正解: ${answerText}`, 'error');
    if (isMe) myLastAnswers.push({ correct: false, answer: userAnswer });
  }

  amAnswering = false;
  updatePlayerList('playerList', msg.players);

  // 修正: 少し遅延させて answer reveal 画面を表示
  setTimeout(() => {
    showScreen('screenAnswerReveal');
  }, 500);
}

function onQuestionTimeout(msg) {
  flashOverlay('timeout');
  // 修正: answer が空文字や "-" でないか確認
  const answerText = (msg.answer && msg.answer.trim() !== '' && msg.answer !== '-') ? msg.answer : '？';
  toast(`時間切れ: ${answerText}`, 'error');
  updatePlayerList('playerList', msg.players);
  showScreen('screenAnswerReveal');
}

function onGameEnd(msg) {
  const results = msg.results || [];
  const container = document.getElementById('resultsList');
  if (!container) return;

  // 修正: results が配列であることを確認
  if (!Array.isArray(results)) {
    container.innerHTML = '<p>結果を取得できませんでした</p>';
    showScreen('screenResults');
    return;
  }

  container.innerHTML = results.map((r, i) => {
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '　';
    const hostBadge = r.isHost ? ' 👑' : '';
    return `
      <div class="result-row">
        <div class="medal">${medal}</div>
        <div class="name">${r.nickname}${hostBadge}</div>
        <div class="score">${r.score}点</div>
      </div>
    `;
  }).join('');

  // 修正: 最後の問題のスクリーンを表示
  showScreen('screenResults');
}

// --- Game actions ---
function submitAnswer() {
  ensureUserInteracted();
  const input = document.getElementById('answerInput');
  const answer = (input.value || '').trim();
  if (!answer) {
    toast('回答を入力してください', 'error');
    return;
  }
  input.value = '';
  send({ type: 'answer', answer });
}

function playAgain() {
  send({ type: 'play_again' });
}

function backToLobby() {
  myRoomKey = null;
  isHost = false;
  showScreen('screenLobby');
}

// --- Initialization on page load ---
window.addEventListener('DOMContentLoaded', () => {
  connectWS();
  
  // Enter key handling for inputs
  document.getElementById('nicknameInput')?.addEventListener('keypress', e => {
    if (e.key === 'Enter') setNickname(e.target.value);
  });
  
  document.getElementById('joinRoomKeyInput')?.addEventListener('keypress', e => {
    if (e.key === 'Enter') joinRoom();
  });
  
  document.getElementById('answerInput')?.addEventListener('keypress', e => {
    if (e.key === 'Enter') submitAnswer();
  });
});
