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

  ws.onclose = () => {
    toast('サーバーから切断されました。再接続中...', 'error');
    setTimeout(connectWS, 3000);
  };

  ws.onerror = () => {
    // will fire onclose
  };
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

// --- Message Handler ---
function handleServerMessage(msg) {
  console.log('[WS]', msg.type, msg);
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
      setupRoomScreen(msg.players, msg.settings || {}, msg.roomKey, true);
      if (msg.categories) loadCategories(msg.categories);
      showScreen('screenRoom');
      break;

    case 'room_joined':
      myRoomKey = msg.roomKey;
      isHost = false;
      setupRoomScreen(msg.players, msg.settings || {}, msg.roomKey, false);
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
      updateSettingsSummary(msg.settings || {});
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
      setupRoomScreen(msg.players, msg.settings || {}, myRoomKey, isHost);
      showScreen('screenRoom');
      break;

    case 'room_dissolved':
      toast('部屋が解散されました', 'error');
      myRoomKey = null;
      isHost = false;
      stopAudio();
      showScreen('screenLobby');
      break;

    case 'categories':
      loadCategories(msg.categories);
      break;

    case 'error':
      toast(msg.message, 'error');
      break;
  }
}

// --- Init ---
function init() {
  const saved = getCookie(COOKIE_NICKNAME_KEY);
  if (saved) {
    document.getElementById('nicknameInput').value = saved;
    send({ type: 'set_nickname', nickname: saved });
    myNickname = saved;
    document.getElementById('displayNickname').textContent = saved;
    showScreen('screenLobby');
  } else {
    showScreen('screenNickname');
  }
  // request categories for create room
  send({ type: 'get_categories' });
}

// --- Nickname ---
function saveNickname() {
  const val = document.getElementById('nicknameInput').value.trim();
  if (!val || val.length < 2) { toast('2文字以上入力してください', 'error'); return; }
  ensureUserInteracted();
  setCookie(COOKIE_NICKNAME_KEY, val, COOKIE_EXPIRE_DAYS);
  send({ type: 'set_nickname', nickname: val });
}

function changeNickname() {
  document.getElementById('nicknameInput').value = myNickname || '';
  showScreen('screenNickname');
}

// Enter key support for nickname
document.getElementById('nicknameInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') saveNickname();
});

// --- Lobby ---
function showCreateRoom() {
  const p = document.getElementById('createRoomPanel');
  const j = document.getElementById('joinRoomPanel');
  p.style.display = p.style.display === 'none' ? 'block' : 'none';
  j.style.display = 'none';
  send({ type: 'get_categories' });
}

function showJoinRoom() {
  const j = document.getElementById('joinRoomPanel');
  const p = document.getElementById('createRoomPanel');
  j.style.display = j.style.display === 'none' ? 'block' : 'none';
  p.style.display = 'none';
}

function loadCategories(categories) {
  const container = document.getElementById('categoryChips');
  if (!container) return;
  // Keep ALL chip
  container.innerHTML = '<div class="chip active" data-cat="ALL" onclick="toggleCategory(this)">🎲 ランダム（全て）</div>';
  categories.forEach(cat => {
    const chip = document.createElement('div');
    chip.className = 'chip';
    chip.dataset.cat = cat;
    chip.onclick = function() { toggleCategory(this); };
    chip.textContent = cat;
    container.appendChild(chip);
  });
  selectedCategories = new Set(['ALL']);
}

function toggleCategory(chip) {
  const cat = chip.dataset.cat;
  if (cat === 'ALL') {
    selectedCategories = new Set(['ALL']);
    document.querySelectorAll('#categoryChips .chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
  } else {
    selectedCategories.delete('ALL');
    document.querySelector('[data-cat="ALL"]')?.classList.remove('active');
    if (chip.classList.contains('active')) {
      chip.classList.remove('active');
      selectedCategories.delete(cat);
    } else {
      chip.classList.add('active');
      selectedCategories.add(cat);
    }
    if (selectedCategories.size === 0) {
      selectedCategories.add('ALL');
      document.querySelector('[data-cat="ALL"]')?.classList.add('active');
    }
  }
}

function createRoom() {
  ensureUserInteracted();
  const questionCount = parseInt(document.getElementById('settingQuestions').value) || 10;
  const extraSeconds = parseInt(document.getElementById('settingExtraSeconds').value) || 0;
  const categories = [...selectedCategories];
  send({
    type: 'create_room',
    settings: { questionCount, extraSeconds, categories }
  });
}

function joinRoom() {
  ensureUserInteracted();
  const key = document.getElementById('joinKeyInput').value.toUpperCase().trim();
  if (key.length !== 6) { toast('6文字のコードを入力してください', 'error'); return; }
  send({ type: 'join_room', roomKey: key });
}

document.getElementById('joinKeyInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') joinRoom();
});

