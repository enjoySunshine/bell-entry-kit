import '@colyseus/sdk/debug';
import { Client, Callbacks, Room } from '@colyseus/sdk';

import type { server } from './server/vite.ts';
import type { MyRoom, MyRoomState } from './MyRoom.ts';
import { BELL_POSITION, MAP_HEIGHT, MAP_WIDTH, finiteNumber } from './bell.ts';

type BellRoom = Room<MyRoom>;

type DrawPlayer = {
  x: number;
  y: number;
  score?: number;
  connected?: boolean;
  label?: string;
  color?: string;
};

const logElement = document.querySelector<HTMLPreElement>('#log');
const button = document.querySelector<HTMLButtonElement>('#connect');
const statusEl = document.querySelector<HTMLSpanElement>('#status');
const canvas = document.querySelector<HTMLCanvasElement>('#game');
const ctx = canvas?.getContext('2d');
const countElement = document.querySelector<HTMLElement>('#bell-count');
const countValueElement = document.querySelector<HTMLElement>('#count');
const playerStateElement = document.querySelector<HTMLElement>('#player-state');

const params = new URLSearchParams(window.location.search);
const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ''));
function queryValue(key: string): string | null {
  return params.get(key) ?? hashParams.get(key);
}
const roomName = queryValue('room')
  ?? queryValue('roomName')
  ?? queryValue('roomType')
  ?? 'my_room_2';

let room: BellRoom | null = null;
const players = new Map<string, DrawPlayer>();

// HTTP endpoint buttons — work without a room connection
const httpClient = new Client<typeof server>(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);

document.getElementById('btn-hello')?.addEventListener('click', async () => {
  const res = await httpClient.http.get('/hello');
  log(`/hello: ${JSON.stringify(res.data)}`);
});

document.getElementById('btn-time')?.addEventListener('click', async () => {
  const res = await httpClient.http.get('/time');
  log(`/time: ${JSON.stringify(res.data)}`);
});

document.getElementById('btn-express')?.addEventListener('click', async () => {
  const res = await fetch(`${location.origin}/express-hello`);
  log(`/express-hello: ${JSON.stringify(await res.json())}`);
});

function log(message: string) {
  if (logElement) {
    logElement.textContent = message;
  }
}

function setStatus(state: 'idle' | 'connecting' | 'connected' | 'disconnected', text: string) {
  if (!statusEl) return;
  statusEl.className = state;
  statusEl.innerHTML = `<span class="dot"></span>${text}`;
}

function queryJoinOptions(): Record<string, unknown> {
  const options: Record<string, unknown> = {};

  for (const key of ['name', 'id', 'player', 'preset', 'character', 'label', 'side', 'role', 'team', 'progress'] as const) {
    const value = queryValue(key);
    if (value !== null) options[key] = value;
  }

  for (const key of ['x', 'y', 'score', 'playerIndex', 'index', 'seat', 'slot'] as const) {
    const value = finiteNumber(queryValue(key));
    if (value !== undefined) options[key] = value;
  }

  return options;
}

function roomCount(state: MyRoomState | null | undefined): number {
  if (!state) return 0;
  return finiteNumber((state as any).count)
    ?? finiteNumber((state as any).bellCount)
    ?? finiteNumber((state as any).counter)
    ?? finiteNumber((state as any).bell?.count)
    ?? 0;
}

function playerColor(sessionId: string, player: DrawPlayer): string {
  if (room && sessionId === room.sessionId) return '#2563eb';
  if (player.score === 5) return '#60a5fa'; // 甲
  if (player.score === 2) return '#f97316'; // 乙
  return '#6b7280';
}

function playerLabel(sessionId: string, player: DrawPlayer): string {
  const named = queryValue('name') ?? queryValue('id') ?? queryValue('player');
  if (room && sessionId === room.sessionId && named) return named;
  if (player.score === 5) return '甲';
  if (player.score === 2) return '乙';
  return sessionId.slice(0, 4);
}

