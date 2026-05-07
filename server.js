const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');

const PORT = process.env.PORT || 3000;

// ─── HTTP Server ───
const server = http.createServer((req, res) => {
  let filePath = path.join(__dirname, 'public', req.url === '/' ? 'index.html' : req.url);
  const ext = path.extname(filePath);
  const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png' };
  fs.readFile(filePath, (err, data) => {
    if (err) {
      fs.readFile(path.join(__dirname, 'public', 'index.html'), (e, d) => {
        res.writeHead(e ? 404 : 200, { 'Content-Type': 'text/html' });
        res.end(e ? 'Not Found' : d);
      });
    } else {
      res.writeHead(200, { 'Content-Type': mime[ext] || 'text/plain' });
      res.end(data);
    }
  });
});

// ─── Constants ───
const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const RANK_VAL = { '2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13,'A':14 };
const HEART = '♥';
const BOT_NAMES = ['🤖 زيدان', '🤖 عمر', '🤖 سالم'];

// ─── State ───
const rooms = new Map();
const clients = new Map();

// ─── Helpers ───
function buildDeck() {
  const d = [];
  for (const s of SUITS) for (const r of RANKS) d.push({ suit: s, rank: r });
  return d;
}

function shuffle(d) {
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

function trickWinner(trick) {
  const leadSuit = trick[0].card.suit;
  const hearts = trick.filter(x => x.card.suit === HEART);
  if (hearts.length > 0)
    return hearts.reduce((a, b) => RANK_VAL[a.card.rank] >= RANK_VAL[b.card.rank] ? a : b).player;
  const sameSuit = trick.filter(x => x.card.suit === leadSuit);
  return sameSuit.reduce((a, b) => RANK_VAL[a.card.rank] >= RANK_VAL[b.card.rank] ? a : b).player;
}

function checkMajira(trick) {
  const qH = trick.find(x => x.card.suit === HEART && x.card.rank === 'Q');
  if (!qH) return null;
  const killer = trick.find(x => x.card.suit === HEART && (x.card.rank === 'A' || x.card.rank === 'K') && x.player !== qH.player);
  if (killer) return { victim: qH.player, killer: killer.player };
  return null;
}

function allowedBids(score) {
  if (score < 0)    return [3, 4, 5, 7];
  if (score <= 10)  return [0, 2, 3, 4, 5, 7];
  if (score <= 16)  return [3, 4, 5, 7];
  if (score <= 19)  return [4, 5, 7];
  return [5, 7];
}

function isValidPlay(hand, card, currentTrick) {
  if (currentTrick.length === 0) return true;
  const leadSuit = currentTrick[0].card.suit;
  const hasSuit = hand.some(c => c.suit === leadSuit);
  if (hasSuit) return card.suit === leadSuit;
  const hasHeart = hand.some(c => c.suit === HEART);
  if (hasHeart) return card.suit === HEART;
  return true;
}

// ─── Bot AI ───
function chooseBotCard(hand, currentTrick) {
  if (currentTrick.length === 0) {
    const nonHearts = hand.filter(c => c.suit !== HEART);
    const pool = nonHearts.length > 0 ? nonHearts : hand;
    return pool.reduce((a, b) => RANK_VAL[a.rank] <= RANK_VAL[b.rank] ? a : b);
  }
  const leadSuit = currentTrick[0].card.suit;
  const same = hand.filter(c => c.suit === leadSuit);
  if (same.length > 0) {
    const winnerEntry = currentTrick.find(t => t.player === trickWinner(currentTrick));
    const winCards = same.filter(c => RANK_VAL[c.rank] > RANK_VAL[winnerEntry?.card?.rank || '2']);
    if (winCards.length > 0)
      return winCards.reduce((a, b) => RANK_VAL[a.rank] <= RANK_VAL[b.rank] ? a : b);
    return same.reduce((a, b) => RANK_VAL[a.rank] <= RANK_VAL[b.rank] ? a : b);
  }
  const hearts = hand.filter(c => c.suit === HEART);
  if (hearts.length > 0)
    return hearts.reduce((a, b) => RANK_VAL[a.rank] <= RANK_VAL[b.rank] ? a : b);
  return hand.reduce((a, b) => RANK_VAL[a.rank] <= RANK_VAL[b.rank] ? a : b);
}

function chooseBotBid(score) {
  const opts = allowedBids(score);
  return opts[Math.floor(opts.length / 2)];
}

// ─── Room ───
function createRoom(hostId, hostName) {
  const roomId = uuidv4().substring(0, 8).toUpperCase();
  const room = {
    id: roomId,
    players: [{ id: hostId, name: hostName, connected: true, isBot: false }],
    scores: [0, 0, 0, 0],
    hands: [[], [], [], []],
    bids: [-1, -1, -1, -1],
    tricksTaken: [0, 0, 0, 0],
    currentTrick: [],
    currentPlayer: 0,
    leadPlayer: 0,
    lafa: 1,
    phase: 'waiting',
    biddingPlayer: 0,
    gameOver: false,
    lastTrickResult: null,
    majiraEvent: null,
    roundChanges: null,
    botTimers: [],
  };
  rooms.set(roomId, room);
  return room;
}

function fillWithBots(room) {
  let botIdx = 0;
  while (room.players.length < 4) {
    room.players.push({
      id: 'bot-' + uuidv4(),
      name: BOT_NAMES[botIdx] || `🤖 بوت ${botIdx + 1}`,
      connected: true,
      isBot: true,
    });
    botIdx++;
  }
}

function getPlayerIndex(room, playerId) {
  return room.players.findIndex(p => p.id === playerId);
}

function sendToPlayer(room, playerId, msg) {
  for (const [ws, info] of clients) {
    if (info.roomId === room.id && info.playerId === playerId) {
      if (ws.readyState === 1) ws.send(JSON.stringify(msg));
    }
  }
}

function broadcast(room, msg) {
  for (const [ws, info] of clients) {
    if (info.roomId === room.id) {
      if (ws.readyState === 1) ws.send(JSON.stringify(msg));
    }
  }
}

function sendRoomState(room) {
  for (let i = 0; i < room.players.length; i++) {
    if (room.players[i].isBot) continue;
    sendToPlayer(room, room.players[i].id, { type: 'state', state: buildStateForPlayer(room, i) });
  }
}

function buildStateForPlayer(room, playerIdx) {
  return {
    roomId: room.id,
    players: room.players.map((p, i) => ({
      name: p.name,
      connected: p.connected,
      isBot: p.isBot,
      score: room.scores[i],
      bid: room.bids[i],
      tricksTaken: room.tricksTaken[i],
      cardCount: room.hands[i] ? room.hands[i].length : 0,
      isCurrentPlayer: room.currentPlayer === i,
    })),
    myIndex: playerIdx,
    myHand: room.hands[playerIdx] || [],
    currentTrick: room.currentTrick,
    phase: room.phase,
    lafa: room.lafa,
    currentPlayer: room.currentPlayer,
    biddingPlayer: room.biddingPlayer,
    allowedBids: room.phase === 'bidding' && room.biddingPlayer === playerIdx
      ? allowedBids(room.scores[playerIdx]) : null,
    gameOver: room.gameOver,
    winnerName: room.winnerName || null,
    loserName: room.loserName || null,
    lastTrickResult: room.lastTrickResult || null,
    majiraEvent: room.majiraEvent || null,
    roundChanges: room.roundChanges || null,
    botCount: room.players.filter(p => p.isBot).length,
  };
}

// ─── Deal ───
function dealRound(room) {
  room.botTimers.forEach(t => clearTimeout(t));
  room.botTimers = [];

  const deck = shuffle(buildDeck());
  room.hands = [[], [], [], []];
  room.tricksTaken = [0, 0, 0, 0];
  room.bids = [-1, -1, -1, -1];
  room.currentTrick = [];
  room.leadPlayer = 0;
  room.currentPlayer = 0;
  room.lastTrickResult = null;
  room.majiraEvent = null;

  for (let i = 0; i < 52; i++) room.hands[i % 4].push(deck[i]);
  room.hands.forEach(h => h.sort((a, b) => {
    const si = SUITS.indexOf(a.suit) - SUITS.indexOf(b.suit);
    return si !== 0 ? si : RANK_VAL[a.rank] - RANK_VAL[b.rank];
  }));

  if (room.lafa === 1) {
    room.phase = 'playing';
    scheduleBot(room);
  } else {
    room.phase = 'bidding';
    room.biddingPlayer = 0;
    scheduleBotBid(room);
  }
}

// ─── Bot Scheduling ───
function scheduleBot(room) {
  if (room.phase !== 'playing') return;
  if (!room.players[room.currentPlayer]?.isBot) return;
  if (room.lastTrickResult && room.lastTrickResult.trick.length === 4) return;

  const t = setTimeout(() => {
    if (room.phase !== 'playing') return;
    if (!room.players[room.currentPlayer]?.isBot) return;
    botPlayCard(room);
  }, 1000);
  room.botTimers.push(t);
}

function scheduleBotBid(room) {
  if (room.phase !== 'bidding') return;
  if (!room.players[room.biddingPlayer]?.isBot) return;

  const t = setTimeout(() => {
    if (room.phase !== 'bidding') return;
    if (!room.players[room.biddingPlayer]?.isBot) return;
    const pi = room.biddingPlayer;
    room.bids[pi] = chooseBotBid(room.scores[pi]);
    room.biddingPlayer++;
    if (room.biddingPlayer >= 4) {
      room.phase = 'playing';
      room.currentPlayer = room.leadPlayer;
      sendRoomState(room);
      scheduleBot(room);
    } else {
      sendRoomState(room);
      scheduleBotBid(room);
    }
  }, 900);
  room.botTimers.push(t);
}

function botPlayCard(room) {
  const pi = room.currentPlayer;
  if (!room.players[pi]?.isBot) return;
  const hand = room.hands[pi];
  if (!hand || hand.length === 0) return;

  const card = chooseBotCard(hand, room.currentTrick);
  const idx = hand.findIndex(c => c.rank === card.rank && c.suit === card.suit);
  if (idx === -1) return;

  hand.splice(idx, 1);
  room.currentTrick.push({ player: pi, card, playerName: room.players[pi].name });

  if (room.currentTrick.length === 4) {
    sendRoomState(room);
    const t = setTimeout(() => {
      resolveTrick(room);
      sendRoomState(room);
      if (room.phase === 'playing') {
        const isNextBot = room.players[room.currentPlayer]?.isBot;
        const delay = isNextBot ? 1600 : 1800;
        const t2 = setTimeout(() => {
          room.lastTrickResult = null;
          room.majiraEvent = null;
          sendRoomState(room);
          scheduleBot(room);
        }, delay);
        room.botTimers.push(t2);
      }
    }, 1000);
    room.botTimers.push(t);
  } else {
    room.currentPlayer = (room.currentPlayer + 1) % 4;
    sendRoomState(room);
    scheduleBot(room);
  }
}

// ─── Resolve / End ───
function resolveTrick(room) {
  const winner = trickWinner(room.currentTrick);
  room.tricksTaken[winner]++;
  room.majiraEvent = null;

  const maj = checkMajira(room.currentTrick);
  if (maj) {
    room.scores[maj.victim] -= 5;
    room.scores[maj.killer] += 5;
    room.majiraEvent = {
      victimName: room.players[maj.victim].name,
      killerName: room.players[maj.killer].name,
      victimIdx: maj.victim,
    };
  }

  room.lastTrickResult = {
    winnerIdx: winner,
    winnerName: room.players[winner].name,
    trick: [...room.currentTrick],
  };

  room.currentTrick = [];
  room.leadPlayer = winner;
  room.currentPlayer = winner;

  if (room.hands[0].length === 0) endRound(room);
}

function endRound(room) {
  room.botTimers.forEach(t => clearTimeout(t));
  room.botTimers = [];
  room.phase = 'summary';

  const changes = [];
  for (let i = 0; i < 4; i++) {
    const got = room.tricksTaken[i];
    let delta = 0;
    if (room.lafa === 1) {
      delta = got >= 3 ? got : -3;
    } else {
      const bid = room.bids[i];
      delta = got >= bid ? bid : -bid;
    }
    room.scores[i] += delta;
    changes.push({ name: room.players[i].name, got, bid: room.bids[i], delta, total: room.scores[i] });
  }
  room.roundChanges = changes;

  const loserIdx = room.scores.findIndex(s => s <= -11);
  const winnerIdx = room.scores.indexOf(Math.max(...room.scores));

  if (loserIdx !== -1 || room.scores.some(s => s >= 21)) {
    room.gameOver = true;
    room.winnerName = room.players[winnerIdx].name;
    room.loserName = loserIdx !== -1 ? room.players[loserIdx].name : null;
  }
}

// ─── WebSocket Handler ───
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    handleMessage(ws, msg);
  });

  ws.on('close', () => {
    const info = clients.get(ws);
    if (info) {
      const room = rooms.get(info.roomId);
      if (room) {
        const pi = getPlayerIndex(room, info.playerId);
        if (pi !== -1) room.players[pi].connected = false;
        broadcast(room, { type: 'playerDisconnected', name: room.players[pi]?.name });
        sendRoomState(room);
      }
      clients.delete(ws);
    }
  });
});

