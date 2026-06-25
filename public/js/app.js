/* Dynamic Ultimatum Game — Client */

const DECISION_TIME = 15;
const DEFAULT_ROUND_AMOUNTS = [100, 500, 1000];
const TOTAL_ROUNDS = 3;
const STORAGE_KEY = 'ultimatum_session';

let ws = null;
let playerId = null;
let roomCode = null;
let gameState = null;
let reconnectTimer = null;
let displayAmount = 100;

const screens = {
  lobby: document.getElementById('screen-lobby'),
  waiting: document.getElementById('screen-waiting'),
  game: document.getElementById('screen-game'),
  result: document.getElementById('screen-result'),
  finished: document.getElementById('screen-finished'),
};

const $ = (id) => document.getElementById(id);

function showScreen(name) {
  Object.values(screens).forEach((s) => s.classList.remove('active'));
  screens[name]?.classList.add('active');
}

function showToast(msg) {
  const toast = $('toast');
  toast.textContent = msg;
  toast.classList.remove('hidden');
  setTimeout(() => toast.classList.add('hidden'), 3500);
}

function saveSession() {
  if (roomCode && playerId) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ roomCode, playerId }));
  }
}

function tryReconnect() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return false;
  try {
    const { roomCode: code, playerId: id } = JSON.parse(raw);
    if (!code || !id) return false;
    roomCode = code;
    playerId = id;
    connectWS(() => {
      ws.send(JSON.stringify({ type: 'reconnect', code: roomCode, playerId }));
    });
    $('reconnect-overlay').classList.remove('hidden');
    return true;
  } catch {
    return false;
  }
}