// Auto-uppercase join input
document.getElementById('joinKeyInput').addEventListener('input', e => {
  e.target.value = e.target.value.toUpperCase();
});

// --- Room Screen ---
function setupRoomScreen(players, settings, roomKey, host) {
  document.getElementById('roomKeyDisplay').textContent = roomKey;
  updatePlayerList('waitingPlayerList', players);
  updatePlayerCount(players);
  updateSettingsSummary(settings);
  document.getElementById('hostControls').style.display = host ? 'block' : 'none';
  document.getElementById('guestWaiting').style.display = host ? 'none' : 'block';
  updateStartButton(players);
}

function updatePlayerList(listId, players) {
  const list = document.getElementById(listId);
  if (!list) return;
  list.innerHTML = players.map(p => `
    <li class="player-item ${p.isMiss ? 'is-miss' : ''}">
      <div class="player-avatar">${(p.nickname || '?')[0].toUpperCase()}</div>
      <span class="player-name">${escHtml(p.nickname)}</span>
      ${p.isHost ? '<span class="player-host-badge">HOST</span>' : ''}
      ${p.isMiss ? '<span class="player-miss-icon">一回休み</span>' : ''}
      ${listId !== 'waitingPlayerList' ? `<span class="player-score">${p.score}</span>` : ''}
    </li>
  `).join('');
}

function updatePlayerCount(players) {
  document.getElementById('playerCountDisplay').textContent = `${players.length}/10`;
  updateStartButton(players);
}

function updateStartButton(players) {
  const btn = document.getElementById('startGameBtn');
  if (btn) btn.disabled = players.length < 2;
}

