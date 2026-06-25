const KEY_STORAGE = 'ultimatum_admin_key';

let adminKey = sessionStorage.getItem(KEY_STORAGE) || '';
let filterRoom = '';

const loginScreen = document.getElementById('login-screen');
const dashboardScreen = document.getElementById('dashboard-screen');

function showLogin() {
  loginScreen.classList.add('active');
  dashboardScreen.classList.remove('active');
}

function showDashboard() {
  loginScreen.classList.remove('active');
  dashboardScreen.classList.add('active');
}

function apiUrl(path, params = {}) {
  const qs = new URLSearchParams({ ...params, key: adminKey });
  return `${path}?${qs}`;
}

async function verifyKey(key) {
  const res = await fetch(`/api/admin/verify?key=${encodeURIComponent(key)}`);
  const data = await res.json();
  return data.ok;
}

async function loadStats() {
  const res = await fetch(apiUrl('/api/admin/stats'));
  if (!res.ok) throw new Error('Unauthorized');
  const s = await res.json();

  document.getElementById('stat-rounds').textContent = s.total_rounds || 0;
  document.getElementById('stat-accept').textContent = `${s.accept_rate || 0}%`;
  document.getElementById('stat-reject').textContent = s.reject_count || 0;
  document.getElementById('stat-timeout').textContent = s.timeout_count || 0;
  document.getElementById('stat-avg-prop').textContent = `$${Math.round(s.avg_proposer_offer || 0)}`;
  document.getElementById('stat-avg-resp').textContent = `$${Math.round(s.avg_responder_offer || 0)}`;
}

function formatTime(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleString('zh-CN', { hour12: false });
  } catch {
    return iso;
  }
}

function decisionBadge(row) {
  if (row.timeout) return '<span class="badge-timeout">超时</span>';
  if (row.accepted) return '<span class="badge-accept">接受</span>';
  return '<span class="badge-reject">拒绝</span>';
}

async function loadRounds() {
  const params = { limit: 500 };
  if (filterRoom) params.room = filterRoom;

  const res = await fetch(apiUrl('/api/admin/rounds', params));
  if (!res.ok) throw new Error('Unauthorized');
  const rounds = await res.json();

  const tbody = document.getElementById('table-body');
  if (!rounds.length) {
    tbody.innerHTML = '<tr><td colspan="11" class="empty-row">暂无数据 — 玩家开始游戏后会自动记录</td></tr>';
    return;
  }

  tbody.innerHTML = rounds.map((r) => `
    <tr>
      <td>${formatTime(r.recorded_at)}</td>
      <td>${r.room_code}</td>
      <td>${r.round_number}</td>
      <td>$${r.pot_at_proposal}</td>
      <td>${escapeHtml(r.proposer_name || '—')}</td>
      <td>${escapeHtml(r.responder_name || '—')}</td>
      <td>$${r.proposer_gets}</td>
      <td>$${r.responder_gets}</td>
      <td>${decisionBadge(r)}</td>
      <td>$${r.p1_payoff}</td>
      <td>$${r.p2_payoff}</td>
    </tr>
  `).join('');
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

async function refresh() {
  try {
    await loadStats();
    await loadRounds();
  } catch {
    sessionStorage.removeItem(KEY_STORAGE);
    adminKey = '';
    showLogin();
  }
}

document.getElementById('btn-login').addEventListener('click', async () => {
  const key = document.getElementById('admin-key-input').value.trim();
  if (!key) return;

  const ok = await verifyKey(key);
  if (!ok) {
    document.getElementById('login-error').classList.remove('hidden');
    return;
  }

  adminKey = key;
  sessionStorage.setItem(KEY_STORAGE, key);
  document.getElementById('login-error').classList.add('hidden');
  document.getElementById('btn-export').href = apiUrl('/api/admin/export');
  showDashboard();
  await refresh();
});

document.getElementById('btn-logout').addEventListener('click', () => {
  sessionStorage.removeItem(KEY_STORAGE);
  adminKey = '';
  showLogin();
});

document.getElementById('btn-refresh').addEventListener('click', refresh);

document.getElementById('btn-filter').addEventListener('click', () => {
  filterRoom = document.getElementById('filter-room').value.trim().toUpperCase();
  loadRounds();
});

document.getElementById('btn-clear-filter').addEventListener('click', () => {
  filterRoom = '';
  document.getElementById('filter-room').value = '';
  loadRounds();
});

document.getElementById('filter-room').addEventListener('input', (e) => {
  e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
});

// Auto-refresh every 15s when dashboard is visible
setInterval(() => {
  if (dashboardScreen.classList.contains('active')) refresh();
}, 15000);

// Auto-login if key stored
(async () => {
  if (adminKey && await verifyKey(adminKey)) {
    document.getElementById('btn-export').href = apiUrl('/api/admin/export');
    showDashboard();
    await refresh();
  }
})();