function updateHud(count: number) {
  if (countElement) {
    countElement.dataset.count = String(count);
    countElement.dataset.bellCount = String(count);
  }
  if (countValueElement) {
    countValueElement.textContent = String(count);
    countValueElement.dataset.count = String(count);
    countValueElement.dataset.bellCount = String(count);
  }

  if (canvas) {
    canvas.dataset.count = String(count);
    canvas.dataset.bellCount = String(count);
  }

  if (playerStateElement) {
    const rows = [...players.entries()].map(([sessionId, player]) => {
      const label = playerLabel(sessionId, player);
      const score = player.score === undefined ? '' : ` · 分数 ${player.score}`;
      const state = player.connected === false ? ' · 断线保留中' : '';
      return `<div class="player-row${player.connected === false ? ' offline' : ''}" data-session-id="${sessionId}" data-x="${player.x}" data-y="${player.y}" data-score="${player.score ?? ''}">
        <span>${label}${score}${state}</span><span>(${player.x}, ${player.y})</span>
      </div>`;
    }).join('');
    playerStateElement.innerHTML = rows;
    playerStateElement.dataset.count = String(players.size);
  }
}

function drawBell() {
  if (!ctx) return;
  const { x, y } = BELL_POSITION;

  ctx.save();

  // Soft target area.
  ctx.beginPath();
  ctx.arc(x, y, 25, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(250, 204, 21, 0.14)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(250, 204, 21, 0.55)';
  ctx.lineWidth = 2;
  ctx.stroke();

  // Bell body.
  ctx.beginPath();
  ctx.moveTo(x - 13, y + 8);
  ctx.quadraticCurveTo(x - 11, y - 4, x - 8, y - 9);
  ctx.quadraticCurveTo(x - 6, y - 16, x, y - 16);
  ctx.quadraticCurveTo(x + 6, y - 16, x + 8, y - 9);
  ctx.quadraticCurveTo(x + 11, y - 4, x + 13, y + 8);
  ctx.closePath();
  ctx.fillStyle = '#facc15';
  ctx.fill();
  ctx.strokeStyle = '#fef08a';
  ctx.lineWidth = 2;
  ctx.stroke();

  // Clapper.
  ctx.beginPath();
  ctx.arc(x, y + 12, 3.5, 0, Math.PI * 2);
  ctx.fillStyle = '#ca8a04';
  ctx.fill();

  ctx.fillStyle = '#fef9c3';
  ctx.font = '700 13px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('铃', x, y - 2);

  ctx.restore();
}

function drawCount(count: number) {
  if (!ctx) return;

  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '800 30px system-ui, sans-serif';

  const text = String(count);
  const width = ctx.measureText(text).width + 34;
  const x = BELL_POSITION.x;
  const y = BELL_POSITION.y - 48;

  ctx.fillStyle = 'rgba(3, 7, 18, 0.82)';
  ctx.strokeStyle = 'rgba(250, 204, 21, 0.75)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(x - width / 2, y - 19, width, 38, 12);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = '#fde047';
  ctx.fillText(text, x, y + 1);
  ctx.restore();
}

function drawPlayers() {
  if (!ctx) return;

  const stackedAtBell = [...players.entries()]
    .filter(([, player]) => player.x === BELL_POSITION.x && player.y === BELL_POSITION.y);
  const stackIndexBySession = new Map(stackedAtBell.map(([sessionId], index) => [sessionId, index]));

  players.forEach((player, sessionId) => {
    const color = playerColor(sessionId, player);
    const label = playerLabel(sessionId, player);
    const stackIndex = stackIndexBySession.get(sessionId);
    const labelY = stackIndex === undefined ? player.y + 25 : player.y + 43 + stackIndex * 13;

    ctx.save();
    ctx.globalAlpha = player.connected === false ? 0.45 : 0.82;

    // Main point. Centers always use the authoritative room coordinates.
    ctx.beginPath();
    ctx.arc(player.x, player.y, 12, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();

    ctx.globalAlpha = 1;
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();

    ctx.fillStyle = '#e2e8f0';
    ctx.font = '10px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, player.x, labelY);
    ctx.restore();
  });

  // Concentric stack rings make overlapping points visually countable while
  // preserving the exact shared center (360, 240).
  stackedAtBell.forEach(([sessionId, player], index) => {
    ctx?.save();
    ctx.beginPath();
    ctx.arc(player.x, player.y, 17 + index * 5, 0, Math.PI * 2);
    ctx.strokeStyle = playerColor(sessionId, player);
    ctx.lineWidth = 2.5;
    ctx.setLineDash([7, 4]);
    ctx.stroke();
    ctx.restore();
  });
}

function draw() {
  if (!ctx || !canvas) return;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Map boundary reference.
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.18)';
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, MAP_WIDTH - 2, MAP_HEIGHT - 2);

  drawBell();
  drawPlayers();

  const count = roomCount(room?.state);
  drawCount(count);
  updateHud(count);

  requestAnimationFrame(draw);
}

