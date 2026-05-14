const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 3001;
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('BREACH PROTOCOL // SIGNAL SERVER ONLINE');
});

const wss = new WebSocket.Server({ server });

// rooms: { roomId: { players: [ws, ws], seed: number, diff: number, matrixNum: 0, debuffs: [null, null], ...} }
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

      case 'create': {
        let roomId;
        do { roomId = genRoomId(); } while (rooms.has(roomId));
        const seed = Math.floor(Math.random() * 999999);
        const room = {
          players: [ws],
          seed,
          diff: msg.diff || 0,
          started: false,
          matrixNum: 0, // 0-4 (5 матриц)
          scores: [{ completedMatrices: 0, surrenders: 0 }, { completedMatrices: 0, surrenders: 0 }],
          debuffs: [null, null], // active debuff for each player
          matrixStartTime: null,
        };
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
        ws.send(JSON.stringify({
          type: 'joined',
          roomId,
          playerIndex: 1,
          seed: room.seed,
          diff: room.diff,
          opponentHandle: room.players[0].handle,
        }));
        broadcast(room, {
          type: 'opponent_joined',
          opponentHandle: ws.handle,
        }, ws);
        console.log(`Room ${roomId}: ${ws.handle} joined`);
        break;
      }

      case 'set_diff': {
        const room = rooms.get(ws.roomId);
        if (!room || ws.playerIndex !== 0) return;
        room.diff = msg.diff;
        broadcastAll(room, { type: 'diff_changed', diff: msg.diff });
        break;
      }

      case 'start': {
        const room = rooms.get(ws.roomId);
        if (!room || ws.playerIndex !== 0 || room.players.length < 2) return;
        room.started = true;
        room.matrixNum = 0;
        room.scores = [{ completedMatrices: 0, surrenders: 0 }, { completedMatrices: 0, surrenders: 0 }];
        room.debuffs = [null, null];
        const seed = Math.floor(Math.random() * 999999) + room.seed;
        broadcastAll(room, {
          type: 'mp_game_start',
          seed,
          diff: room.diff,
          matrixNum: 0,
        });
        console.log(`Room ${ws.roomId}: PvP started`);
        break;
      }

      // Игрок нажал первую ячейку - стартует таймер
      case 'first_pick': {
        const room = rooms.get(ws.roomId);
        if (!room) return;
        room.matrixStartTime = Date.now();
        broadcast(room, { type: 'timer_start' }, ws);
        break;
      }

      // Игрок завершил матрицу
      case 'matrix_complete': {
        const room = rooms.get(ws.roomId);
        if (!room) return;
        room.scores[ws.playerIndex].completedMatrices++;
        const completed = room.scores[ws.playerIndex].completedMatrices;
        // Отправляем обоим
        broadcastAll(room, {
          type: 'opponent_matrix_complete',
          playerIndex: ws.playerIndex,
          completedMatrices: completed,
          timeMs: Date.now() - (room.matrixStartTime || Date.now()),
        });
        // Проверяем победу (5 матриц)
        if (completed >= 5) {
          broadcastAll(room, {
            type: 'mp_match_end',
            winner: ws.playerIndex,
            scores: room.scores,
          });
          console.log(`Room ${ws.roomId}: Player ${ws.playerIndex} won!`);
        }
        break;
      }

      // Игрок сдаётся (меняет матрицу)
      case 'surrender': {
        const room = rooms.get(ws.roomId);
        if (!room) return;
        room.scores[ws.playerIndex].surrenders++;
        const surrenders = room.scores[ws.playerIndex].surrenders;
        // Если сдался 3 раза - проигрыш
        if (surrenders >= 3) {
          const winner = ws.playerIndex === 0 ? 1 : 0;
          broadcastAll(room, {
            type: 'mp_match_end',
            winner,
            scores: room.scores,
            reason: 'surrender_limit',
          });
          console.log(`Room ${ws.roomId}: Player ${ws.playerIndex} surrendered too many times`);
        } else {
          // Переходим на новую матрицу
          room.matrixNum++;
          room.debuffs = [null, null];
          const seed = Math.floor(Math.random() * 999999) + room.seed + room.matrixNum * 7919;
          broadcastAll(room, {
            type: 'next_matrix',
            matrixNum: room.matrixNum,
            seed,
            playerSurrendered: ws.playerIndex,
            surrendersRemaining: 3 - surrenders,
          });
        }
        break;
      }

      // Игрок наложил дебафф на противника
      case 'apply_debuff': {
        const room = rooms.get(ws.roomId);
        if (!room) return;
        const oppIdx = ws.playerIndex === 0 ? 1 : 0;
        room.debuffs[oppIdx] = msg.debuff; // 'slow_ice', 'hide_cells', 'smaller_buffer' и т.д.
        broadcast(room, {
          type: 'debuff_applied',
          debuff: msg.debuff,
        }, ws);
        break;
      }

      case 'ping': {
        ws.send(JSON.stringify({ type: 'pong' }));
        break;
      }
    }
  });

  ws.on('close', () => {
    const room = rooms.get(ws.roomId);
    if (!room) return;
    if (room.started) {
      // Противник автоматически выигрывает
      const winner = ws.playerIndex === 0 ? 1 : 0;
      broadcast(room, {
        type: 'opponent_disconnected',
        winner,
      }, ws);
    }
    room.players = room.players.filter(p => p !== ws);
    if (room.players.length === 0) {
      rooms.delete(ws.roomId);
      console.log(`Room ${ws.roomId} deleted (empty)`);
    }
  });
});

server.listen(PORT, () => console.log(`Breach signal server on port ${PORT}`));

setInterval(() => {
  const now = Date.now();
  for (const [id, room] of rooms.entries()) {
    if (room.players.every(p => p.readyState !== WebSocket.OPEN)) {
      rooms.delete(id);
      console.log(`Cleaned stale room ${id}`);
    }
  }
}, 600000);
