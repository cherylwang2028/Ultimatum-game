#!/usr/bin/env python3
"""Dynamic Ultimatum Game — fixed rounds, WebSocket server with admin logging."""

import asyncio
import json
import mimetypes
import os
import random
import urllib.parse
from pathlib import Path

from websockets.asyncio.server import serve
from websockets.datastructures import Headers
from websockets.http11 import Response

from database import (
    create_session,
    export_csv,
    get_rounds,
    get_stats,
    init_db,
    log_round,
)

PUBLIC = Path(__file__).parent / "public"
CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

# Game rules: 3 rounds, fixed escalating amounts, 15s decision timer
ROUND_AMOUNTS = [100, 500, 1000]
TOTAL_ROUNDS = 3
DECISION_TIME = 15
ADMIN_KEY = os.environ.get("ADMIN_KEY", "admin123")

rooms: dict = {}


def gen_code():
    return "".join(random.choice(CHARS) for _ in range(4))


def player_names(room):
    p1 = next((p["name"] for p in room["players"] if p["id"] == "p1"), "Player 1")
    p2 = next((p["name"] for p in room["players"] if p["id"] == "p2"), "Player 2")
    return p1, p2


def round_amount(round_num: int) -> int:
    idx = min(round_num - 1, len(ROUND_AMOUNTS) - 1)
    return ROUND_AMOUNTS[idx]


def snapshot(room):
    return {
        "code": room["code"],
        "state": room["state"],
        "players": [
            {
                "id": p["id"],
                "role": p["role"],
                "ready": p["ready"],
                "connected": p["ws"] is not None,
                "name": p["name"],
            }
            for p in room["players"]
        ],
        "amount": room["amount"],
        "offer": room["offer"],
        "result": room["result"],
        "decisionTimeLeft": room["decisionTimeLeft"],
        "round": room["round"],
        "totalRounds": TOTAL_ROUNDS,
        "roundAmounts": ROUND_AMOUNTS,
        "sessionPayoffs": room.get("session_payoffs", {"p1": 0, "p2": 0}),
        "paused": room["paused"],
    }


async def broadcast(room, data, exclude=None):
    msg = json.dumps(data)
    for p in room["players"]:
        ws = p["ws"]
        if ws and ws != exclude:
            try:
                await ws.send(msg)
            except Exception:
                pass


async def sync_room(room):
    await broadcast(room, {"type": "sync", "data": snapshot(room)})


def clear_decision(room):
    task = room.get("decision_task")
    if task:
        task.cancel()
        room["decision_task"] = None


async def decision_loop(room):
    try:
        while room["decisionTimeLeft"] > 0 and room["state"] == "proposed" and not room["paused"]:
            await asyncio.sleep(1)
            if room["state"] != "proposed" or room["paused"]:
                break
            room["decisionTimeLeft"] -= 1
            await broadcast(room, {"type": "timer", "timeLeft": room["decisionTimeLeft"]})
        if room["state"] == "proposed" and room["decisionTimeLeft"] <= 0:
            await resolve_round(room, False, timeout=True)
    except asyncio.CancelledError:
        pass


async def start_decision(room):
    clear_decision(room)
    room["decisionTimeLeft"] = DECISION_TIME
    room["decision_task"] = asyncio.create_task(decision_loop(room))


async def resolve_round(room, accepted, timeout=False):
    clear_decision(room)
    offer = room["offer"]
    p1, p2 = 0, 0
    if accepted and offer:
        p1 = offer["proposerGets"]
        p2 = offer["responderGets"]

    room["session_payoffs"]["p1"] += p1
    room["session_payoffs"]["p2"] += p2

    room["result"] = {
        "accepted": accepted,
        "timeout": timeout,
        "p1Payoff": p1,
        "p2Payoff": p2,
        "offer": dict(offer) if offer else None,
        "round": room["round"],
        "isLastRound": room["round"] >= TOTAL_ROUNDS,
    }
    room["state"] = "result"

    if offer:
        proposer_name, responder_name = player_names(room)
        pot = room.get("pot_at_proposal", offer["proposerGets"] + offer["responderGets"])
        try:
            log_round(
                session_id=room.get("session_id"),
                room_code=room["code"],
                round_number=room["round"],
                pot_at_proposal=pot,
                proposer_name=proposer_name,
                responder_name=responder_name,
                proposer_gets=offer["proposerGets"],
                responder_gets=offer["responderGets"],
                accepted=accepted,
                timeout=timeout,
                p1_payoff=p1,
                p2_payoff=p2,
            )
        except Exception as exc:
            print(f"[db] log_round error: {exc}")

    await sync_room(room)