async function connectRoom(): Promise<BellRoom> {
  if (room) return room;

  if (button) {
    button.textContent = 'Connecting...';
    button.disabled = true;
  }
  setStatus('connecting', 'Connecting...');

  try {
    const client = new Client<typeof server>(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);
    const joined = await client.joinOrCreate(roomName as any, queryJoinOptions());
    room = joined as unknown as BellRoom;

    // allow reconnection immediately.
    room.reconnection.minUptime = 0;

    setStatus('connected', `Room ${room.roomId} | Session ${room.sessionId}`);
    if (button) {
      button.textContent = 'Leave';
      button.disabled = false;
    }

    // Sync players from state using Callbacks API
    const callbacks = Callbacks.get(room);

    callbacks.onAdd("players", (player, sessionId) => {
      const drawPlayer: DrawPlayer = {
        x: player.x,
        y: player.y,
        score: finiteNumber(player.score),
        connected: true,
      };
      players.set(sessionId, drawPlayer);

      callbacks.listen(player, "x", (value) => {
        const p = players.get(sessionId);
        if (p) p.x = value;
      });
      callbacks.listen(player, "y", (value) => {
        const p = players.get(sessionId);
        if (p) p.y = value;
      });
      callbacks.listen(player, "score", (value) => {
        const p = players.get(sessionId);
        if (p) p.score = finiteNumber(value);
      });

      log(`Player joined: ${sessionId}`);
      updateHud(roomCount(room?.state));
    });

    callbacks.onRemove("players", (_, sessionId) => {
      players.delete(sessionId);
      log(`Player left: ${sessionId}`);
      updateHud(roomCount(room?.state));
    });

    room.onStateChange((state) => {
      updateHud(roomCount(state as MyRoomState));
    });

    room.onDrop((code) => {
      const me = players.get(room!.sessionId);
      if (me) me.connected = false;
      setStatus('disconnected', `Reconnecting... (drop code: ${code})`);
    });

    room.onReconnect(() => {
      const me = players.get(room!.sessionId);
      if (me) me.connected = true;
      setStatus('connected', `Room ${room!.roomId} | Session ${room!.sessionId}`);
    });

    room.onLeave((code) => {
      setStatus('disconnected', `Disconnected (code: ${code})`);
      log(`Left room (code: ${code})`);
      if (button) {
        button.textContent = 'Join my_room';
        button.disabled = false;
      }
      room = null;
      players.clear();
      updateHud(0);
    });

    room.onError((code, message) => {
      log(`Error ${code}: ${message}`);
    });

    // Arrow key movement
    const speed = 5;
    const keys = new Set<string>();

    const onKeyDown = (e: KeyboardEvent) => {
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'w', 'a', 's', 'd'].includes(e.key)) {
        e.preventDefault();
        keys.add(e.key);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => keys.delete(e.key);

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);

    const moveLoop = setInterval(() => {
      if (keys.size === 0 || !room) return;
      let x = 0, y = 0;
      if (keys.has('ArrowLeft') || keys.has('a')) x -= speed;
      if (keys.has('ArrowRight') || keys.has('d')) x += speed;
      if (keys.has('ArrowUp') || keys.has('w')) y -= speed;
      if (keys.has('ArrowDown') || keys.has('s')) y += speed;
      if (x !== 0 || y !== 0) {
        const me = players.get(room.sessionId);
        const next = { x: (me?.x ?? 0) + x, y: (me?.y ?? 0) + y };
        me && (me.x = next.x, me.y = next.y);
        room.send('move', next);
      }
    }, 1000 / 30);

    room.onLeave(() => {
      clearInterval(moveLoop);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    });

    updateHud(roomCount(room.state));
    return room;

  } catch (e) {
    setStatus('disconnected', 'Connection failed');
    log(`Connection failed: ${e instanceof Error ? e.message : String(e)}`);
    if (button) {
      button.textContent = 'Join my_room';
      button.disabled = false;
    }
    room = null;
    throw e;
  }
}

