/**
 * SnekWarz — WebSocket Game Server
 * 
 * Install:  npm install ws
 * Run:      node server.js
 * Deploy:   push to GitHub → connect to Railway → set PORT env var
 */

const { WebSocketServer, WebSocket } = require('ws');
const PORT = process.env.PORT || 3001;

// ─────────────────────────────────────────
// CONSTANTS (must match client)
// ─────────────────────────────────────────
const WORLD        = 3000;
const TICK_RATE    = 60;          // ticks per second — matches client 60fps
const TICK_MS      = 1000 / TICK_RATE;
const MAX_PLAYERS  = 20;
const SPEED_BASE   = 2.8;        // 2.8 * 60tps = 168px/sec
const SPEED_BOOST  = 5.5;
const COIN_TARGET  = 280;
const SOL_DURATION = 20;          // seconds

const COIN_DEFS = [
  { id:'DOGE',  pts:1,  rarity:0.22, tier:0 },
  { id:'SHIB',  pts:1,  rarity:0.20, tier:0 },
  { id:'PEPE',  pts:1,  rarity:0.18, tier:0 },
  { id:'BONK',  pts:1,  rarity:0.15, tier:0 },
  { id:'WIF',   pts:2,  rarity:0.10, tier:0 },
  { id:'BRETT', pts:2,  rarity:0.07, tier:0 },
  { id:'LINK',  pts:5,  rarity:0.03, tier:1 },
  { id:'AVAX',  pts:5,  rarity:0.02, tier:1 },
  { id:'MATIC', pts:5,  rarity:0.015,tier:1 },
  { id:'BTC',   pts:25, rarity:0.008,tier:2 },
  { id:'ETH',   pts:25, rarity:0.006,tier:2 },
];
const COIN_WEIGHT = COIN_DEFS.reduce((s,c) => s + c.rarity, 0);

// ─────────────────────────────────────────
// GAME STATE
// ─────────────────────────────────────────
let snakes   = {};   // id → snake
let coins    = {};   // id → coin
let solToken = null; // { id, x, y, timer }
let tick     = 0;
let coinSeq  = 0;
let snakeSeq = 0;

// ─────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────
function rand(min, max) { return min + Math.random() * (max - min); }
function dist(ax, ay, bx, by) { return Math.sqrt((bx-ax)**2 + (by-ay)**2); }
function wrapWorld(v) { return ((v % WORLD) + WORLD) % WORLD; }

function pickCoinDef() {
  let r = Math.random() * COIN_WEIGHT, acc = 0;
  for (const c of COIN_DEFS) { acc += c.rarity; if (r <= acc) return c; }
  return COIN_DEFS[0];
}

function makeSnake(id, name, color, isBot = false) {
  const x = rand(200, WORLD - 200);
  const y = rand(200, WORLD - 200);
  const angle = Math.random() * Math.PI * 2;
  const segs = [];
  for (let i = 0; i < 8; i++) {
    segs.push({
      x: wrapWorld(x - Math.cos(angle) * i * 12),
      y: wrapWorld(y - Math.sin(angle) * i * 12),
    });
  }
  return { id, name, color, isBot, alive: true, angle, targetAngle: angle,
           score: 0, length: 8, segments: segs, boost: false, solCount: 0,
           botTarget: null, botTimer: 0, botPersonality: isBot ? randPersonality() : null };
}

const PERSONALITIES = ['degen','paperhands','whale','hodler'];
function randPersonality() { return PERSONALITIES[Math.floor(Math.random() * PERSONALITIES.length)]; }

const BOT_NAMES   = ['DEGEN_BOT','PAPERHANDS','WHALE_MANE','RUGPULLER','MOON_BRO',
                      'SHILL_KING','NGMI_GUY','DIAMOND_HND','CRABBY_BOI','HODL_LORD'];
const BOT_COLORS  = ['#ff6b6b','#ffd93d','#6bcb77','#4d96ff','#ff6bff',
                     '#ff9f43','#48dbfb','#ff9ff3','#54a0ff','#5f27cd'];

function spawnCoin() {
  const def = pickCoinDef();
  const id = `c${coinSeq++}`;
  coins[id] = { id, x: rand(0, WORLD), y: rand(0, WORLD),
                vx: (Math.random()-0.5)*0.4, vy: (Math.random()-0.5)*0.4,
                def, age: 0 };
}

