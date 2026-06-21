"""SQLite persistence for ultimatum game experiment data."""

import csv
import io
import os
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

DATA_DIR = Path(os.environ.get("DATA_DIR", Path(__file__).parent / "data"))
DB_PATH = DATA_DIR / "game_data.db"

_lock = threading.Lock()


def _connect():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    with _lock:
        conn = _connect()
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                room_code TEXT NOT NULL,
                started_at TEXT NOT NULL,
                proposer_name TEXT,
                responder_name TEXT
            );

            CREATE TABLE IF NOT EXISTS rounds (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id INTEGER,
                room_code TEXT NOT NULL,
                round_number INTEGER NOT NULL,
                pot_at_proposal INTEGER NOT NULL,
                proposer_name TEXT,
                responder_name TEXT,
                proposer_gets INTEGER NOT NULL,
                responder_gets INTEGER NOT NULL,
                accepted INTEGER NOT NULL,
                timeout INTEGER NOT NULL DEFAULT 0,
                p1_payoff INTEGER NOT NULL,
                p2_payoff INTEGER NOT NULL,
                recorded_at TEXT NOT NULL,
                FOREIGN KEY (session_id) REFERENCES sessions(id)
            );

            CREATE INDEX IF NOT EXISTS idx_rounds_room ON rounds(room_code);
            CREATE INDEX IF NOT EXISTS idx_rounds_time ON rounds(recorded_at);
            """
        )
        conn.commit()
        conn.close()


def create_session(room_code: str, proposer_name: str, responder_name: str) -> int:
    now = datetime.now(timezone.utc).isoformat()
    with _lock:
        conn = _connect()
        cur = conn.execute(
            "INSERT INTO sessions (room_code, started_at, proposer_name, responder_name) VALUES (?, ?, ?, ?)",
            (room_code, now, proposer_name, responder_name),
        )
        sid = cur.lastrowid
        conn.commit()
        conn.close()
        return sid


def log_round(
    session_id: int,
    room_code: str,
    round_number: int,
    pot_at_proposal: int,
    proposer_name: str,
    responder_name: str,
    proposer_gets: int,
    responder_gets: int,
    accepted: bool,
    timeout: bool,
    p1_payoff: int,
    p2_payoff: int,
):
    now = datetime.now(timezone.utc).isoformat()
    with _lock:
        conn = _connect()
        conn.execute(
            """
            INSERT INTO rounds (
                session_id, room_code, round_number, pot_at_proposal,
                proposer_name, responder_name, proposer_gets, responder_gets,
                accepted, timeout, p1_payoff, p2_payoff, recorded_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                session_id,
                room_code,
                round_number,
                pot_at_proposal,
                proposer_name,
                responder_name,
                proposer_gets,
                responder_gets,
                1 if accepted else 0,
                1 if timeout else 0,
                p1_payoff,
                p2_payoff,
                now,
            ),
        )
        conn.commit()
        conn.close()


def get_rounds(limit: int = 500, room_code: Optional[str] = None):
    with _lock:
        conn = _connect()
        if room_code:
            rows = conn.execute(
                """
                SELECT * FROM rounds WHERE room_code = ? ORDER BY recorded_at DESC LIMIT ?
                """,
                (room_code.upper(), limit),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM rounds ORDER BY recorded_at DESC LIMIT ?",
                (limit,),
            ).fetchall()
        conn.close()
        return [dict(r) for r in rows]


def get_stats():
    with _lock:
        conn = _connect()
        row = conn.execute(
            """
            SELECT
                COUNT(*) AS total_rounds,
                SUM(accepted) AS accepted_count,
                SUM(CASE WHEN timeout = 1 THEN 1 ELSE 0 END) AS timeout_count,
                AVG(proposer_gets) AS avg_proposer_offer,
                AVG(responder_gets) AS avg_responder_offer,
                AVG(p1_payoff) AS avg_p1_payoff,
                AVG(p2_payoff) AS avg_p2_payoff,
                COUNT(DISTINCT room_code) AS unique_rooms
            FROM rounds
            """
        ).fetchone()
        sessions = conn.execute("SELECT COUNT(*) AS c FROM sessions").fetchone()["c"]
        conn.close()
        stats = dict(row)
        stats["sessions"] = sessions
        stats["total_rounds"] = stats["total_rounds"] or 0
        stats["accepted_count"] = stats["accepted_count"] or 0
        stats["timeout_count"] = stats["timeout_count"] or 0
        stats["reject_count"] = stats["total_rounds"] - stats["accepted_count"] - stats["timeout_count"]
        if stats["total_rounds"]:
            stats["accept_rate"] = round(stats["accepted_count"] / stats["total_rounds"] * 100, 1)
        else:
            stats["accept_rate"] = 0
        return stats


def export_csv():
    rounds = get_rounds(limit=10000)
    output = io.StringIO()
    if not rounds:
        return ""
    writer = csv.DictWriter(output, fieldnames=rounds[0].keys())
    writer.writeheader()
    writer.writerows(rounds)
    return output.getvalue()
