const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('./ws-server.js');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, '../public');
const MUSIC_DIR = isProduction 
  ? '/data/music'
  : path.join(__dirname, '../music');

// In-memory state
const rooms = new Map();
const clients = new Map(); // ws -> { nickname, roomId, id }

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

function generateRoomKey() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let key = '';
  for (let i = 0; i < 6; i++) key += chars[Math.floor(Math.random() * chars.length)];
  return key;
}

function generateId() {
  return crypto.randomBytes(8).toString('hex');
}

// Load music metadata
function loadMusicCatalog() {
  const catalogPath = path.join(MUSIC_DIR, 'catalog.json');
  
  // catalog.json を読み込み
  if (!fs.existsSync(catalogPath)) {
    // catalog.json がない場合は空のカタログを作成
    const emptyCatalog = { songs: [] };
    fs.writeFileSync(catalogPath, JSON.stringify(emptyCatalog, null, 2));
    return emptyCatalog;
  }
  
  return JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
}

// GitHub の music フォルダから MP3 ファイルを自動スキャンして catalog.json に追加
function scanMusicFolder() {
  try {
    if (!fs.existsSync(MUSIC_DIR)) {
      console.log('📁 music フォルダが見つかりません。作成します...');
      fs.mkdirSync(MUSIC_DIR, { recursive: true });
      return;
    }

    const files = fs.readdirSync(MUSIC_DIR);
    const audioFiles = files.filter(f => /\.(mp3|wav|ogg|m4a)$/i.test(f));
    
    if (audioFiles.length === 0) {
      console.log('🎵 music フォルダに音声ファイルがありません');
      return;
    }

    console.log(`\n📂 music フォルダをスキャン: ${audioFiles.length} 個のファイルを検出`);
    
    // 現在の catalog を読み込み
    let catalog = loadMusicCatalog();
    const existingFiles = new Set(catalog.songs.map(s => s.file));
    
    // 新しいファイルを追加
    let addedCount = 0;
    audioFiles.forEach((file, index) => {
      if (existingFiles.has(file)) {
        console.log(`  ✓ ${file} （既存）`);
        return;
      }

      // デフォルト曲情報を生成
      const title = path.parse(file).name; // ファイル名を曲名として使用
      const newSong = {
        id: `song_${Date.now()}_${index}`,
        title: title,
        artist: "アーティスト不明",
        category: "その他",
        file: file,
        startTime: 0,
        sabiBeat: 60,
        sabiDuration: 15
      };
      
      catalog.songs.push(newSong);
      console.log(`  ✨ ${file} （新規追加）`);
      addedCount++;
    });

    // 更新があった場合は保存
    if (addedCount > 0) {
      fs.writeFileSync(
        path.join(MUSIC_DIR, 'catalog.json'),
        JSON.stringify(catalog, null, 2)
      );
      console.log(`\n✅ ${addedCount} 個の曲を catalog.json に追加しました\n`);
    }

  } catch (err) {
    console.error('❌ music フォルダのスキャンエラー:', err.message);
  }
}

let musicCatalog = loadMusicCatalog();
scanMusicFolder(); // 起動時に自動スキャン

// Game logic
function createRoom(hostId, settings) {
  let key;
  do { key = generateRoomKey(); } while (rooms.has(key));
  
  const room = {
    key,
    hostId,
    settings: {
      questionCount: settings.questionCount || 10,
      extraSeconds: settings.extraSeconds || 0,
      categories: settings.categories || ['ALL'],
    },
    players: new Map(), // id -> { nickname, score, missCount, answers, isMiss }
    state: 'waiting', // waiting | playing | finished
    currentQuestion: null,
    questionIndex: 0,
    questions: [],
    questionTimer: null,
    answerTimer: null,
    buzzerPressedBy: null, // currently answering player id
    answeredPlayers: new Set(), // players who already answered this question
  };
  rooms.set(key, room);
  return room;
}

function selectQuestions(settings) {
  let pool = [...musicCatalog.songs];
  if (!settings.categories.includes('ALL')) {
    pool = pool.filter(s => settings.categories.includes(s.category));
  }
  // Shuffle
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, Math.min(settings.questionCount, pool.length));
}

function broadcast(room, message) {
  const msg = JSON.stringify(message);
  for (const [ws, info] of clients) {
    if (info.roomId === room.key) {
      if (ws.readyState === 1) ws.send(msg);
    }
  }
}

function sendToPlayer(playerId, message) {
  for (const [ws, info] of clients) {
    if (info.id === playerId && ws.readyState === 1) {
      ws.send(JSON.stringify(message));
      return;
    }
  }
}

function getRoomPlayerList(room) {
  return Array.from(room.players.entries()).map(([id, p]) => ({
    id,
    nickname: p.nickname,
    score: p.score,
    isHost: id === room.hostId,
    isMiss: p.isMiss,
  }));
}