button?.addEventListener('click', async () => {
  if (room) {
    room.leave();
    return;
  }

  try {
    await connectRoom();
  } catch {
    // connectRoom already reports the failure.
  }
});

canvas?.addEventListener('pointerdown', (event) => {
  if (!room || !canvas) return;
  const rect = canvas.getBoundingClientRect();
  const x = Math.round(((event.clientX - rect.left) / rect.width) * canvas.width);
  const y = Math.round(((event.clientY - rect.top) / rect.height) * canvas.height);
  const me = players.get(room.sessionId);
  if (me) {
    me.x = x;
    me.y = y;
  }
  room.send('move', { x, y });
});

async function disconnect(): Promise<void> {
  if (room) await room.leave();
}

async function moveTo(x: number, y: number): Promise<void> {
  if (!room) throw new Error('Not connected');
  const me = players.get(room.sessionId);
  if (me) {
    me.x = x;
    me.y = y;
  }
  room.send('move', { x, y });
}

async function moveBy(dx: number, dy: number): Promise<void> {
  if (!room) throw new Error('Not connected');
  const me = players.get(room.sessionId);
  await moveTo((me?.x ?? 0) + dx, (me?.y ?? 0) + dy);
}

function getSnapshot() {
  const state = room?.state as MyRoomState | undefined;
  return {
    roomName,
    roomId: room?.roomId ?? null,
    sessionId: room?.sessionId ?? null,
    count: roomCount(state),
    bellCount: finiteNumber((state as any)?.bellCount) ?? roomCount(state),
    bell: { ...BELL_POSITION, count: roomCount(state) },
    mapWidth: MAP_WIDTH,
    mapHeight: MAP_HEIGHT,
    players: [...players.entries()].map(([sessionId, player]) => ({ sessionId, ...player })),
    state: state ? JSON.parse(JSON.stringify(state)) : null,
  };
}

const gameApi = {
  kind: 'bell-entry-kit',
  canvas,
  countElement,
  countValueElement,
  bell: BELL_POSITION,
  mapWidth: MAP_WIDTH,
  mapHeight: MAP_HEIGHT,
  get room() { return room; },
  get state() { return room?.state ?? null; },
  get players() { return players; },
  getCount: () => roomCount(room?.state),
  getSnapshot,
  connect: connectRoom,
  disconnect,
  moveTo,
  moveBy,
};

for (const globalName of ['__bellGame', 'bellGame', '__game', 'game', 'bellEntryGame'] as const) {
  (window as any)[globalName] = gameApi;
}
for (const globalName of ['room', '__room', 'colyseusRoom'] as const) {
  Object.defineProperty(window, globalName, {
    configurable: true,
    get: () => room,
  });
}

// Start rendering the static bell/HUD immediately.
requestAnimationFrame(draw);

// ?autojoin=1 lets browser harnesses open configured A/B pages without a click.
if (['1', 'true', 'yes'].includes(queryValue('autojoin') ?? queryValue('autoJoin') ?? '')) {
  connectRoom().catch(() => { /* error is rendered in #log */ });
}