async def start_round(room):
    clear_decision(room)
    amount = round_amount(room["round"])
    room["amount"] = amount
    room["offer"] = None
    room["result"] = None
    room["pot_at_proposal"] = None
    room["state"] = "running"
    room["paused"] = False
    await sync_room(room)


async def try_start_game(room):
    if len(room["players"]) < 2:
        return
    if not all(p["ready"] and p["ws"] for p in room["players"]):
        return
    room["players"][0]["role"] = "proposer"
    room["players"][1]["role"] = "responder"
    room["round"] = 1
    room["session_payoffs"] = {"p1": 0, "p2": 0}

    proposer_name, responder_name = player_names(room)
    try:
        room["session_id"] = create_session(room["code"], proposer_name, responder_name)
    except Exception as exc:
        print(f"[db] create_session error: {exc}")
        room["session_id"] = None

    await start_round(room)


async def handle_disconnect(ws):
    room_code = ws.room_code
    player_id = ws.player_id
    if not room_code:
        return
    room = rooms.get(room_code)
    if not room:
        return
    player = next((p for p in room["players"] if p["id"] == player_id), None)
    if not player:
        return
    player["ws"] = None
    player["ready"] = False
    if room["state"] in ("running", "proposed"):
        room["paused"] = True
        clear_decision(room)
    await sync_room(room)


async def handler(ws):
    ws.room_code = None
    ws.player_id = None
    try:
        async for raw in ws:
            msg = json.loads(raw)
            await process(ws, msg)
    except Exception:
        pass
    finally:
        await handle_disconnect(ws)


def new_room(code):
    return {
        "code": code,
        "players": [],
        "state": "waiting",
        "amount": ROUND_AMOUNTS[0],
        "offer": None,
        "result": None,
        "decisionTimeLeft": DECISION_TIME,
        "round": 1,
        "paused": False,
        "decision_task": None,
        "session_id": None,
        "pot_at_proposal": None,
        "session_payoffs": {"p1": 0, "p2": 0},
    }


async def process(ws, msg):
    t = msg.get("type")

    if t == "create_room":
        code = gen_code()
        while code in rooms:
            code = gen_code()
        room = new_room(code)
        rooms[code] = room
        player = {"id": "p1", "ws": ws, "role": None, "ready": False, "name": msg.get("name", "Player 1")}
        room["players"].append(player)
        ws.room_code = code
        ws.player_id = "p1"
        await ws.send(json.dumps({"type": "joined", "data": snapshot(room), "playerId": "p1"}))

    elif t == "join_room":
        code = msg.get("code", "").upper()
        room = rooms.get(code)
        if not room:
            await ws.send(json.dumps({"type": "error", "message": "Room not found"}))
            return
        if len(room["players"]) >= 2:
            await ws.send(json.dumps({"type": "error", "message": "Room is full"}))
            return
        if room["state"] != "waiting":
            await ws.send(json.dumps({"type": "error", "message": "Game already in progress"}))
            return
        player = {"id": "p2", "ws": ws, "role": None, "ready": False, "name": msg.get("name", "Player 2")}
        room["players"].append(player)
        ws.room_code = code
        ws.player_id = "p2"
        await ws.send(json.dumps({"type": "joined", "data": snapshot(room), "playerId": "p2"}))
        await sync_room(room)

    elif t == "reconnect":
        code = msg.get("code", "").upper()
        room = rooms.get(code)
        if not room:
            await ws.send(json.dumps({"type": "error", "message": "Room not found"}))
            return
        player = next((p for p in room["players"] if p["id"] == msg.get("playerId")), None)
        if not player:
            await ws.send(json.dumps({"type": "error", "message": "Player not found"}))
            return
        player["ws"] = ws
        ws.room_code = code
        ws.player_id = player["id"]
        if room["paused"] and all(p["ws"] for p in room["players"]):
            room["paused"] = False
            if room["state"] == "proposed":
                await start_decision(room)
        await ws.send(json.dumps({"type": "reconnected", "data": snapshot(room), "playerId": player["id"]}))
        await sync_room(room)

    else:
        room = rooms.get(ws.room_code)
        if not room:
            return
        player = next((p for p in room["players"] if p["id"] == ws.player_id), None)
        if not player:
            return

        if t == "ready":
            player["ready"] = not player["ready"]
            await sync_room(room)
            await try_start_game(room)

        elif t == "start_game" and len(room["players"]) >= 2:
            for p in room["players"]:
                p["ready"] = True
            await try_start_game(room)

        elif t == "propose" and room["state"] == "running" and player["role"] == "proposer":
            pg = int(msg.get("proposerGets", 0))
            rg = int(msg.get("responderGets", 0))
            if pg + rg != room["amount"] or pg < 0 or rg < 0:
                await ws.send(json.dumps({"type": "error", "message": "Invalid offer"}))
                return
            room["pot_at_proposal"] = room["amount"]
            room["offer"] = {"proposerGets": pg, "responderGets": rg}
            room["state"] = "proposed"
            await sync_room(room)
            await start_decision(room)

        elif t == "accept" and room["state"] == "proposed" and player["role"] == "responder":
            await resolve_round(room, True)

        elif t == "reject" and room["state"] == "proposed" and player["role"] == "responder":
            await resolve_round(room, False)

        elif t == "next_round" and room["state"] == "result":
            if room["round"] >= TOTAL_ROUNDS:
                room["state"] = "finished"
                await sync_room(room)
            else:
                room["round"] += 1
                await start_round(room)