function startNextQuestion(room) {
  if (room.questionIndex >= room.questions.length) {
    endGame(room);
    return;
  }

  const song = room.questions[room.questionIndex];
  room.currentQuestion = song;
  room.buzzerPressedBy = null;
  room.answeredPlayers = new Set();

  // Reset miss status for all players
  for (const p of room.players.values()) {
    p.isMiss = false;
  }

  const extraSeconds = room.settings.extraSeconds || 0;
  const playDuration = (song.sabiDuration || 15) + extraSeconds;

  broadcast(room, {
    type: 'question_start',
    questionIndex: room.questionIndex + 1,
    totalQuestions: room.questions.length,
    songFile: song.file,
    startTime: song.startTime || 0,
    playDuration,
    category: song.category,
    players: getRoomPlayerList(room),
  });

  // Question timeout - if no one answers
  room.questionTimer = setTimeout(() => {
    timeoutQuestion(room);
  }, (playDuration + 3) * 1000);

  room.questionIndex++;
}

function timeoutQuestion(room) {
  if (room.state !== 'playing') return;
  broadcast(room, {
    type: 'question_timeout',
    answer: room.currentQuestion.title,
    artist: room.currentQuestion.artist,
    players: getRoomPlayerList(room),
  });
  setTimeout(() => startNextQuestion(room), 4000);
}

function endGame(room) {
  room.state = 'finished';
  clearTimeout(room.questionTimer);
  clearTimeout(room.answerTimer);

  const results = Array.from(room.players.entries()).map(([id, p]) => ({
    id,
    nickname: p.nickname,
    score: p.score,
    answers: p.answers,
    isHost: id === room.hostId,
  })).sort((a, b) => b.score - a.score);

  broadcast(room, { type: 'game_end', results });
}

function handleBuzzer(ws, room, clientInfo) {
  if (room.state !== 'playing') return;
  if (room.buzzerPressedBy) return; // someone already pressed
  if (clientInfo.isMiss) return; // on rest
  
  const player = room.players.get(clientInfo.id);
  if (!player || player.isMiss) return;

  room.buzzerPressedBy = clientInfo.id;
  clearTimeout(room.questionTimer);

  broadcast(room, {
    type: 'buzzer_pressed',
    playerId: clientInfo.id,
    nickname: player.nickname,
  });

  // 10 second answer timer
  room.answerTimer = setTimeout(() => {
    // No answer = wrong
    handleAnswer(ws, room, clientInfo, '');
  }, 10000);
}

function handleAnswer(ws, room, clientInfo, answer) {
  if (room.state !== 'playing') return;
  if (room.buzzerPressedBy !== clientInfo.id) return;

  clearTimeout(room.answerTimer);

  const player = room.players.get(clientInfo.id);
  const song = room.currentQuestion;
  const correct = isCorrectAnswer(answer, song.title);

  if (correct) {
    player.score++;
    player.answers.push({ songId: song.id, title: song.title, artist: song.artist, correct: true, answer });
    
    broadcast(room, {
      type: 'answer_result',
      playerId: clientInfo.id,
      nickname: player.nickname,
      correct: true,
      answer,
      songTitle: song.title,
      artist: song.artist,
      songFile: song.file,
      sabiTime: song.sabiBeat || 0,
      sabiDuration: (song.sabiDuration || 15),
      players: getRoomPlayerList(room),
    });

    // Next question after sabi plays
    const sabiPlayTime = ((song.sabiDuration || 15) + 2) * 1000;
    setTimeout(() => startNextQuestion(room), sabiPlayTime);
  } else {
    player.isMiss = true;
    player.answers.push({ songId: song.id, title: song.title, artist: song.artist, correct: false, answer });
    room.buzzerPressedBy = null;

    broadcast(room, {
      type: 'answer_result',
      playerId: clientInfo.id,
      nickname: player.nickname,
      correct: false,
      answer,
      players: getRoomPlayerList(room),
    });

    // Resume question or timeout if all missed
    const activePlayers = Array.from(room.players.values()).filter(p => !p.isMiss);
    if (activePlayers.length === 0) {
      // everyone missed
      setTimeout(() => timeoutQuestion(room), 1500);
    } else {
      // Resume buzzer period
      const extraSeconds = room.settings.extraSeconds || 0;
      const remaining = (song.sabiDuration || 15) + extraSeconds;
      room.questionTimer = setTimeout(() => timeoutQuestion(room), remaining * 1000);
    }
  }
}

function isCorrectAnswer(answer, title) {
  if (!answer || !answer.trim()) return false;
  const normalize = s => s.toLowerCase().replace(/[　\s・ー]/g, '').replace(/[！？。、]/g, '');
  return normalize(answer) === normalize(title);
}