function spawnSOL() {
  if (solToken) return;
  const id = `sol${coinSeq++}`;
  solToken = { id, x: rand(200, WORLD-200), y: rand(200, WORLD-200),
               vx: (Math.random()-0.5)*0.6, vy: (Math.random()-0.5)*0.6,
               timer: SOL_DURATION * TICK_RATE };
  broadcast({ type:'sol_spawn', x: solToken.x, y: solToken.y });
}

// ─────────────────────────────────────────
// GAME TICK
// ─────────────────────────────────────────
function gameTick() {
  tick++;

  // ── Move all snakes ──
  for (const s of Object.values(snakes)) {
    if (!s.alive) continue;

    // Smooth angle (bots use targetAngle, real players set angle directly)
    let da = s.targetAngle - s.angle;
    while (da >  Math.PI) da -= Math.PI * 2;
    while (da < -Math.PI) da += Math.PI * 2;
    const turnSpeed = s.isBot ? 0.07 : 0.12;
    s.angle += Math.max(-turnSpeed, Math.min(turnSpeed, da));

    const speed = s.boost ? SPEED_BOOST : SPEED_BASE;
    const nx = wrapWorld(s.segments[0].x + Math.cos(s.angle) * speed);
    const ny = wrapWorld(s.segments[0].y + Math.sin(s.angle) * speed);
    s.segments.unshift({ x: nx, y: ny });
    if (s.segments.length > Math.min(s.length * 4, 300)) s.segments.pop();

    // Boost shrink
    if (s.boost && s.length > 6 && tick % 4 === 0) s.length = Math.max(6, s.length - 0.5);

    // Bot AI
    if (s.isBot) updateBotAI(s);
  }

  // ── Move coins ──
  for (const c of Object.values(coins)) {
    c.x = wrapWorld(c.x + c.vx);
    c.y = wrapWorld(c.y + c.vy);
    c.age++;
  }
  if (solToken) {
    solToken.x = wrapWorld(solToken.x + solToken.vx);
    solToken.y = wrapWorld(solToken.y + solToken.vy);
    solToken.vx += (Math.random()-0.5)*0.1; solToken.vy += (Math.random()-0.5)*0.1;
    solToken.vx *= 0.98; solToken.vy *= 0.98;
    solToken.timer--;
    if (solToken.timer <= 0) {
      broadcast({ type:'sol_despawn' });
      solToken = null;
    } else if (solToken.timer % TICK_RATE === 0) {
      // Broadcast countdown every second
      broadcast({ type:'sol_tick', t: Math.floor(solToken.timer / TICK_RATE) });
    }
  }

  // ── Coin collection ──
  const snakeList = Object.values(snakes).filter(s => s.alive);
  for (const s of snakeList) {
    const head = s.segments[0];
    const collectR = 16 + s.length * 0.15;

    // Regular coins
    for (const [cid, c] of Object.entries(coins)) {
      if (dist(head.x, head.y, c.x, c.y) < collectR) {
        s.score  += c.def.pts;
        s.length += c.def.tier === 2 ? 8 : c.def.tier === 1 ? 4 : 1;
        delete coins[cid];
        broadcast({ type:'coin_collect', cid, sid: s.id, pts: c.def.pts, coinId: c.def.id });
        spawnCoin();
      }
    }
    // SOL
    if (solToken && dist(head.x, head.y, solToken.x, solToken.y) < collectR + 8) {
      s.score    += 100;
      s.length   += 20;
      s.solCount  = (s.solCount || 0) + 1;
      broadcast({ type:'sol_collect', sid: s.id });
      solToken = null;
    }
  }

  // ── Collision detection (head vs body) ──
  for (const s of snakeList) {
    const head = s.segments[0];
    for (const other of snakeList) {
      if (other === s) continue;
      for (let i = 2; i < other.segments.length; i += 2) {
        const seg = other.segments[i];
        const hitR = getSize(s) * 0.5 + getSize(other) * 0.3;
        if (dist(head.x, head.y, seg.x, seg.y) < hitR) {
          killSnake(s, other);
          break;
        }
      }
    }
  }

  // ── Keep coin count up ──
  while (Object.keys(coins).length < COIN_TARGET) spawnCoin();

  // ── SOL spawn schedule ──
  if (!solToken && tick === 600) spawnSOL();
  else if (!solToken && tick > 600 && tick % 2400 === 0) spawnSOL();

  // ── Broadcast state delta ──
  if (tick % 1 === 0) broadcastState();
}