function updateSettingsSummary(settings) {
  const el = document.getElementById('settingsSummary');
  if (!el) return;
  // settingsがundefined/nullの場合はデフォルト値を使う
  const s = settings || {};
  const questionCount = s.questionCount ?? '?';
  const extraSeconds = s.extraSeconds ?? 0;
  const categories = Array.isArray(s.categories) && s.categories.length > 0
    ? s.categories.join('、')
    : 'ランダム（全て）';
  el.innerHTML = `
    📋 問題数: <strong style="color:var(--neon-cyan)">${questionCount}問</strong><br>
    ⏱ 追加秒数: <strong style="color:var(--neon-cyan)">+${extraSeconds}秒</strong><br>
    🎵 カテゴリ: <strong style="color:var(--neon-cyan)">${categories}</strong>
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
  myRoomKey = null;
  isHost = false;
  showScreen('screenLobby');
}

// --- Countdown ---
function startCountdown(secs) {
  showScreen('screenCountdown');
  let n = secs;
  const el = document.getElementById('countdownNum');
  el.textContent = n;
  const iv = setInterval(() => {
    n--;
    if (n <= 0) {
      clearInterval(iv);
      el.textContent = 'START!';
    } else {
      el.textContent = n;
    }
  }, 1000);
}

// --- Question ---
function startQuestion(msg) {
  showScreen('screenGame');
  amAnswering = false;
  buzzerEnabled = false;

  document.getElementById('qNumber').textContent = msg.questionIndex;
  document.getElementById('qTotal').textContent = `/ ${msg.totalQuestions}`;
  document.getElementById('qCategory').textContent = msg.category || '-';
  document.getElementById('progressFill').style.width = `${(msg.questionIndex / msg.totalQuestions) * 100}%`;

  // Reset UI fully for new question
  document.getElementById('buzzerPressedInfo').style.display = 'none';
  document.getElementById('answerArea').style.display = 'none';
  document.getElementById('buzzerArea').style.display = 'block';
  document.getElementById('answerInput').value = '';
  const buzzerBtn = document.getElementById('buzzerBtn');
  buzzerBtn.disabled = true;
  buzzerBtn.textContent = '読み込み中...';

  updatePlayerList('gamePlayerList', msg.players);

  audioDuration = msg.playDuration;
  audioStartTime = Date.now();
  document.getElementById('audioTimer').textContent = formatTime(msg.playDuration);

  loadAndPlayAudio(msg);
}

// 音声を完全にリセットしてから読み込む（競合を防ぐ）
function loadAndPlayAudio(msg) {
  // 古いaudio要素を完全に破棄して新しく作る（oncanplaythroughの蓄積を防ぐ）
  const oldAudio = document.getElementById('gameAudio');
  const newAudio = document.createElement('audio');
  newAudio.id = 'gameAudio';
  newAudio.preload = 'auto';
  oldAudio.parentNode.replaceChild(newAudio, oldAudio);

  const buzzerBtn = document.getElementById('buzzerBtn');
  const audioLabel = document.getElementById('audioLabel');
  const audioIcon = document.getElementById('audioIcon');

  audioLabel.textContent = '読み込み中...';
  audioIcon.textContent = '⏳';

  // 再生を実際に開始する関数（自動再生ポリシー対応）
  function doPlay() {
    newAudio.currentTime = msg.startTime || 0;
    const playPromise = newAudio.play();
    if (playPromise !== undefined) {
      playPromise.then(() => {
        // 再生成功
        audioLabel.textContent = 'イントロ再生中...';
        audioIcon.textContent = '🎵';
        buzzerBtn.disabled = false;
        buzzerBtn.textContent = 'わかった！';
        buzzerEnabled = true;
        audioStartTime = Date.now();
        startAudioTimer(msg.playDuration);
      }).catch((err) => {
        // 自動再生ポリシーでブロックされた場合 → ユーザーにタップを促す
        console.warn('自動再生ブロック:', err.name);
        if (err.name === 'NotAllowedError') {
          showAutoplayPrompt(newAudio, msg, buzzerBtn);
        } else {
          // ファイルが見つからない等のエラー
          onAudioError(msg, buzzerBtn, audioLabel);
        }
      });
    }
  }

  // canplaythroughでなくcanplayを使う（より早く発火する）
  newAudio.addEventListener('canplay', doPlay, { once: true });

  newAudio.addEventListener('error', () => {
    onAudioError(msg, buzzerBtn, audioLabel);
  }, { once: true });

  // タイムアウト保険：10秒経っても読み込めなければエラー扱い
  const loadTimeout = setTimeout(() => {
    if (buzzerBtn.disabled) {
      console.warn('音声読み込みタイムアウト');
      onAudioError(msg, buzzerBtn, audioLabel);
    }
  }, 10000);

  newAudio.addEventListener('canplay', () => clearTimeout(loadTimeout), { once: true });
  newAudio.addEventListener('error', () => clearTimeout(loadTimeout), { once: true });

  newAudio.src = `/music/${msg.songFile}`;
  newAudio.load();
}

// 自動再生がブロックされた時のUI
function showAutoplayPrompt(audio, msg, buzzerBtn) {
  const audioLabel = document.getElementById('audioLabel');
  const audioIcon = document.getElementById('audioIcon');
  audioLabel.innerHTML = '<span style="color:var(--neon-yellow)">▶ タップして音楽を再生</span>';
  audioIcon.textContent = '🔇';
  buzzerBtn.disabled = false;
  buzzerBtn.textContent = '▶ タップして開始';
  buzzerEnabled = false; // まだバザーは使えない

  // バザーボタンタップで再生開始
  buzzerBtn.onclick = function () {
    audio.currentTime = msg.startTime || 0;
    audio.play().then(() => {
      audioLabel.textContent = 'イントロ再生中...';
      audioIcon.textContent = '🎵';
      buzzerBtn.textContent = 'わかった！';
      buzzerEnabled = true;
      audioStartTime = Date.now();
      startAudioTimer(msg.playDuration);
      // 元のonclickに戻す
      buzzerBtn.onclick = null;
    }).catch(() => {
      onAudioError(msg, buzzerBtn, audioLabel);
      buzzerBtn.onclick = null;
    });
  };
}

function onAudioError(msg, buzzerBtn, audioLabel) {
  audioLabel.textContent = '⚠️ 音声ファイルなし（バザー回答のみ可）';
  document.getElementById('audioIcon').textContent = '🚫';
  buzzerBtn.disabled = false;
  buzzerBtn.textContent = 'わかった！';
  buzzerEnabled = true;
  // タイマーは動かしておく（サーバー側でタイムアウト管理）
  startAudioTimer(msg.playDuration);
}

function startAudioTimer(duration) {
  clearInterval(audioPlayTimer);
  const timerEl = document.getElementById('audioTimer');
  let elapsed = 0;
  audioPlayTimer = setInterval(() => {
    elapsed++;
    const remaining = Math.max(0, duration - elapsed);
    timerEl.textContent = formatTime(remaining);
    if (remaining === 0) {
      clearInterval(audioPlayTimer);
      document.getElementById('audioLabel').textContent = '再生終了';
    }
  }, 1000);
}

function formatTime(secs) {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function stopAudio() {
  clearInterval(audioPlayTimer);
  const audio = document.getElementById('gameAudio');
  audio.pause();
  audio.src = '';
}

// --- Buzzer ---
function pressBuzzer() {
  if (!buzzerEnabled || amAnswering) return;
  send({ type: 'buzzer' });
}

// Spacebar support
document.addEventListener('keydown', e => {
  if (e.code === 'Space' && gameState === 'game' && !e.target.closest('input')) {
    e.preventDefault();
    pressBuzzer();
  }
  if (e.key === 'Enter' && gameState === 'game' && e.target === document.getElementById('answerInput')) {
    submitAnswer();
  }
});

function onBuzzerPressed(msg) {
  const isMe = msg.playerId === myId;
  
  // Pause audio
  document.getElementById('gameAudio').pause();
  clearInterval(audioPlayTimer);
  document.getElementById('audioLabel').textContent = `${msg.nickname} が回答中...`;

  document.getElementById('buzzerPressedInfo').style.display = 'block';
  document.getElementById('buzzerPlayerName').textContent = msg.nickname;
  document.getElementById('buzzerBtn').disabled = true;

  if (isMe) {
    amAnswering = true;
    document.getElementById('answerArea').style.display = 'block';
    document.getElementById('buzzerArea').style.display = 'none';
    const input = document.getElementById('answerInput');
    input.value = '';
    input.focus();
  }
}

function submitAnswer() {
  const val = document.getElementById('answerInput').value.trim();
  if (!val) { toast('回答を入力してください', 'error'); return; }
  send({ type: 'answer', answer: val });
  amAnswering = false;
  document.getElementById('answerArea').style.display = 'none';
  document.getElementById('buzzerArea').style.display = 'block';
}

function onAnswerResult(msg) {
  clearInterval(audioPlayTimer);

  // Track my own answers
  if (msg.playerId === myId) {
    myLastAnswers.push({
      title: msg.songTitle,
      answer: msg.answer,
      correct: msg.correct,
    });
  }

  if (msg.correct) {
    flashOverlay('correct');
    stopAudio();
    showAnswerReveal(msg, true);
  } else {
    flashOverlay('wrong');

    // Show wrong result briefly, then resume game screen
    toast(`❌ ${msg.nickname}「${msg.answer}」→ 不正解！一回休み`, 'error', 2500);
    amAnswering = false;
    
    // Update player list
    updatePlayerList('gamePlayerList', msg.players);

    // Reset buzzer UI
    const buzzerBtn = document.getElementById('buzzerBtn');
    document.getElementById('buzzerPressedInfo').style.display = 'none';
    document.getElementById('answerArea').style.display = 'none';
    document.getElementById('buzzerArea').style.display = 'block';

    // Check if I'm on miss
    const me = msg.players.find(p => p.id === myId);
    if (me && me.isMiss) {
      buzzerBtn.disabled = true;
      buzzerBtn.textContent = '😵 一回休み';
      buzzerEnabled = false;
    } else {
      buzzerBtn.disabled = false;
      buzzerBtn.textContent = 'わかった！';
      buzzerEnabled = true;
    }

    // Resume audio
    const audio = document.getElementById('gameAudio');
    if (audio.src && audio.paused) {
      audio.play().catch(() => {});
      const elapsed = Math.floor((Date.now() - audioStartTime) / 1000);
      const remaining = Math.max(1, audioDuration - elapsed);
      startAudioTimer(remaining);
      document.getElementById('audioLabel').textContent = 'イントロ再生中...';
    }
  }
}

function onQuestionTimeout(msg) {
  clearInterval(audioPlayTimer);
  const audio = document.getElementById('gameAudio');
  audio.pause();

  showAnswerReveal({ songTitle: msg.answer, artist: msg.artist, correct: false, players: msg.players }, false);
}

function showAnswerReveal(msg, wasCorrect) {
  showScreen('screenAnswerReveal');

  document.getElementById('revealSongTitle').textContent = msg.songTitle || '-';
  document.getElementById('revealArtist').textContent = msg.artist || '-';

  const resultEl = document.getElementById('revealResult');
  if (wasCorrect && msg.nickname) {
    resultEl.innerHTML = `<span style="color:var(--neon-green); font-size:1.2rem; font-weight:900;">✅ ${escHtml(msg.nickname)} の正解！</span>`;
  } else if (!wasCorrect && !msg.nickname) {
    resultEl.innerHTML = `<span style="color:var(--text-dim);">⏱ 時間切れ</span>`;
  } else {
    resultEl.innerHTML = '';
  }

  updatePlayerList('revealPlayerList', msg.players || []);

  // Play sabi if correct
  if (wasCorrect && msg.songFile) {
    document.getElementById('revealSabiCard').style.display = 'block';

    // audio要素を再生成して競合を防ぐ
    const oldAudio = document.getElementById('gameAudio');
    const sabiAudio = document.createElement('audio');
    sabiAudio.id = 'gameAudio';
    sabiAudio.preload = 'auto';
    oldAudio.parentNode.replaceChild(sabiAudio, oldAudio);

    const sabiEl = document.getElementById('sabiTimer');
    let remaining = msg.sabiDuration || 15;
    sabiEl.textContent = formatTime(remaining);

    sabiAudio.addEventListener('canplay', () => {
      sabiAudio.currentTime = msg.sabiTime || 0;
      sabiAudio.play().catch(err => {
        console.warn('サビ再生エラー:', err.name);
      });
      const iv = setInterval(() => {
        remaining--;
        sabiEl.textContent = formatTime(Math.max(0, remaining));
        if (remaining <= 0) clearInterval(iv);
      }, 1000);
    }, { once: true });

    sabiAudio.src = `/music/${msg.songFile}`;
    sabiAudio.load();
  } else {
    document.getElementById('revealSabiCard').style.display = 'none';
  }
}

// --- Game End ---
function onGameEnd(msg) {
  stopAudio();
  showScreen('screenResults');

  // Rankings
  const rankEl = document.getElementById('finalRankings');
  rankEl.innerHTML = msg.results.map((p, i) => `
    <div class="result-rank rank-${i + 1}">
      <div class="rank-number">${i === 0 ? '🏆' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}`}</div>
      <div class="player-avatar">${p.nickname[0].toUpperCase()}</div>
      <div style="flex:1">
        <div style="font-weight:900;">${escHtml(p.nickname)}</div>
        ${p.id === myId ? '<div style="font-size:0.75rem; color:var(--neon-cyan);">YOU</div>' : ''}
      </div>
      <div class="player-score" style="font-size:1.5rem;">${p.score}</div>
    </div>
  `).join('');

  // My answers
  const myData = msg.results.find(r => r.id === myId);
  const myAnswersEl = document.getElementById('myAnswers');
  if (myData && myData.answers && myData.answers.length > 0) {
    myAnswersEl.innerHTML = myData.answers.map(a => `
      <li>
        <span class="${a.correct ? 'answer-correct' : 'answer-wrong'}">${a.correct ? '✅' : '❌'}</span>
        <span style="flex:1">${escHtml(a.title)}</span>
        ${!a.correct ? `<span style="color:var(--text-dim); font-size:0.8rem;">「${escHtml(a.answer)}」</span>` : ''}
      </li>
    `).join('');
  } else {
    myAnswersEl.innerHTML = '<li style="color:var(--text-dim);">回答データなし</li>';
  }

  document.getElementById('resultHostControls').style.display = isHost ? 'block' : 'none';
  document.getElementById('resultGuestControls').style.display = isHost ? 'none' : 'block';
}

function playAgain() {
  send({ type: 'play_again' });
}

// --- Utils ---
function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// --- Start ---
connectWS();