// WebSocket message handler
function handleMessage(ws, data) {
  let msg;
  try { msg = JSON.parse(data); } catch { return; }

  const clientInfo = clients.get(ws);
  if (!clientInfo) return;

  switch (msg.type) {
    case 'set_nickname': {
      clientInfo.nickname = msg.nickname;
      ws.send(JSON.stringify({ type: 'nickname_set', nickname: msg.nickname }));
      break;
    }

    case 'create_room': {
      const room = createRoom(clientInfo.id, msg.settings || {});
      room.players.set(clientInfo.id, {
        nickname: clientInfo.nickname,
        score: 0,
        missCount: 0,
        answers: [],
        isMiss: false,
      });
      clientInfo.roomId = room.key;
      ws.send(JSON.stringify({
        type: 'room_created',
        roomKey: room.key,
        players: getRoomPlayerList(room),
        settings: room.settings,
        categories: [...new Set(musicCatalog.songs.map(s => s.category))],
      }));
      break;
    }

    case 'join_room': {
      const room = rooms.get(msg.roomKey);
      if (!room) { ws.send(JSON.stringify({ type: 'error', message: '部屋が見つかりません' })); return; }
      if (room.state !== 'waiting') { ws.send(JSON.stringify({ type: 'error', message: 'ゲームが既に始まっています' })); return; }
      if (room.players.size >= 10) { ws.send(JSON.stringify({ type: 'error', message: '部屋が満員です' })); return; }

      room.players.set(clientInfo.id, {
        nickname: clientInfo.nickname,
        score: 0,
        missCount: 0,
        answers: [],
        isMiss: false,
      });
      clientInfo.roomId = room.key;

      ws.send(JSON.stringify({
        type: 'room_joined',
        roomKey: room.key,
        players: getRoomPlayerList(room),
        settings: room.settings,
        isHost: false,
      }));

      broadcast(room, {
        type: 'player_joined',
        players: getRoomPlayerList(room),
        nickname: clientInfo.nickname,
      });
      break;
    }

    case 'start_game': {
      const room = rooms.get(clientInfo.roomId);
      if (!room || room.hostId !== clientInfo.id) return;
      if (room.players.size < 2) {
        ws.send(JSON.stringify({ type: 'error', message: '2人以上必要です' }));
        return;
      }
      if (room.state !== 'waiting') return;

      room.state = 'playing';
      room.questions = selectQuestions(room.settings);
      room.questionIndex = 0;

      if (room.questions.length === 0) {
        ws.send(JSON.stringify({ type: 'error', message: 'その設定で出題できる曲がありません' }));
        room.state = 'waiting';
        return;
      }

      broadcast(room, { type: 'game_starting', countdown: 3 });
      setTimeout(() => startNextQuestion(room), 3000);
      break;
    }

    case 'update_settings': {
      const room = rooms.get(clientInfo.roomId);
      if (!room || room.hostId !== clientInfo.id || room.state !== 'waiting') return;
      room.settings = { ...room.settings, ...msg.settings };
      broadcast(room, { type: 'settings_updated', settings: room.settings, players: getRoomPlayerList(room) });
      break;
    }

    case 'buzzer': {
      const room = rooms.get(clientInfo.roomId);
      if (!room) return;
      handleBuzzer(ws, room, clientInfo);
      break;
    }

    case 'answer': {
      const room = rooms.get(clientInfo.roomId);
      if (!room) return;
      handleAnswer(ws, room, clientInfo, msg.answer);
      break;
    }

    case 'play_again': {
      const room = rooms.get(clientInfo.roomId);
      if (!room || room.hostId !== clientInfo.id) return;
      // Reset room
      room.state = 'waiting';
      room.questionIndex = 0;
      room.questions = [];
      room.currentQuestion = null;
      for (const p of room.players.values()) {
        p.score = 0;
        p.answers = [];
        p.isMiss = false;
      }
      broadcast(room, {
        type: 'room_reset',
        players: getRoomPlayerList(room),
        settings: room.settings,
      });
      break;
    }

    case 'dissolve_room': {
      const room = rooms.get(clientInfo.roomId);
      if (!room || room.hostId !== clientInfo.id) return;
      broadcast(room, { type: 'room_dissolved' });
      clearTimeout(room.questionTimer);
      clearTimeout(room.answerTimer);
      rooms.delete(room.key);
      // Disconnect all players from room
      for (const [ws2, info] of clients) {
        if (info.roomId === room.key) info.roomId = null;
      }
      break;
    }

    case 'leave_room': {
      const room = rooms.get(clientInfo.roomId);
      if (!room) return;
      room.players.delete(clientInfo.id);
      clientInfo.roomId = null;
      broadcast(room, {
        type: 'player_left',
        playerId: clientInfo.id,
        players: getRoomPlayerList(room),
      });
      // If host left, dissolve
      if (room.hostId === clientInfo.id) {
        broadcast(room, { type: 'room_dissolved' });
        rooms.delete(room.key);
      }
      break;
    }

    case 'get_categories': {
      const categories = [...new Set(musicCatalog.songs.map(s => s.category))];
      ws.send(JSON.stringify({ type: 'categories', categories }));
      break;
    }
  }
}