function getSize(s) { return Math.min(16 + s.length * 0.3, 48); }

function killSnake(s, killer) {
  if (!s.alive) return;
  s.alive = false;
  broadcast({ type:'snake_die', sid: s.id, killerId: killer?.id });

  // Drop coins
  const drop = Math.min(Math.floor(s.length / 2), 60);
  for (let i = 0; i < drop; i++) {
    const seg = s.segments[Math.floor(Math.random() * s.segments.length)];
    const def = pickCoinDef();
    const id = `c${coinSeq++}`;
    coins[id] = { id, x: seg.x + (Math.random()-0.5)*30, y: seg.y + (Math.random()-0.5)*30,
                  vx:(Math.random()-0.5)*3, vy:(Math.random()-0.5)*3, def, age:0 };
  }

  if (s.isBot) {
    // Respawn bot after 4 seconds
    setTimeout(() => respawnBot(s.id), 4000);
  } else {
    // Notify the real player
    const ws = clients.get(s.id);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type:'you_died', score: s.score, solCount: s.solCount }));
    }
  }
}

function respawnBot(id) {
  const old = snakes[id];
  if (!old || !old.isBot) return;
  snakes[id] = makeSnake(id, old.name, old.color, true);
  broadcast({ type:'snake_spawn', snake: serializeSnake(snakes[id]) });
}

// ─────────────────────────────────────────
// BOT AI
// ─────────────────────────────────────────
function updateBotAI(s) {
  s.botTimer--;
  if (s.botTimer > 0) return;
  s.botTimer = Math.floor(Math.random() * 25 + 10);

  const p = s.botPersonality;
  const head = s.segments[0];
  let best = null, bestScore = -Infinity;

  // Target selection based on personality
  const chaseRare = p === 'degen' || p === 'whale';
  const fearDeath = p === 'paperhands';

  for (const c of Object.values(coins)) {
    const d = dist(head.x, head.y, c.x, c.y) || 1;
    const val = chaseRare ? c.def.pts * 200 / d : (c.def.tier === 0 ? 1000 / d : 0);
    if (val > bestScore) { bestScore = val; best = { x: c.x, y: c.y }; }
  }

  // Chase SOL if degen or whale
  if (solToken && chaseRare) {
    const d = dist(head.x, head.y, solToken.x, solToken.y) || 1;
    const val = 20000 / d;
    if (val > bestScore) { bestScore = val; best = { x: solToken.x, y: solToken.y }; }
  }

  // Paperhands avoids large snakes
  if (fearDeath) {
    for (const other of Object.values(snakes)) {
      if (!other.alive || other === s) continue;
      const d = dist(head.x, head.y, other.segments[0].x, other.segments[0].y);
      if (d < 200 && other.length > s.length) {
        best = { x: head.x + (head.x - other.segments[0].x), y: head.y + (head.y - other.segments[0].y) };
      }
    }
  }

  if (best) {
    s.targetAngle = Math.atan2(best.y - head.y, best.x - head.x);
  } else {
    s.targetAngle += (Math.random() - 0.5) * 0.8;
  }
}

// ─────────────────────────────────────────
// SERIALIZATION
// ─────────────────────────────────────────
function serializeSnake(s) {
  const segs = [];
  const step = Math.max(2, Math.floor(s.segments.length / 60));
  for (let i = 0; i < s.segments.length && segs.length < 120; i += step) {
    segs.push(Math.round(s.segments[i].x), Math.round(s.segments[i].y));
  }
  return { id:s.id, name:s.name, color:s.color, score:s.score,
           length:Math.round(s.length), alive:s.alive, segs };
}

function serializeCoin(c) {
  return { id:c.id, x:Math.round(c.x), y:Math.round(c.y), coinId:c.def.id, tier:c.def.tier };
}

