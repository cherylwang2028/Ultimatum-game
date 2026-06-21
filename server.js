const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, 'public')));

const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function generateRoomCode() {
  let code = '';
  for (let i = 0; i < 4; i++) code += CHARS[Math.floor(Math.random() * CHARS.length)];
  return code;
}

const rooms = new Map();

const GROWTH_RATES = { slow: 2000, normal: 1000, fast: 500 };
const DEFAULT_CAP = 500;
const DECISION_TIME = 10;

function createRoom(code) {
  const room = {
    code,
    players: [],
    state: 'waiting',
    settings: { speed: 'normal', cap: DEFAULT_CAP },
    amount: 100,
    baseAmount: 100,
    growthInterval: null,
    offer: null,
    result: null,
    decisionTimer: null,
    decisionTimeLeft: DECISION_TIME,
    round: 1,
    paused: false,
    pausedAmount: 100,
  };
  rooms.set(code, room);
  return room;
}

function getRoom(code) {
  return rooms.get(code?.toUpperCase());
}

function broadcast(room, data, excludeWs = null) {
  const msg = JSON.stringify(data);
  room.players.forEach((p) => {
    if (p.ws && p.ws.readyState === 1 && p.ws !== excludeWs) {
      p.ws.send(msg);
    }
  });
}

function sendTo(ws, data) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(data));
}

function roomSnapshot(room) {
  return {
    code: room.code,
    state: room.state,
    players: room.players.map((p) => ({
      id: p.id,
      role: p.role,
      ready: p.ready,
      connected: p.ws?.readyState === 1,
      name: p.name,
    })),
    settings: room.settings,
    amount: room.amount,
    baseAmount: room.baseAmount,
    offer: room.offer,
    result: room.result,
    decisionTimeLeft: room.decisionTimeLeft,
    round: room.round,
    paused: room.paused,
  };
}

function syncRoom(room) {
  broadcast(room, { type: 'sync', data: roomSnapshot(room) });
}

function clearGrowth(room) {
  if (room.growthInterval) {
    clearInterval(room.growthInterval);
    room.growthInterval = null;
  }
}

function clearDecisionTimer(room) {
  if (room.decisionTimer) {
    clearInterval(room.decisionTimer);
    room.decisionTimer = null;
  }
}

function startGrowth(room) {
  clearGrowth(room);
  const step = Math.max(10, Math.floor(room.baseAmount * 0.1));
  const ms = GROWTH_RATES[room.settings.speed] || GROWTH_RATES.normal;

  room.growthInterval = setInterval(() => {
    if (room.paused || room.state !== 'running') return;
    if (room.amount >= room.settings.cap) {
      room.amount = room.settings.cap;
      clearGrowth(room);
      syncRoom(room);
      return;
    }
    room.amount = Math.min(room.amount + step, room.settings.cap);
    broadcast(room, { type: 'amount', amount: room.amount });
  }, ms);
}

function startDecisionTimer(room) {
  clearDecisionTimer(room);
  room.decisionTimeLeft = DECISION_TIME;

  room.decisionTimer = setInterval(() => {
    if (room.paused || room.state !== 'proposed') return;
    room.decisionTimeLeft -= 1;
    broadcast(room, { type: 'timer', timeLeft: room.decisionTimeLeft });

    if (room.decisionTimeLeft <= 0) {
      clearDecisionTimer(room);
      resolveRound(room, false, true);
    }
  }, 1000);
}

function resolveRound(room, accepted, timeout = false) {
  clearDecisionTimer(room);
  clearGrowth(room);

  const offer = room.offer;
  let p1Payoff = 0;
  let p2Payoff = 0;

  if (accepted && offer) {
    p1Payoff = offer.proposerGets;
    p2Payoff = offer.responderGets;
  }

  room.result = {
    accepted,
    timeout,
    p1Payoff,
    p2Payoff,
    offer: { ...offer },
  };
  room.state = 'result';
  syncRoom(room);
}

function startRound(room) {
  clearGrowth(room);
  clearDecisionTimer(room);
  room.amount = room.baseAmount;
  room.offer = null;
  room.result = null;
  room.state = 'running';
  room.paused = false;
  syncRoom(room);
  startGrowth(room);
}

function tryStartGame(room) {
  if (room.players.length < 2) return;
  const allReady = room.players.every((p) => p.ready && p.ws?.readyState === 1);
  if (!allReady) return;

  room.players[0].role = 'proposer';
  room.players[1].role = 'responder';
  room.baseAmount = 100;
  room.amount = 100;
  room.round = 1;
  startRound(room);
}

function handleDisconnect(ws) {
  const { roomCode, playerId } = ws;
  if (!roomCode) return;

  const room = getRoom(roomCode);
  if (!room) return;

  const player = room.players.find((p) => p.id === playerId);
  if (!player) return;

  player.ws = null;
  player.ready = false;

  if (room.state === 'running' || room.state === 'proposed') {
    room.paused = true;
    room.pausedAmount = room.amount;
    clearGrowth(room);
    clearDecisionTimer(room);
  }

  syncRoom(room);
}

wss.on('connection', (ws) => {
  ws.roomCode = null;
  ws.playerId = null;

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      handleMessage(ws, msg);
    } catch {
      sendTo(ws, { type: 'error', message: 'Invalid message' });
    }
  });

  ws.on('close', () => handleDisconnect(ws));
});