function handleMessage(ws, msg) {
  switch (msg.type) {

    case 'createRoom': {
      const playerId = uuidv4();
      const room = createRoom(playerId, msg.name || 'لاعب 1');
      clients.set(ws, { playerId, roomId: room.id });
      ws.send(JSON.stringify({ type: 'roomCreated', roomId: room.id, playerId }));
      sendRoomState(room);
      break;
    }

    case 'joinRoom': {
      const room = rooms.get(msg.roomId);
      if (!room) { ws.send(JSON.stringify({ type: 'error', msg: 'الغرفة غير موجودة' })); return; }

      if (room.phase !== 'waiting') {
        const existing = room.players.findIndex(p => p.id === msg.playerId && !p.isBot);
        if (existing === -1) { ws.send(JSON.stringify({ type: 'error', msg: 'اللعبة بدأت بالفعل' })); return; }
        room.players[existing].connected = true;
        clients.set(ws, { playerId: msg.playerId, roomId: room.id });
        ws.send(JSON.stringify({ type: 'joinedRoom', roomId: room.id, playerId: msg.playerId }));
        sendRoomState(room);
        return;
      }

      const realCount = room.players.filter(p => !p.isBot).length;
      if (realCount >= 4) { ws.send(JSON.stringify({ type: 'error', msg: 'الغرفة ممتلئة' })); return; }

      const existing = room.players.findIndex(p => p.id === msg.playerId);
      let playerId;
      if (existing !== -1) {
        playerId = msg.playerId;
        room.players[existing].connected = true;
        clients.set(ws, { playerId, roomId: room.id });
      } else {
        playerId = uuidv4();
        room.players.push({ id: playerId, name: msg.name || `لاعب ${room.players.length + 1}`, connected: true, isBot: false });
        clients.set(ws, { playerId, roomId: room.id });
      }

      ws.send(JSON.stringify({ type: 'joinedRoom', roomId: room.id, playerId }));
      broadcast(room, { type: 'playerJoined', name: msg.name, count: room.players.filter(p => !p.isBot).length });
      sendRoomState(room);
      break;
    }

    case 'startGame': {
      const info = clients.get(ws);
      if (!info) return;
      const room = rooms.get(info.roomId);
      if (!room || room.phase !== 'waiting') return;
      if (getPlayerIndex(room, info.playerId) !== 0) return;

      fillWithBots(room);
      dealRound(room);
      sendRoomState(room);
      break;
    }

    case 'placeBid': {
      const info = clients.get(ws);
      if (!info) return;
      const room = rooms.get(info.roomId);
      if (!room || room.phase !== 'bidding') return;
      const pi = getPlayerIndex(room, info.playerId);
      if (pi !== room.biddingPlayer) return;

      const allowed = allowedBids(room.scores[pi]);
      if (!allowed.includes(msg.bid)) return;

      room.bids[pi] = msg.bid;
      room.biddingPlayer++;

      if (room.biddingPlayer >= 4) {
        room.phase = 'playing';
        room.currentPlayer = room.leadPlayer;
        sendRoomState(room);
        scheduleBot(room);
      } else {
        sendRoomState(room);
        scheduleBotBid(room);
      }
      break;
    }

    case 'playCard': {
      const info = clients.get(ws);
      if (!info) return;
      const room = rooms.get(info.roomId);
      if (!room || room.phase !== 'playing') return;
      const pi = getPlayerIndex(room, info.playerId);
      if (pi !== room.currentPlayer || room.players[pi].isBot) return;
      if (room.lastTrickResult && room.lastTrickResult.trick.length === 4) return;

      const card = msg.card;
      const hand = room.hands[pi];
      const idx = hand.findIndex(c => c.rank === card.rank && c.suit === card.suit);
      if (idx === -1) return;
      if (!isValidPlay(hand, card, room.currentTrick)) {
        ws.send(JSON.stringify({ type: 'invalidPlay', msg: 'لا يمكنك لعب هذه الورقة' }));
        return;
      }

      hand.splice(idx, 1);
      room.currentTrick.push({ player: pi, card, playerName: room.players[pi].name });

      if (room.currentTrick.length === 4) {
        sendRoomState(room);
        const t = setTimeout(() => {
          resolveTrick(room);
          sendRoomState(room);
          if (room.phase === 'playing') {
            const isNextBot = room.players[room.currentPlayer]?.isBot;
            if (isNextBot) {
              const t2 = setTimeout(() => {
                room.lastTrickResult = null;
                room.majiraEvent = null;
                sendRoomState(room);
                scheduleBot(room);
              }, 1800);
              room.botTimers.push(t2);
            }
          }
        }, 1000);
        room.botTimers.push(t);
      } else {
        room.currentPlayer = (room.currentPlayer + 1) % 4;
        sendRoomState(room);
        scheduleBot(room);
      }
      break;
    }

    case 'nextTrick': {
      const info = clients.get(ws);
      if (!info) return;
      const room = rooms.get(info.roomId);
      if (!room || room.phase !== 'playing') return;
      room.lastTrickResult = null;
      room.majiraEvent = null;
      sendRoomState(room);
      scheduleBot(room);
      break;
    }

    case 'nextRound': {
      const info = clients.get(ws);
      if (!info) return;
      const room = rooms.get(info.roomId);
      if (!room || room.phase !== 'summary') return;
      if (getPlayerIndex(room, info.playerId) !== 0) return;

      if (room.gameOver) {
        room.scores = [0, 0, 0, 0];
        room.lafa = 1;
        room.gameOver = false;
        room.winnerName = null;
        room.loserName = null;
        room.players = room.players.filter(p => !p.isBot);
        room.phase = 'waiting';
        sendRoomState(room);
      } else {
        room.lafa++;
        room.roundChanges = null;
        dealRound(room);
        sendRoomState(room);
      }
      break;
    }
  }
}

server.listen(PORT, () => {
  console.log(`🎴 كوبي سيرفر شغال على http://localhost:${PORT}`);
});