function connectWS(onOpen) {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}`);

  ws.onopen = () => {
    if (onOpen) onOpen();
  };

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    handleMessage(msg);
  };

  ws.onclose = () => {
    $('reconnect-overlay').classList.remove('hidden');
    scheduleReconnect();
  };

  ws.onerror = () => showToast('Connection error');
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (roomCode && playerId) {
      connectWS(() => {
        ws.send(JSON.stringify({ type: 'reconnect', code: roomCode, playerId }));
      });
    }
  }, 2000);
}

function clearSession() {
  localStorage.removeItem(STORAGE_KEY);
  roomCode = null;
  playerId = null;
  gameState = null;
}

function returnToLobby() {
  clearSession();
  $('pause-overlay').classList.add('hidden');
  showScreen('lobby');
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'joined':
      playerId = msg.playerId;
      roomCode = msg.data.code;
      saveSession();
      applyState(msg.data);
      showScreen('waiting');
      break;
    case 'reconnected':
      $('reconnect-overlay').classList.add('hidden');
      playerId = msg.playerId;
      applyState(msg.data);
      routeToScreen(msg.data);
      break;
    case 'sync':
      applyState(msg.data);
      break;
    case 'timer':
      updateTimer(msg.timeLeft);
      break;
    case 'left':
      returnToLobby();
      showToast('Left the room');
      break;
    case 'game_ended':
      returnToLobby();
      showToast('Game ended');
      break;
    case 'error':
      showToast(msg.message);
      break;
  }
}

function routeToScreen(data) {
  if (data.state === 'waiting') showScreen('waiting');
  else if (data.state === 'finished') showScreen('finished');
  else if (data.state === 'result') showScreen('result');
  else showScreen('game');
}

function applyState(data) {
  gameState = data;
  $('reconnect-overlay').classList.add('hidden');

  if (data.paused) {
    $('pause-overlay').classList.remove('hidden');
  } else {
    $('pause-overlay').classList.add('hidden');
  }

  updateWaitingUI(data);
  updateGameUI(data);
  updateResultUI(data);
  updateFinishedUI(data);
  routeToScreen(data);
}

function updateWaitingUI(data) {
  if (data.state !== 'waiting') return;

  $('waiting-room-code').textContent = data.code;

  const p1 = data.players.find((p) => p.id === 'p1');
  const p2 = data.players.find((p) => p.id === 'p2');

  if (p1) {
    $('name-p1').textContent = p1.name;
    $('role-p1').textContent = p1.role || 'Proposer';
    setConnected('status-p1', 'slot-p1', p1.connected);
  }
  if (p2) {
    $('name-p2').textContent = p2.name;
    $('role-p2').textContent = p2.role || 'Responder';
    setConnected('status-p2', 'slot-p2', p2.connected);
  } else {
    $('name-p2').textContent = 'Waiting…';
    $('role-p2').textContent = 'Responder';
    setConnected('status-p2', 'slot-p2', false);
  }

  const me = data.players.find((p) => p.id === playerId);
  const readyBtn = $('btn-ready');
  if (me) {
    readyBtn.textContent = me.ready ? 'Ready ✓' : 'Ready';
    readyBtn.classList.toggle('btn--ready-on', me.ready);
  }
}

function setConnected(dotId, slotId, connected) {
  const dot = $(dotId);
  const slot = $(slotId);
  dot.classList.toggle('connected', connected);
  slot?.classList.toggle('connected', connected);
}

function updateRoundProgress(data) {
  const total = data.totalRounds || TOTAL_ROUNDS;
  const round = data.round || 1;
  const amounts = data.roundAmounts || DEFAULT_ROUND_AMOUNTS;
  const pct = (round / total) * 100;

  $('round-badge').textContent = `Round ${round} of ${total}`;
  $('round-progress').style.width = `${pct}%`;
  $('round-amounts-hint').textContent =
    `Round ${round} of ${total} · ${amounts.map((a) => `$${a}`).join(' → ')}`;
}

function updateGameUI(data) {
  if (data.state === 'waiting' || data.state === 'finished') return;

  updateRoundProgress(data);
  setAmount(data.amount);

  const me = data.players.find((p) => p.id === playerId);
  if (!me) return;

  const isProposer = me.role === 'proposer';
  const isResponder = me.role === 'responder';

  $('panel-proposer').classList.toggle('hidden', !isProposer);
  $('panel-responder').classList.toggle('hidden', !isResponder);
  $('panel-waiting-decision').classList.add('hidden');

  if (data.state === 'running') {
    if (isProposer) {
      $('offer-form').classList.add('hidden');
      $('btn-stop-propose').classList.remove('hidden');
    }
    if (isResponder) {
      $('waiting-proposal').classList.remove('hidden');
      $('decision-area').classList.add('hidden');
    }
  }

  if (data.state === 'proposed' && data.offer) {
    const offer = data.offer;

    if (isProposer) {
      $('panel-proposer').classList.add('hidden');
      $('panel-waiting-decision').classList.remove('hidden');
      $('offer-sent-display').textContent =
        `You: $${offer.proposerGets} · Other: $${offer.responderGets}`;
      $('proposer-timer').textContent = data.decisionTimeLeft;
    }

    if (isResponder) {
      $('waiting-proposal').classList.add('hidden');
      $('decision-area').classList.remove('hidden');
      $('recv-you').textContent = `$${offer.responderGets}`;
      $('recv-other').textContent = `$${offer.proposerGets}`;
      updateTimer(data.decisionTimeLeft);
    }
  }

  const allConnected = data.players.every((p) => p.connected);
  const connDot = $('game-connection').querySelector('.status-dot');
  connDot?.classList.toggle('connected', allConnected);
}

function setAmount(val) {
  displayAmount = val;
  $('amount-number').textContent = val;
}

function updateTimer(timeLeft) {
  $('timer-text').textContent = timeLeft;
  $('proposer-timer').textContent = timeLeft;

  const circle = $('timer-progress');
  const circumference = 283;
  const offset = circumference * (1 - timeLeft / DECISION_TIME);
  circle.style.strokeDashoffset = offset;
}

function mySessionPayoff(data) {
  const me = data.players.find((p) => p.id === playerId);
  const sp = data.sessionPayoffs || { p1: 0, p2: 0 };
  if (!me) return 0;
  return me.role === 'proposer' ? sp.p1 : sp.p2;
}

function otherSessionPayoff(data) {
  const me = data.players.find((p) => p.id === playerId);
  const sp = data.sessionPayoffs || { p1: 0, p2: 0 };
  if (!me) return 0;
  return me.role === 'proposer' ? sp.p2 : sp.p1;
}

function updateResultUI(data) {
  if (data.state !== 'result' || !data.result) return;

  const r = data.result;
  const me = data.players.find((p) => p.id === playerId);
  const isProposer = me?.role === 'proposer';

  const myPayoff = isProposer ? r.p1Payoff : r.p2Payoff;
  const otherPayoff = isProposer ? r.p2Payoff : r.p1Payoff;

  const card = $('result-card');
  card.classList.toggle('accepted', r.accepted);
  card.classList.toggle('rejected', !r.accepted);

  $('result-icon').textContent = r.accepted ? '✓' : '✕';
  $('result-title').textContent = r.accepted ? 'Accepted!' : 'Rejected';
  $('result-sub').textContent = r.timeout
    ? 'Time ran out — offer rejected automatically.'
    : r.accepted
      ? `Round ${r.round} complete. Payoffs distributed.`
      : 'Offer rejected — both players receive $0 this round.';

  $('result-you').textContent = `$${myPayoff}`;
  $('result-other').textContent = `$${otherPayoff}`;

  const btn = $('btn-next-round');
  if (r.isLastRound) {
    btn.textContent = 'View Session Summary';
    btn.classList.remove('hidden');
  } else {
    btn.textContent = 'Next Round';
    btn.classList.remove('hidden');
  }
}

function updateFinishedUI(data) {
  if (data.state !== 'finished') return;

  $('finished-you').textContent = `$${mySessionPayoff(data)}`;
  $('finished-other').textContent = `$${otherSessionPayoff(data)}`;
}

function syncOfferInputs(total) {
  const you = parseInt($('input-you').value) || 0;
  const other = parseInt($('input-other').value) || 0;
  const youPct = total > 0 ? (you / total) * 100 : 50;

  $('split-you-bar').style.width = `${youPct}%`;
  $('split-other-bar').style.width = `${100 - youPct}%`;
  $('split-you-label').textContent = you;
  $('split-other-label').textContent = other;
  $('share-slider').value = youPct;
}

function initOfferForm(amount) {
  const half = Math.floor(amount / 2);
  $('input-you').value = half;
  $('input-other').value = amount - half;
  $('input-you').max = amount;
  $('input-other').max = amount;
  $('share-slider').max = amount;
  syncOfferInputs(amount);
}

$('btn-create').addEventListener('click', () => {
  const name = $('create-name').value.trim() || 'Player 1';
  connectWS(() => {
    ws.send(JSON.stringify({ type: 'create_room', name }));
  });
});

$('btn-join').addEventListener('click', () => {
  const name = $('join-name').value.trim() || 'Player 2';
  const code = $('join-code').value.trim().toUpperCase();
  if (code.length !== 4) {
    showToast('Enter a 4-character room code');
    return;
  }
  connectWS(() => {
    ws.send(JSON.stringify({ type: 'join_room', code, name }));
  });
});

$('join-code').addEventListener('input', (e) => {
  e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
});

$('btn-ready').addEventListener('click', () => {
  ws?.send(JSON.stringify({ type: 'ready' }));
});

$('btn-start').addEventListener('click', () => {
  ws?.send(JSON.stringify({ type: 'start_game' }));
});

$('btn-return-lobby').addEventListener('click', () => {
  ws?.send(JSON.stringify({ type: 'leave_room' }));
});

function confirmEndGame() {
  if (confirm('End this game for both players and return to the lobby?')) {
    ws?.send(JSON.stringify({ type: 'end_game' }));
  }
}

$('btn-end-game').addEventListener('click', confirmEndGame);
$('btn-end-game-result').addEventListener('click', confirmEndGame);

$('btn-stop-propose').addEventListener('click', () => {
  const amount = gameState?.amount || displayAmount;
  $('btn-stop-propose').classList.add('hidden');
  $('offer-form').classList.remove('hidden');
  initOfferForm(amount);
});

$('input-you').addEventListener('input', () => {
  const total = gameState?.amount || displayAmount;
  let you = parseInt($('input-you').value) || 0;
  you = Math.max(0, Math.min(you, total));
  $('input-you').value = you;
  $('input-other').value = total - you;
  syncOfferInputs(total);
});

$('input-other').addEventListener('input', () => {
  const total = gameState?.amount || displayAmount;
  let other = parseInt($('input-other').value) || 0;
  other = Math.max(0, Math.min(other, total));
  $('input-other').value = other;
  $('input-you').value = total - other;
  syncOfferInputs(total);
});

$('share-slider').addEventListener('input', (e) => {
  const total = gameState?.amount || displayAmount;
  const you = Math.round((parseInt(e.target.value) / 100) * total);
  $('input-you').value = you;
  $('input-other').value = total - you;
  syncOfferInputs(total);
});

$('btn-submit-offer').addEventListener('click', () => {
  const total = gameState?.amount || displayAmount;
  const proposerGets = parseInt($('input-you').value) || 0;
  const responderGets = parseInt($('input-other').value) || 0;

  if (proposerGets + responderGets !== total) {
    $('offer-error').textContent = `Must split exactly $${total}`;
    $('offer-error').classList.remove('hidden');
    return;
  }

  $('offer-error').classList.add('hidden');
  ws?.send(JSON.stringify({ type: 'propose', proposerGets, responderGets }));
});

$('btn-accept').addEventListener('click', () => {
  ws?.send(JSON.stringify({ type: 'accept' }));
});

$('btn-reject').addEventListener('click', () => {
  ws?.send(JSON.stringify({ type: 'reject' }));
});

$('btn-next-round').addEventListener('click', () => {
  ws?.send(JSON.stringify({ type: 'next_round' }));
});

if (!tryReconnect()) {
  showScreen('lobby');
}