function handleMessage(ws, msg) {
  switch (msg.type) {
    case 'create_room':
      handleCreateRoom(ws, msg);
      break;
    case 'join_room':
      handleJoinRoom(ws, msg);
      break;
    case 'reconnect':
      handleReconnect(ws, msg);
      break;
    case 'ready':
      handleReady(ws, msg);
      break;
    case 'update_settings':
      handleUpdateSettings(ws, msg);
      break;
    case 'start_game':
      handleStartGame(ws);
      break;
    case 'propose':
      handlePropose(ws, msg);
      break;
    case 'accept':
      handleAccept(ws);
      break;
    case 'reject':
      handleReject(ws);
      break;
    case 'next_round':
      handleNextRound(ws);
      break;
    default:
      sendTo(ws, { type: 'error', message: 'Unknown message type' });
  }
}

function handleCreateRoom(ws, msg) {
  let code = generateRoomCode();
  while (rooms.has(code)) code = generateRoomCode();

  const room = createRoom(code);
  const player = {
    id: 'p1',
    ws,
    role: null,
    ready: false,
    name: msg.name || 'Player 1',
  };
  room.players.push(player);

  ws.roomCode = code;
  ws.playerId = player.id;

  sendTo(ws, { type: 'joined', data: roomSnapshot(room), playerId: player.id });
}

function handleJoinRoom(ws, msg) {
  const code = msg.code?.toUpperCase();
  const room = getRoom(code);

  if (!room) {
    sendTo(ws, { type: 'error', message: 'Room not found' });
    return;
  }
  if (room.players.length >= 2) {
    sendTo(ws, { type: 'error', message: 'Room is full' });
    return;
  }
  if (room.state !== 'waiting') {
    sendTo(ws, { type: 'error', message: 'Game already in progress' });
    return;
  }

  const player = {
    id: 'p2',
    ws,
    role: null,
    ready: false,
    name: msg.name || 'Player 2',
  };
  room.players.push(player);

  ws.roomCode = code;
  ws.playerId = player.id;

  sendTo(ws, { type: 'joined', data: roomSnapshot(room), playerId: player.id });
  syncRoom(room);
}

function handleReconnect(ws, msg) {
  const code = msg.code?.toUpperCase();
  const room = getRoom(code);
  if (!room) {
    sendTo(ws, { type: 'error', message: 'Room not found' });
    return;
  }

  const player = room.players.find((p) => p.id === msg.playerId);
  if (!player) {
    sendTo(ws, { type: 'error', message: 'Player not found' });
    return;
  }

  player.ws = ws;
  ws.roomCode = code;
  ws.playerId = player.id;

  if (room.paused && player.ws?.readyState === 1) {
    const otherConnected = room.players.every((p) => p.ws?.readyState === 1);
    if (otherConnected) {
      room.paused = false;
      room.amount = room.pausedAmount;
      if (room.state === 'running') startGrowth(room);
      else if (room.state === 'proposed') startDecisionTimer(room);
    }
  }

  sendTo(ws, { type: 'reconnected', data: roomSnapshot(room), playerId: player.id });
  syncRoom(room);
}

function handleReady(ws) {
  const room = getRoom(ws.roomCode);
  if (!room) return;

  const player = room.players.find((p) => p.id === ws.playerId);
  if (!player) return;

  player.ready = !player.ready;
  syncRoom(room);
  tryStartGame(room);
}

function handleUpdateSettings(ws, msg) {
  const room = getRoom(ws.roomCode);
  if (!room || room.state !== 'waiting') return;

  if (msg.speed && GROWTH_RATES[msg.speed]) room.settings.speed = msg.speed;
  if (msg.cap && msg.cap >= 100) room.settings.cap = Math.min(msg.cap, 10000);

  syncRoom(room);
}

function handleStartGame(ws) {
  const room = getRoom(ws.roomCode);
  if (!room || room.players.length < 2) return;

  room.players.forEach((p) => (p.ready = true));
  tryStartGame(room);
}

function handlePropose(ws, msg) {
  const room = getRoom(ws.roomCode);
  if (!room || room.state !== 'running') return;

  const player = room.players.find((p) => p.id === ws.playerId);
  if (!player || player.role !== 'proposer') return;

  const proposerGets = Math.round(Number(msg.proposerGets));
  const responderGets = Math.round(Number(msg.responderGets));
  const total = proposerGets + responderGets;

  if (total !== room.amount || proposerGets < 0 || responderGets < 0) {
    sendTo(ws, { type: 'error', message: 'Invalid offer — must split current amount exactly' });
    return;
  }

  clearGrowth(room);
  room.offer = { proposerGets, responderGets };
  room.state = 'proposed';
  syncRoom(room);
  startDecisionTimer(room);
}

function handleAccept(ws) {
  const room = getRoom(ws.roomCode);
  if (!room || room.state !== 'proposed') return;

  const player = room.players.find((p) => p.id === ws.playerId);
  if (!player || player.role !== 'responder') return;

  resolveRound(room, true);
}

function handleReject(ws) {
  const room = getRoom(ws.roomCode);
  if (!room || room.state !== 'proposed') return;

  const player = room.players.find((p) => p.id === ws.playerId);
  if (!player || player.role !== 'responder') return;

  resolveRound(room, false);
}

function handleNextRound(ws) {
  const room = getRoom(ws.roomCode);
  if (!room || room.state !== 'result') return;

  room.round += 1;
  room.baseAmount = Math.min(room.baseAmount + 20, room.settings.cap);
  startRound(room);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Dynamic Ultimatum Game running at http://localhost:${PORT}`);
});
