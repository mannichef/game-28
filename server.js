const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3028;
const server = http.createServer((req, res) => {
  let fp = path.join(__dirname, 'public', req.url === '/' ? 'index.html' : req.url);
  const ext = path.extname(fp);
  const ct = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[ext] || 'text/plain';
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': ct }); res.end(data);
  });
});

const wss = new WebSocketServer({ server });
const ARENA = { w: 800, h: 600 };
const OBSTACLES = [
  { x: 200, y: 150, w: 60, h: 60 }, { x: 540, y: 150, w: 60, h: 60 },
  { x: 200, y: 390, w: 60, h: 60 }, { x: 540, y: 390, w: 60, h: 60 },
  { x: 370, y: 270, w: 60, h: 60 }
];
const COLORS = ['#0ff', '#f0f', '#0f0', '#ff0', '#f80', '#08f'];
let players = new Map();
let gameState = 'lobby'; // lobby, playing, roundEnd
let bombHolder = null;
let bombTimer = 0;
let bombMax = 0;
let roundNum = 0;

function broadcast(msg) {
  const s = JSON.stringify(msg);
  for (const [, p] of players) if (p.ws.readyState === 1) p.ws.send(s);
}

function alivePlayers() { return [...players.values()].filter(p => p.alive); }

function startRound() {
  gameState = 'playing'; roundNum++;
  const alive = alivePlayers();
  if (alive.length < 2) { endGame(); return; }
  alive.forEach((p, i) => {
    const angle = (i / alive.length) * Math.PI * 2;
    p.x = ARENA.w / 2 + Math.cos(angle) * 200;
    p.y = ARENA.h / 2 + Math.sin(angle) * 200;
  });
  const ri = Math.floor(Math.random() * alive.length);
  bombHolder = alive[ri].id;
  bombMax = 10000 + Math.random() * 10000;
  bombTimer = 0;
  broadcast({ type: 'roundStart', round: roundNum, bombHolder, players: getPlayerStates() });
}

function endGame() {
  gameState = 'roundEnd';
  const alive = alivePlayers();
  const winner = alive.length === 1 ? alive[0].name : 'Nobody';
  if (alive.length === 1) alive[0].wins = (alive[0].wins || 0) + 1;
  broadcast({ type: 'gameOver', winner, scores: [...players.values()].map(p => ({ name: p.name, wins: p.wins || 0 })) });
  setTimeout(() => {
    for (const [, p] of players) { p.alive = true; p.ready = false; }
    gameState = 'lobby';
    broadcast({ type: 'lobby', players: [...players.values()].map(p => ({ id: p.id, name: p.name, ready: p.ready })) });
  }, 5000);
}

function getPlayerStates() {
  return [...players.values()].filter(p => p.alive).map(p => ({
    id: p.id, name: p.name, x: p.x, y: p.y, color: p.color, hasBomb: p.id === bombHolder
  }));
}

function collides(p, ox, oy) {
  return OBSTACLES.some(o => ox + 15 > o.x && ox - 15 < o.x + o.w && oy + 15 > o.y && oy - 15 < o.y + o.h);
}

let idCounter = 0;
wss.on('connection', ws => {
  const id = ++idCounter;
  const color = COLORS[(id - 1) % COLORS.length];
  const player = { id, ws, name: 'Player ' + id, x: 400, y: 300, color, ready: false, alive: true, wins: 0, vx: 0, vy: 0 };
  players.set(id, player);
  ws.send(JSON.stringify({ type: 'welcome', id, color, obstacles: OBSTACLES, arena: ARENA }));
  broadcast({ type: 'lobby', players: [...players.values()].map(p => ({ id: p.id, name: p.name, ready: p.ready })) });

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'setName') { player.name = (msg.name || '').slice(0, 12) || 'Anon'; broadcast({ type: 'lobby', players: [...players.values()].map(p => ({ id: p.id, name: p.name, ready: p.ready })) }); }
    if (msg.type === 'ready' && gameState === 'lobby') {
      player.ready = true;
      broadcast({ type: 'lobby', players: [...players.values()].map(p => ({ id: p.id, name: p.name, ready: p.ready })) });
      const all = [...players.values()];
      if (all.length >= 2 && all.every(p => p.ready)) { all.forEach(p => p.alive = true); startRound(); }
    }
    if (msg.type === 'move' && gameState === 'playing' && player.alive) {
      player.vx = Math.max(-4, Math.min(4, msg.vx || 0));
      player.vy = Math.max(-4, Math.min(4, msg.vy || 0));
    }
  });

  ws.on('close', () => {
    players.delete(id);
    if (bombHolder === id) { const alive = alivePlayers(); if (alive.length) bombHolder = alive[Math.floor(Math.random() * alive.length)].id; }
    if (players.size < 2 && gameState === 'playing') endGame();
    broadcast({ type: 'lobby', players: [...players.values()].map(p => ({ id: p.id, name: p.name, ready: p.ready })) });
  });
});

// Game tick 30fps
setInterval(() => {
  if (gameState !== 'playing') return;
  bombTimer += 33;
  const speed = bombHolder ? 4.5 : 4;

  for (const [, p] of players) {
    if (!p.alive) continue;
    const s = p.id === bombHolder ? 4.5 : 4;
    let nx = p.x + p.vx * s / 4;
    let ny = p.y + p.vy * s / 4;
    nx = Math.max(15, Math.min(ARENA.w - 15, nx));
    ny = Math.max(15, Math.min(ARENA.h - 15, ny));
    if (!collides(p, nx, ny)) { p.x = nx; p.y = ny; }
  }

  // Tag detection
  if (bombHolder) {
    const bh = players.get(bombHolder);
    if (bh) {
      for (const [, p] of players) {
        if (p.id === bombHolder || !p.alive) continue;
        const dx = bh.x - p.x, dy = bh.y - p.y;
        if (Math.sqrt(dx * dx + dy * dy) < 30) {
          bombHolder = p.id;
          broadcast({ type: 'tagged', from: bh.id, to: p.id });
          break;
        }
      }
    }
  }

  // Bomb explosion
  if (bombTimer >= bombMax) {
    const bh = players.get(bombHolder);
    if (bh) {
      bh.alive = false;
      broadcast({ type: 'explode', player: bombHolder, x: bh.x, y: bh.y });
      const alive = alivePlayers();
      if (alive.length <= 1) { setTimeout(endGame, 1500); }
      else { setTimeout(startRound, 2000); }
      return;
    }
  }

  broadcast({ type: 'state', players: getPlayerStates(), bombTimer: bombTimer / bombMax });
}, 33);

server.listen(PORT, () => console.log(`Bomb Tag server on :${PORT}`));
