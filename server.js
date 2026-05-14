const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 3001;
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('BREACH PROTOCOL // SIGNAL SERVER ONLINE');
});

const wss = new WebSocket.Server({ server });

// rooms: { roomId: { players: [ws, ws], seed: number, diff: number } }
const rooms = new Map();

function genRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = '';
  for (let i = 0; i < 6; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

function broadcast(room, msg, excludeWs = null) {
  room.players.forEach(p => {
    if (p !== excludeWs && p.readyState === WebSocket.OPEN)
      p.send(JSON.stringify(msg));
  });
}

function broadcastAll(room, msg) {
  room.players.forEach(p => {
    if (p.readyState === WebSocket.OPEN) p.send(JSON.stringify(msg));
  });
}

wss.on('connection', (ws) => {
  ws.roomId = null;
  ws.playerIndex = null;
  ws.handle = 'АНОНИМ';

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      // ── CREATE ROOM ──────────────────────────────────
      case 'create': {
        let roomId;
        do { roomId = genRoomId(); } while (rooms.has(roomId));
        const seed = Math.floor(Math.random() * 999999);
        const room = { players: [ws], seed, diff: msg.diff || 0, started: false, scores: [null, null] };
        rooms.set(roomId, room);
        ws.roomId = roomId;
        ws.playerIndex = 0;
        ws.handle = msg.handle || 'ИГРОК 1';
        ws.send(JSON.stringify({
          type: 'created',
          roomId,
          playerIndex: 0,
          seed,
          diff: room.diff,
        }));
        console.log(`Room ${roomId} created by ${ws.handle}`);
        break;
      }

      // ── JOIN ROOM ─────────────────────────────────────
      case 'join': {
        const roomId = (msg.roomId || '').toUpperCase().trim();
        const room = rooms.get(roomId);
        if (!room) { ws.send(JSON.stringify({ type: 'error', msg: 'Комната не найдена' })); return; }
        if (room.players.length >= 2) { ws.send(JSON.stringify({ type: 'error', msg: 'Комната заполнена' })); return; }
        if (room.started) { ws.send(JSON.stringify({ type: 'error', msg: 'Игра уже идёт' })); return; }
        room.players.push(ws);
        ws.roomId = roomId;
        ws.playerIndex = 1;
        ws.handle = msg.handle || 'ИГРОК 2';
        // Tell joiner their info + seed
        ws.send(JSON.stringify({
          type: 'joined',
          roomId,
          playerIndex: 1,
          seed: room.seed,
          diff: room.diff,
          opponentHandle: room.players[0].handle,
        }));
        // Tell host opponent joined
        broadcast(room, {
          type: 'opponent_joined',
          opponentHandle: ws.handle,
        }, ws);
        console.log(`Room ${roomId}: ${ws.handle} joined`);
        break;
      }

      // ── SET DIFF (host only) ──────────────────────────
      case 'set_diff': {
        const room = rooms.get(ws.roomId);
        if (!room || ws.playerIndex !== 0) return;
        room.diff = msg.diff;
        broadcastAll(room, { type: 'diff_changed', diff: msg.diff });
        break;
      }

      // ── START GAME ────────────────────────────────────
      case 'start': {
        const room = rooms.get(ws.roomId);
        if (!room || ws.playerIndex !== 0 || room.players.length < 2) return;
        room.started = true;
        room.startTime = Date.now();
        room.scores = [null, null];
        broadcastAll(room, {
          type: 'game_start',
          seed: room.seed,
          diff: room.diff,
        });
        console.log(`Room ${ws.roomId}: game started`);
        break;
      }

      // ── PROGRESS UPDATE (broadcast to opponent) ───────
      case 'progress': {
        const room = rooms.get(ws.roomId);
        if (!room) return;
        broadcast(room, {
          type: 'opponent_progress',
          cracked: msg.cracked,
          total: msg.total,
          moves: msg.moves,
        }, ws);
        break;
      }

      // ── FINISH ────────────────────────────────────────
      case 'finish': {
        const room = rooms.get(ws.roomId);
        if (!room) return;
        room.scores[ws.playerIndex] = {
          handle: ws.handle,
          cracked: msg.cracked,
          total: msg.total,
          moves: msg.moves,
          timeMs: Date.now() - room.startTime,
          type: msg.resultType, // 'win' | 'partial' | 'fail'
        };
        // Tell opponent this player finished
        broadcast(room, {
          type: 'opponent_finished',
          cracked: msg.cracked,
          total: msg.total,
          moves: msg.moves,
          timeMs: room.scores[ws.playerIndex].timeMs,
          resultType: msg.resultType,
        }, ws);
        // If both finished → send final result to everyone
        if (room.scores[0] && room.scores[1]) {
          const [s0, s1] = room.scores;
          // Determine winner: more cracked → faster → fewer moves
          let winner = null;
          if (s0.cracked !== s1.cracked) winner = s0.cracked > s1.cracked ? 0 : 1;
          else if (s0.timeMs !== s1.timeMs) winner = s0.timeMs < s1.timeMs ? 0 : 1;
          else winner = s0.moves <= s1.moves ? 0 : 1;
          broadcastAll(room, {
            type: 'match_result',
            winner,
            scores: room.scores,
          });
          console.log(`Room ${ws.roomId}: match over, winner player ${winner}`);
        }
        break;
      }

      // ── EMOTE ─────────────────────────────────────────
      case 'emote': {
        const room = rooms.get(ws.roomId);
        if (!room) return;
        broadcast(room, { type: 'emote', text: msg.text, handle: ws.handle }, ws);
        break;
      }

      // ── PING ──────────────────────────────────────────
      case 'ping': {
        ws.send(JSON.stringify({ type: 'pong' }));
        break;
      }
    }
  });

  ws.on('close', () => {
    const room = rooms.get(ws.roomId);
    if (!room) return;
    broadcast(room, { type: 'opponent_left' }, ws);
    room.players = room.players.filter(p => p !== ws);
    if (room.players.length === 0) {
      rooms.delete(ws.roomId);
      console.log(`Room ${ws.roomId} deleted (empty)`);
    }
  });
});

server.listen(PORT, () => console.log(`Breach signal server on port ${PORT}`));

// Clean up empty/stale rooms every 10 min
setInterval(() => {
  const now = Date.now();
  for (const [id, room] of rooms.entries()) {
    if (room.players.every(p => p.readyState !== WebSocket.OPEN)) {
      rooms.delete(id);
      console.log(`Cleaned stale room ${id}`);
    }
  }
}, 600000);