def check_admin_key(request):
    qs = urllib.parse.parse_qs(request.path.split("?", 1)[1] if "?" in request.path else "")
    key = qs.get("key", [None])[0]
    if not key:
        key = request.headers.get("X-Admin-Key")
    return key == ADMIN_KEY


def json_response(data, status=200):
    body = json.dumps(data, ensure_ascii=False).encode("utf-8")
    headers = Headers()
    headers["Content-Type"] = "application/json; charset=utf-8"
    headers["Content-Length"] = str(len(body))
    return Response(status, "OK", headers, body)


async def handle_admin_api(connection, request):
    path = request.path.split("?")[0]

    if path == "/api/admin/verify":
        if check_admin_key(request):
            return json_response({"ok": True})
        return json_response({"ok": False}, status=403)

    if not check_admin_key(request):
        return json_response({"error": "Unauthorized"}, status=403)

    if path == "/api/admin/stats":
        return json_response(get_stats())

    if path == "/api/admin/rounds":
        qs = urllib.parse.parse_qs(request.path.split("?", 1)[1] if "?" in request.path else "")
        room = qs.get("room", [None])[0]
        limit = int(qs.get("limit", ["500"])[0])
        return json_response(get_rounds(limit=limit, room_code=room))

    if path == "/api/admin/export":
        csv_data = export_csv()
        headers = Headers()
        headers["Content-Type"] = "text/csv; charset=utf-8"
        headers["Content-Disposition"] = "attachment; filename=ultimatum_rounds.csv"
        body = csv_data.encode("utf-8")
        headers["Content-Length"] = str(len(body))
        return Response(200, "OK", headers, body)

    return connection.respond(404, "Not Found")


async def serve_static(connection, request):
    if request.headers.get("Upgrade", "").lower() == "websocket":
        return None

    path_str = request.path.split("?")[0]

    if path_str.startswith("/api/admin"):
        return await handle_admin_api(connection, request)

    if path_str == "/":
        path_str = "/index.html"

    file_path = (PUBLIC / path_str.lstrip("/")).resolve()
    public_root = PUBLIC.resolve()
    if not str(file_path).startswith(str(public_root)):
        return connection.respond(403, "Forbidden")
    if not file_path.is_file():
        return connection.respond(404, "Not Found")

    body = file_path.read_bytes()
    ctype = mimetypes.guess_type(str(file_path))[0] or "application/octet-stream"
    headers = Headers()
    headers["Content-Type"] = ctype
    headers["Content-Length"] = str(len(body))
    return Response(200, "OK", headers, body)


async def main():
    init_db()
    port = int(os.environ.get("PORT", 3000))
    print(f"Dynamic Ultimatum Game → http://0.0.0.0:{port}")
    print(f"Rounds: {ROUND_AMOUNTS}, decision time: {DECISION_TIME}s")
    print(f"Admin dashboard → http://0.0.0.0:{port}/admin.html")
    if ADMIN_KEY == "admin123":
        print("WARNING: Set ADMIN_KEY env var for production!")
    async with serve(handler, "0.0.0.0", port, process_request=serve_static):
        await asyncio.Future()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