function broadcastState() {
  const snakeArr = Object.values(snakes).map(serializeSnake);
  const sol      = solToken ? { x:Math.round(solToken.x), y:Math.round(solToken.y), t:Math.floor(solToken.timer/TICK_RATE) } : null;
  // Send coins only every 10 ticks — they barely move
  const coinArr  = tick % 10 === 0 ? Object.values(coins).map(serializeCoin) : undefined;
  const msg = JSON.stringify({ type:'state', tick, snakes:snakeArr, coins:coinArr, sol });
  for (const [,ws] of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const [,ws] of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

// ─────────────────────────────────────────
// WEB SOCKET SERVER
// ─────────────────────────────────────────
const wss = new WebSocketServer({ port: PORT, maxPayload: 1024 }); // 1 KB max message
const clients = new Map(); // snakeId → ws

const RATE_LIMIT_MS  = 25;   // minimum ms between messages (~40/sec max)
const HEX_COLOR_RE   = /^#[0-9a-fA-F]{6}$/;
const SAFE_NAME_RE   = /^[A-Z0-9_. ]{1,12}$/;

// Spawn initial bots
function initBots() {
  for (let i = 0; i < 10; i++) {
    const id = `bot_${i}`;
    snakes[id] = makeSnake(id, BOT_NAMES[i], BOT_COLORS[i], true);
  }
  // Seed coins
  while (Object.keys(coins).length < COIN_TARGET) spawnCoin();
}

// Start game loop
initBots();
setInterval(gameTick, TICK_MS);
console.log(`🐍 SnekWarz server running on ws://localhost:${PORT}`);

wss.on('connection', (ws) => {
  if (Object.keys(snakes).length - countBots() >= MAX_PLAYERS) {
    ws.send(JSON.stringify({ type:'error', msg:'Server full' }));
    ws.close();
    return;
  }

  const sid = `player_${snakeSeq++}`;
  let lastMsg = 0;
  let joined  = false;

  ws.on('message', (data) => {
    // Rate limit
    const now = Date.now();
    if (now - lastMsg < RATE_LIMIT_MS) return;
    lastMsg = now;

    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (!msg || typeof msg.type !== 'string') return;

    switch (msg.type) {
      case 'join': {
        if (joined) return; // prevent duplicate joins
        joined = true;

        const rawName = (typeof msg.name === 'string' ? msg.name : 'ANON').toUpperCase().slice(0, 12).trim() || 'ANON';
        const name    = SAFE_NAME_RE.test(rawName) ? rawName : 'ANON';
        const color   = HEX_COLOR_RE.test(msg.color) ? msg.color : '#00ff87';
        snakes[sid] = makeSnake(sid, name, color, false);
        clients.set(sid, ws);

        // Send full world state to new player
        ws.send(JSON.stringify({
          type:   'welcome',
          sid,
          snakes: Object.values(snakes).map(serializeSnake),
          coins:  Object.values(coins).map(serializeCoin),
          sol:    solToken ? { x:solToken.x, y:solToken.y, t:Math.floor(solToken.timer/TICK_RATE) } : null,
        }));

        // Tell everyone else about the new player
        broadcast({ type:'snake_spawn', snake: serializeSnake(snakes[sid]) });
        console.log(`+ ${name} joined (${sid})`);
        break;
      }

      case 'input': {
        const s = snakes[sid];
        if (!s || !s.alive) return;
        if (typeof msg.angle === 'number' && isFinite(msg.angle)) s.targetAngle = msg.angle;
        if (typeof msg.boost === 'boolean') s.boost = msg.boost;
        break;
      }

      case 'respawn': {
        if (snakes[sid] && !snakes[sid].alive) {
          snakes[sid] = makeSnake(sid, snakes[sid].name, snakes[sid].color, false);
          snakes[sid].id = sid;
          broadcast({ type:'snake_spawn', snake: serializeSnake(snakes[sid]) });
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    if (snakes[sid]) {
      broadcast({ type:'snake_leave', sid });
      delete snakes[sid];
    }
    clients.delete(sid);
    console.log(`- ${sid} disconnected`);
  });

  ws.on('error', () => {
    clients.delete(sid);
    delete snakes[sid];
  });
});

function countBots() {
  return Object.values(snakes).filter(s => s.isBot).length;
}
