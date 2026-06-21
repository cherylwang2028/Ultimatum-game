# Dynamic Ultimatum Game

A real-time multiplayer web experiment for the **Dynamic Ultimatum Game** — built for cross-device play with WebSocket synchronization and an admin dashboard for experiment data.

## Quick Start (Local)

```bash
cd ultimatum-game
pip3 install -r requirements.txt
export ADMIN_KEY=your-secret-password   # optional, default: admin123
python3 server.py
```

- **Game:** http://localhost:3000
- **Admin:** http://localhost:3000/admin.html

## Deploy to Render (Public Website)

1. Push this folder to a GitHub repository
2. Go to [render.com](https://render.com) → **New** → **Blueprint**
3. Connect your repo — Render reads `render.yaml` automatically
4. After deploy, open your public URL (e.g. `https://ultimatum-game.onrender.com`)
5. Find `ADMIN_KEY` in Render dashboard → **Environment** (auto-generated)

Anyone worldwide can open the URL to play. Share the link + room code.

### Render notes

- Persistent disk (`/var/data`) stores SQLite data across restarts
- Free tier may sleep after inactivity — first visit wakes it (~30s)
- WebSocket works on Render without extra config

## Admin Dashboard

Open `/admin.html` and enter your `ADMIN_KEY`.

### Recorded per round

| Field | Description |
|-------|-------------|
| 房间 / 轮次 | Room code & round number |
| 总额 | Pot size when offer was made |
| 提议者 / 接受者 | Player names |
| 提议者分得 / 接受者分得 | Offer split |
| 结果 | Accept / Reject / Timeout |
| P1 / P2 收益 | Final payoffs |

### Features

- Live stats: accept rate, average splits, reject/timeout counts
- Filter by room code
- Auto-refresh every 15 seconds
- Export all data as CSV

## How to Play

1. **Player 1** clicks **Create Room** and shares the 4-character room code
2. **Player 2** enters the code and clicks **Join Room**
3. Both players click **Ready**
4. **Proposer** clicks **Stop & Propose** and splits the growing pot
5. **Responder** has 10 seconds to **Accept** or **Reject**
6. Reject or timeout → both get **$0**

## Tech Stack

- Python 3 + websockets
- SQLite (persistent experiment data)
- Vanilla HTML/CSS/JS frontend
- Render.com deployment

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port (set by Render) |
| `ADMIN_KEY` | `admin123` | Admin dashboard password |
| `DATA_DIR` | `./data` | SQLite database directory |
