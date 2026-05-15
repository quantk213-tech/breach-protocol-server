// ====================================================================
// BREACH PROTOCOL — PvP Signal Server
// ====================================================================
// Логика PvP:
//   • У каждого игрока СВОЯ независимая матрица (свой seed)
//   • Игрок сам закрывает 5 матриц подряд — первый дошедший до 5 ВЫИГРАЛ
//   • Можно сдаться (сменить свою текущую матрицу) — максимум 2 раза
//     На 3-й сдаче — проигрыш
//   • Когда игрок закрыл матрицу, у него на 12 секунд открывается
//     возможность кинуть ДЕБАФФ на противника
//   • Прогресс закрытых ячеек транслируется сопернику в real-time
//     (для мини-превью на экране)
// ====================================================================

const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 3001;
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('BREACH PROTOCOL // SIGNAL SERVER ONLINE');
});

const wss = new WebSocket.Server({ server });

// rooms: { roomId: { players: [ws, ws], seed, diff, matrixSeeds:[[],[]], scores, ...} }
const rooms = new Map();

function genRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = '';
  for (let i = 0; i < 6; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

function send(ws, msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function broadcast(room, msg, excludeWs = null) {
  room.players.forEach(p => {
    if (p !== excludeWs) send(p, msg);
  });
}

function broadcastAll(room, msg) {
  room.players.forEach(p => send(p, msg));
}

// Новый seed для конкретного игрока, для конкретной матрицы
function genSeed(room, playerIdx, matrixNum) {
  return (room.seed + playerIdx * 31337 + matrixNum * 7919 + Math.floor(Math.random() * 9999)) & 0x7fffffff;
}

wss.on('connection', (ws) => {
  ws.roomId = null;
  ws.playerIndex = null;
  ws.handle = 'АНОНИМ';

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      // ────────────────────────────────────────────────────
      case 'create': {
        let roomId;
        do { roomId = genRoomId(); } while (rooms.has(roomId));
        const seed = Math.floor(Math.random() * 999999);
        const room = {
          players: [ws],
          seed,
          diff: msg.diff || 0,
          started: false,
          // Для каждого игрока: текущий номер матрицы (0..4)
          // и сид этой матрицы. Сиды независимы.
          curMatrix: [0, 0],
          curSeed: [0, 0],
          scores: [
            { completedMatrices: 0, surrenders: 0 },
            { completedMatrices: 0, surrenders: 0 },
          ],
          // Окно "можно кинуть дебафф" — до timestamp
          debuffWindowUntil: [0, 0],
          // Закрытие ячеек противника
          activeDebuff: [null, null],
        };
        rooms.set(roomId, room);
        ws.roomId = roomId;
        ws.playerIndex = 0;
        ws.handle = msg.handle || 'ИГРОК 1';
        send(ws, {
          type: 'created',
          roomId,
          playerIndex: 0,
          diff: room.diff,
        });
        console.log(`[+] Room ${roomId} created by ${ws.handle}`);
        break;
      }

      // ────────────────────────────────────────────────────
      case 'join': {
        const roomId = (msg.roomId || '').toUpperCase().trim();
        const room = rooms.get(roomId);
        if (!room) { send(ws, { type: 'error', msg: 'Комната не найдена' }); return; }
        if (room.players.length >= 2) { send(ws, { type: 'error', msg: 'Комната заполнена' }); return; }
        if (room.started) { send(ws, { type: 'error', msg: 'Игра уже идёт' }); return; }
        room.players.push(ws);
        ws.roomId = roomId;
        ws.playerIndex = 1;
        ws.handle = msg.handle || 'ИГРОК 2';
        send(ws, {
          type: 'joined',
          roomId,
          playerIndex: 1,
          diff: room.diff,
          opponentHandle: room.players[0].handle,
        });
        broadcast(room, {
          type: 'opponent_joined',
          opponentHandle: ws.handle,
        }, ws);
        console.log(`[+] Room ${roomId}: ${ws.handle} joined`);
        break;
      }

      // ────────────────────────────────────────────────────
      case 'set_diff': {
        const room = rooms.get(ws.roomId);
        if (!room || ws.playerIndex !== 0) return;
        room.diff = msg.diff;
        broadcastAll(room, { type: 'diff_changed', diff: msg.diff });
        break;
      }

      // ────────────────────────────────────────────────────
      case 'start': {
        const room = rooms.get(ws.roomId);
        if (!room || ws.playerIndex !== 0 || room.players.length < 2) return;
        room.started = true;
        room.curMatrix = [0, 0];
        room.scores = [
          { completedMatrices: 0, surrenders: 0 },
          { completedMatrices: 0, surrenders: 0 },
        ];
        room.debuffWindowUntil = [0, 0];
        room.activeDebuff = [null, null];
        // Сиды для первой матрицы — РАЗНЫЕ для каждого игрока
        room.curSeed = [genSeed(room, 0, 0), genSeed(room, 1, 0)];

        room.players.forEach((p, idx) => {
          send(p, {
            type: 'mp_game_start',
            diff: room.diff,
            mySeed: room.curSeed[idx],
            opponentHandle: room.players[1 - idx].handle,
            playerIndex: idx,
          });
        });
        console.log(`[▶] Room ${ws.roomId}: PvP started`);
        break;
      }

      // ────────────────────────────────────────────────────
      // Игрок нажал первую ячейку — его таймер пошёл
      // Сообщаем сопернику чтобы он увидел индикатор "соперник начал"
      case 'first_pick': {
        const room = rooms.get(ws.roomId);
        if (!room) return;
        broadcast(room, {
          type: 'opp_first_pick',
          playerIndex: ws.playerIndex,
        }, ws);
        break;
      }

      // ────────────────────────────────────────────────────
      // Прогресс — закрашенные клетки, заполненный буфер, кол-во закрытых seq
      // Транслируем сопернику для real-time превью
      case 'progress': {
        const room = rooms.get(ws.roomId);
        if (!room) return;
        broadcast(room, {
          type: 'opp_progress',
          playerIndex: ws.playerIndex,
          progress: msg.progress, // { picked:[idx...], bufLen, seqsDone, seqsTotal, timeLeft }
        }, ws);
        break;
      }

      // ────────────────────────────────────────────────────
      // Игрок закрыл текущую матрицу (все нужные seq найдены)
      case 'matrix_complete': {
        const room = rooms.get(ws.roomId);
        if (!room) return;
        const idx = ws.playerIndex;
        room.scores[idx].completedMatrices++;
        room.curMatrix[idx]++;
        const completed = room.scores[idx].completedMatrices;

        // Открываем окно дебаффа на 12 секунд
        room.debuffWindowUntil[idx] = Date.now() + 12000;

        broadcastAll(room, {
          type: 'matrix_done',
          playerIndex: idx,
          completedMatrices: completed,
        });

        if (completed >= 5) {
          // ПОБЕДА
          broadcastAll(room, {
            type: 'mp_match_end',
            winner: idx,
            scores: room.scores,
            reason: 'finished_5',
          });
          console.log(`[🏆] Room ${ws.roomId}: Player ${idx} (${ws.handle}) WON!`);
          room.started = false;
          break;
        }

        // Если это не победа — выдаём этому игроку новый сид для следующей матрицы
        room.curSeed[idx] = genSeed(room, idx, room.curMatrix[idx]);
        send(ws, {
          type: 'next_matrix',
          mySeed: room.curSeed[idx],
          matrixNum: room.curMatrix[idx],
          // Окно дебаффа — клиент покажет кнопку "наложить дебафф" на 12 секунд
          debuffWindowMs: 12000,
        });
        break;
      }

      // ────────────────────────────────────────────────────
      // Сдача — меняет ТОЛЬКО твою матрицу
      case 'surrender': {
        const room = rooms.get(ws.roomId);
        if (!room) return;
        const idx = ws.playerIndex;
        room.scores[idx].surrenders++;
        const surrenders = room.scores[idx].surrenders;

        if (surrenders > 2) {
          // 3-я сдача = поражение
          const winner = idx === 0 ? 1 : 0;
          broadcastAll(room, {
            type: 'mp_match_end',
            winner,
            scores: room.scores,
            reason: 'surrender_limit',
          });
          console.log(`[✕] Room ${ws.roomId}: Player ${idx} surrendered too many times`);
          room.started = false;
          break;
        }

        // Новая матрица для этого игрока (тот же номер матрицы, новый seed)
        room.curSeed[idx] = genSeed(room, idx, room.curMatrix[idx]);

        // Сдавшемуся — новая матрица
        send(ws, {
          type: 'matrix_reshuffle',
          mySeed: room.curSeed[idx],
          surrendersUsed: surrenders,
          surrendersRemaining: 2 - surrenders,
        });
        // Сопернику — уведомление, что тот сдался
        broadcast(room, {
          type: 'opp_surrendered',
          playerIndex: idx,
          surrendersUsed: surrenders,
        }, ws);
        break;
      }

      // ────────────────────────────────────────────────────
      // Игрок накладывает дебафф на соперника
      // (доступно только в окне 12 секунд после закрытия своей матрицы)
      case 'apply_debuff': {
        const room = rooms.get(ws.roomId);
        if (!room) return;
        const idx = ws.playerIndex;
        const now = Date.now();
        if (now > room.debuffWindowUntil[idx]) {
          send(ws, { type: 'error', msg: 'Окно дебаффа истекло' });
          return;
        }
        // Закрываем окно
        room.debuffWindowUntil[idx] = 0;
        const oppIdx = 1 - idx;
        room.activeDebuff[oppIdx] = msg.debuff;

        // Соперник получает дебафф
        send(room.players[oppIdx], {
          type: 'debuff_received',
          debuff: msg.debuff,
          fromHandle: ws.handle,
        });
        // Игроку подтверждение
        send(ws, {
          type: 'debuff_sent',
          debuff: msg.debuff,
        });
        console.log(`[⚡] Room ${ws.roomId}: ${ws.handle} -> ${msg.debuff} -> opponent`);
        break;
      }

      // ────────────────────────────────────────────────────
      case 'ping': {
        send(ws, { type: 'pong' });
        break;
      }
    }
  });

  ws.on('close', () => {
    const room = rooms.get(ws.roomId);
    if (!room) return;
    if (room.started && room.players.length === 2) {
      const winner = ws.playerIndex === 0 ? 1 : 0;
      broadcast(room, {
        type: 'opponent_disconnected',
        winner,
      }, ws);
      room.started = false;
    }
    room.players = room.players.filter(p => p !== ws);
    if (room.players.length === 0) {
      rooms.delete(ws.roomId);
      console.log(`[-] Room ${ws.roomId} deleted (empty)`);
    }
  });
});

server.listen(PORT, () => console.log(`[★] BREACH signal server on port ${PORT}`));

// Очистка старых пустых/мертвых комнат каждые 10 минут
setInterval(() => {
  for (const [id, room] of rooms.entries()) {
    if (room.players.every(p => p.readyState !== WebSocket.OPEN)) {
      rooms.delete(id);
      console.log(`[~] Cleaned stale room ${id}`);
    }
  }
}, 600000);