// HTTP Server
const server = http.createServer((req, res) => {
  let urlPath = req.url.split('?')[0];

  // Admin API: save catalog
  if (urlPath === '/admin/catalog' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        if (!data.songs || !Array.isArray(data.songs)) throw new Error('Invalid format');
        fs.writeFileSync(path.join(MUSIC_DIR, 'catalog.json'), JSON.stringify(data, null, 2));
        musicCatalog = data; // reload in memory
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Music files
  if (urlPath.startsWith('/music/')) {
    const filename = path.basename(urlPath);
    // パストラバーサル対策
    if (filename.includes('..') || filename.includes('/')) {
      res.writeHead(400); res.end('Bad request'); return;
    }
    const filePath = path.join(MUSIC_DIR, filename);
    if (!fs.existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end(`Music file not found: ${filename}`);
      return;
    }
    
    const stat = fs.statSync(filePath);
    const ext = path.extname(filename).toLowerCase();
    const mime = MIME_TYPES[ext] || 'application/octet-stream';
    
    // Range request support for audio（ブラウザのシーク機能に必要）
    const range = req.headers.range;
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10) || 0;
      const end = parts[1] ? Math.min(parseInt(parts[1], 10), stat.size - 1) : stat.size - 1;
      
      if (start > end || start >= stat.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
        res.end(); return;
      }
      
      const chunkSize = end - start + 1;
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': mime,
        'Cache-Control': 'no-cache',
      });
      fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Type': mime,
        'Content-Length': stat.size,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-cache',
      });
      fs.createReadStream(filePath).pipe(res);
    }
    return;
  }

  // Static files
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(PUBLIC_DIR, urlPath);
  
  if (!fs.existsSync(filePath)) {
    // SPA fallback
    const indexPath = path.join(PUBLIC_DIR, 'index.html');
    if (fs.existsSync(indexPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      fs.createReadStream(indexPath).pipe(res);
    } else {
      res.writeHead(404); res.end('Not found');
    }
    return;
  }

  const ext = path.extname(filePath);
  const mime = MIME_TYPES[ext] || 'text/plain';
  res.writeHead(200, { 'Content-Type': mime });
  fs.createReadStream(filePath).pipe(res);
});

// WebSocket upgrade
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  const id = generateId();
  clients.set(ws, { id, nickname: null, roomId: null });
  ws.send(JSON.stringify({ type: 'connected', id }));

  ws.on('message', (data) => {
    handleMessage(ws, data.toString());
  });

  ws.on('close', () => {
    const info = clients.get(ws);
    if (info && info.roomId) {
      const room = rooms.get(info.roomId);
      if (room) {
        room.players.delete(info.id);
        
        // If host disconnects, dissolve room
        if (room.hostId === info.id) {
          broadcast(room, { type: 'room_dissolved' });
          clearTimeout(room.questionTimer);
          clearTimeout(room.answerTimer);
          rooms.delete(room.key);
        } else {
          broadcast(room, {
            type: 'player_left',
            playerId: info.id,
            players: getRoomPlayerList(room),
          });
          
          // If game in progress and this player was answering, release buzzer
          if (room.state === 'playing' && room.buzzerPressedBy === info.id) {
            room.buzzerPressedBy = null;
            clearTimeout(room.answerTimer);
            broadcast(room, {
              type: 'answer_result',
              playerId: info.id,
              nickname: info.nickname || '?',
              correct: false,
              answer: '（切断）',
              players: getRoomPlayerList(room),
            });
            // Resume question
            const song = room.currentQuestion;
            if (song) {
              const extraSeconds = room.settings.extraSeconds || 0;
              const remaining = (song.sabiDuration || 15) + extraSeconds;
              room.questionTimer = setTimeout(() => timeoutQuestion(room), remaining * 1000);
            }
          }
          
          // If only 1 player left during game, end it
          if (room.state === 'playing' && room.players.size < 2) {
            clearTimeout(room.questionTimer);
            clearTimeout(room.answerTimer);
            endGame(room);
          }
        }
      }
    }
    clients.delete(ws);
  });
});

server.listen(PORT, () => {
  console.log(`🎵 IntroDone server running at http://localhost:${PORT}`);
  console.log(`📁 Music directory: ${MUSIC_DIR}`);
  console.log(`📋 Edit music/catalog.json to add songs`);
});
