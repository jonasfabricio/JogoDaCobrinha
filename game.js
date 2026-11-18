// Script clássico (não-módulo) para funcionar abrindo o index.html direto do disco (file://).
// O Three.js vem da CDN via import() dinâmico, resolvido pelo importmap do index.html.
Promise.all([
  import("three"),
  import("three/addons/postprocessing/EffectComposer.js"),
  import("three/addons/postprocessing/RenderPass.js"),
  import("three/addons/postprocessing/UnrealBloomPass.js"),
  import("three/addons/postprocessing/OutputPass.js"),
]).then(([THREE, { EffectComposer }, { RenderPass }, { UnrealBloomPass }, { OutputPass }]) => {

/* ---------- Utilidades ---------- */
const $ = (s) => document.querySelector(s);
const rand = (n) => Math.floor(Math.random() * n);
const shuffle = (a) => {
  for (let i = a.length - 1; i > 0; i--) {
    const j = rand(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
const DIRS = [[-1, 0], [1, 0], [0, -1], [0, 1]]; // cima, baixo, esquerda, direita (oposto = i ^ 1)
const KEYS = { arrowup: 0, w: 0, arrowdown: 1, s: 1, arrowleft: 2, a: 2, arrowright: 3, d: 3 };
const WALL = 1, FLOOR = 0, EXIT = 2;

/* ---------- Geração do labirinto ----------
   1) Backtracker iterativo: corredores longos e sinuosos (difícil).
   2) "Braid": remove TODOS os becos sem saída abrindo uma parede extra.
      Resultado: todo corredor faz parte de um ciclo, então um monstro sozinho
      nunca consegue encurralar o jogador. */
function generateMaze(n) {
  const g = Array.from({ length: n }, () => Array(n).fill(WALL));
  const inside = (r, c) => r > 0 && c > 0 && r < n - 1 && c < n - 1;
  const stack = [[1, 1]];
  g[1][1] = FLOOR;

  while (stack.length) {
    const [r, c] = stack[stack.length - 1];
    const next = shuffle([...DIRS]).find(([dr, dc]) => inside(r + dr * 2, c + dc * 2) && g[r + dr * 2][c + dc * 2] === WALL);
    if (!next) { stack.pop(); continue; }
    const [dr, dc] = next;
    g[r + dr][c + dc] = g[r + dr * 2][c + dc * 2] = FLOOR;
    stack.push([r + dr * 2, c + dc * 2]);
  }

  for (let r = 1; r < n - 1; r += 2) {
    for (let c = 1; c < n - 1; c += 2) {
      if (DIRS.filter(([dr, dc]) => g[r + dr][c + dc] === FLOOR).length > 1) continue;
      const [dr, dc] = shuffle(DIRS.filter(([dr, dc]) => inside(r + dr * 2, c + dc * 2) && g[r + dr][c + dc] === WALL))[0];
      g[r + dr][c + dc] = FLOOR;
    }
  }

  g[n - 2][n - 2] = EXIT;
  return g;
}

/* ---------- Estado ---------- */
const state = {
  level: 1, lives: 3, score: 0, best: 0, runStartBest: 0,
  N: 0, maze: null, running: false,
  player: { r: 1, c: 1 },
  monsters: [], gems: [], powers: [], gemsTotal: 0, gemsGot: 0,
  frozenUntil: 0, invulnUntil: 0, startTime: 0,
};
let held = null, nextMoveAt = 0, tickAcc = 0, camH = 30, shake = 0;

// Recorde fica no servidor, ligado à conta do jogador.
function saveProgress() {
  if (state.score > state.best) state.best = state.score;
  Account.saveScore(state.score, state.level);
}

/* ---------- Three.js ---------- */
const renderer = new THREE.WebGLRenderer({ canvas: $("#scene"), antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x050b1f);
scene.fog = new THREE.Fog(0x050b1f, 16, 42);

const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 200);
scene.add(new THREE.HemisphereLight(0xa5c8ff, 0x0a1430, 1.1));
const sun = new THREE.DirectionalLight(0xdbeafe, 1.8);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.bias = -0.0005;
scene.add(sun, sun.target);
const playerLight = new THREE.PointLight(0x38bdf8, 4, 7, 1.6);
scene.add(playerLight);

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
composer.addPass(new UnrealBloomPass(new THREE.Vector2(256, 256), 0.6, 0.45, 0.8));
composer.addPass(new OutputPass());

function resize() {
  renderer.setSize(innerWidth, innerHeight, false);
  composer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.fov = camera.aspect < 0.8 ? 65 : 50;
  camera.updateProjectionMatrix();
}
addEventListener("resize", resize);
resize();

const std = (color, emissive = 0x000000, emissiveIntensity = 1, extra = {}) =>
  new THREE.MeshStandardMaterial({ color, emissive, emissiveIntensity, roughness: 0.4, metalness: 0.1, ...extra });

const mat = {
  floor: std(0x0a1633, 0, 1, { roughness: 0.95 }),
  wall: std(0x1d4ed8, 0x0b2a6b, 0.5, { roughness: 0.3, metalness: 0.25 }),
  cap: std(0x3b82f6, 0x1d4ed8, 0.9),
  player: std(0xe0f2fe, 0x38bdf8, 1.8),
  halo: std(0x7dd3fc, 0x38bdf8, 2.2),
  wanderer: std(0xa78bfa, 0x6d28d9, 0.9),
  hunter: std(0xff4d7d, 0xe11d48, 1.2),
  frozen: std(0xe0f2fe, 0x93c5fd, 0.8, { roughness: 0.1 }),
  eye: new THREE.MeshBasicMaterial({ color: 0xffffff }),
  pupil: new THREE.MeshBasicMaterial({ color: 0x0b1020 }),
  gem: std(0x5eead4, 0x14b8a6, 1.4, { metalness: 0.6, roughness: 0.15 }),
  power: std(0xffffff, 0xbfdbfe, 1.6),
  exit: std(0xfde68a, 0xf59e0b, 2.2),
  beam: new THREE.MeshBasicMaterial({ color: 0xfbbf24, transparent: true, opacity: 0.18, depthWrite: false, side: THREE.DoubleSide }),
};

const geo = {
  box: new THREE.BoxGeometry(1, 1, 1),
  player: new THREE.SphereGeometry(0.28, 32, 16),
  halo: new THREE.TorusGeometry(0.4, 0.025, 8, 48),
  blob: new THREE.SphereGeometry(0.33, 32, 16),
  eye: new THREE.SphereGeometry(0.08, 12, 8),
  pupil: new THREE.SphereGeometry(0.04, 8, 6),
  horn: new THREE.ConeGeometry(0.06, 0.2, 10),
  gem: new THREE.OctahedronGeometry(0.15),
  power: new THREE.IcosahedronGeometry(0.2),
  ring: new THREE.TorusGeometry(0.34, 0.05, 12, 48),
  beam: new THREE.CylinderGeometry(0.3, 0.3, 6, 24, 1, true),
};

let world = new THREE.Group();
scene.add(world);

// Jogador (persistente entre níveis)
const playerMesh = new THREE.Group();
const playerBall = new THREE.Mesh(geo.player, mat.player);
playerBall.castShadow = true;
const halo = new THREE.Mesh(geo.halo, mat.halo);
halo.rotation.x = Math.PI / 2;
playerMesh.add(playerBall, halo);
scene.add(playerMesh);

const place = (obj, r, c, y = 0) => obj.position.set(c, y, r);

function makeMonster(hunter) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(geo.blob, hunter ? mat.hunter : mat.wanderer);
  body.castShadow = true;
  g.add(body);
  for (const x of [-0.12, 0.12]) {
    const eye = new THREE.Mesh(geo.eye, mat.eye);
    eye.position.set(x, 0.08, 0.27);
    const pupil = new THREE.Mesh(geo.pupil, mat.pupil);
    pupil.position.z = 0.055;
    eye.add(pupil);
    g.add(eye);
    if (hunter) {
      const horn = new THREE.Mesh(geo.horn, mat.hunter);
      horn.position.set(x * 1.3, 0.33, 0);
      horn.rotation.z = -x * 3;
      g.add(horn);
    }
  }
  return { group: g, body };
}

/* ---------- Construção do nível ---------- */
function distances(sr, sc) {
  const { N, maze } = state;
  const d = Array.from({ length: N }, () => Array(N).fill(Infinity));
  d[sr][sc] = 0;
  const q = [[sr, sc]];
  for (let i = 0; i < q.length; i++) {
    const [r, c] = q[i];
    for (const [dr, dc] of DIRS) {
      const nr = r + dr, nc = c + dc;
      if (maze[nr][nc] !== WALL && d[nr][nc] === Infinity) {
        d[nr][nc] = d[r][c] + 1;
        q.push([nr, nc]);
      }
    }
  }
  return d;
}

function freeCells(minDist = 0, from = state.player) {
  const d = distances(from.r, from.c);
  const out = [];
  state.maze.forEach((row, r) => row.forEach((t, c) => {
    if (t === FLOOR && d[r][c] >= minDist && !(r === 1 && c === 1)) out.push({ r, c });
  }));
  return shuffle(out);
}

function startLevel() {
  const { level } = state;
  const maxN = Math.min(13 + level * 4, 41);
  const N = (state.N = 11 + 2 * rand((maxN - 11) / 2 + 1)); // tamanho aleatório, teto cresce com o nível
  state.maze = generateMaze(N);
  state.player = { r: 1, c: 1 };

  // limpa o mundo anterior
  scene.remove(world);
  world.traverse((o) => { if (o.userData.own) o.geometry.dispose(); if (o.isInstancedMesh) o.dispose(); });
  world = new THREE.Group();
  scene.add(world);

  // paredes (instanced = 2 draw calls para o labirinto inteiro)
  const walls = [];
  state.maze.forEach((row, r) => row.forEach((t, c) => t === WALL && walls.push([r, c])));
  const body = new THREE.InstancedMesh(geo.box, mat.wall, walls.length);
  const cap = new THREE.InstancedMesh(geo.box, mat.cap, walls.length);
  body.castShadow = body.receiveShadow = true;
  const m = new THREE.Matrix4();
  walls.forEach(([r, c], i) => {
    body.setMatrixAt(i, m.makeScale(1, 0.8, 1).setPosition(c, 0.4, r));
    cap.setMatrixAt(i, m.makeScale(1, 0.04, 1).setPosition(c, 0.82, r));
  });

  const floor = new THREE.Mesh(new THREE.PlaneGeometry(N + 6, N + 6), mat.floor);
  floor.userData.own = true;
  floor.rotation.x = -Math.PI / 2;
  floor.position.set((N - 1) / 2, 0, (N - 1) / 2);
  floor.receiveShadow = true;

  const grid = new THREE.GridHelper(N, N, 0x1e40af, 0x1e40af);
  grid.userData.own = true;
  grid.position.set((N - 1) / 2, 0.003, (N - 1) / 2);
  grid.material.transparent = true;
  grid.material.opacity = 0.35;

  // portal de saída
  const exit = new THREE.Group();
  const ring = new THREE.Mesh(geo.ring, mat.exit);
  ring.position.y = 0.45;
  const beam = new THREE.Mesh(geo.beam, mat.beam);
  beam.position.y = 3;
  const exitLight = new THREE.PointLight(0xfbbf24, 5, 5, 1.6);
  exitLight.position.y = 0.8;
  exit.add(ring, beam, exitLight);
  exit.userData.ring = ring;
  place(exit, N - 2, N - 2);
  world.add(body, cap, floor, grid, exit);
  world.userData.exit = exit;

  // sombra cobre o labirinto todo
  const s = N * 0.75;
  sun.position.set(N / 2 + 8, 22, N / 2 + 6);
  sun.target.position.set(N / 2, 0, N / 2);
  Object.assign(sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 1, far: 80 });
  sun.shadow.camera.updateProjectionMatrix();

  // monstros: quantidade cresce com nível e tamanho; caçadores a partir do nível 2
  const spots = freeCells(Math.max(8, N * 0.6));
  const count = Math.min(1 + Math.floor(level * 0.8) + Math.floor(N / 14), 10, spots.length);
  state.monsters = spots.slice(0, count).map((p, i) => {
    const hunter = level >= 2 && i % 2 === 1;
    const mon = { ...p, dir: 1, hunter, ...makeMonster(hunter) };
    place(mon.group, p.r, p.c, 0.36);
    world.add(mon.group);
    return mon;
  });

  // cristais e power-ups de congelamento
  const items = freeCells(2);
  const nGems = 3 + Math.floor(N / 5);
  state.gems = items.slice(0, nGems).map((p) => addItem(p, geo.gem, mat.gem));
  state.powers = items.slice(nGems, nGems + 1 + Math.floor(N / 20)).map((p) => addItem(p, geo.power, mat.power));
  state.gemsTotal = nGems;
  state.gemsGot = 0;

  place(playerMesh, 1, 1, 0.32);
  camH = N * 1.4; // câmera começa no alto e mergulha
  state.frozenUntil = state.invulnUntil = 0;
  state.startTime = performance.now();
  tickAcc = 0;
  state.running = true;
  $("#overlay").hidden = true;
  toast(`Nível ${level} · ${N}×${N}`);
  hud();
}

function addItem(p, g, m) {
  const mesh = new THREE.Mesh(g, m);
  mesh.castShadow = true;
  place(mesh, p.r, p.c, 0.4);
  world.add(mesh);
  return { ...p, mesh };
}

/* ---------- Regras ---------- */
const tickMs = () => Math.max(160, 380 - state.level * 18);
const frozen = (now) => now < state.frozenUntil;

function move(i, now = performance.now()) {
  const p = state.player;
  const r = p.r + DIRS[i][0], c = p.c + DIRS[i][1];
  if (state.maze[r][c] === WALL) return;
  p.r = r; p.c = c;
  playerMesh.rotation.y = Math.atan2(DIRS[i][1], DIRS[i][0]);

  const take = (list) => {
    const k = list.findIndex((it) => it.r === r && it.c === c);
    if (k < 0) return false;
    world.remove(list[k].mesh);
    list.splice(k, 1);
    return true;
  };
  if (take(state.gems)) { state.gemsGot++; state.score += 50; }
  if (take(state.powers)) { state.frozenUntil = now + 5000; toast("❄ Monstros congelados! Esmague-os!"); }

  const mon = state.monsters.find((m) => m.r === r && m.c === c);
  if (mon) collide(mon, now);
  if (state.running && state.maze[r][c] === EXIT) win(now);
  hud();
}

function tickMonsters(now) {
  if (frozen(now)) return;
  const { maze, player } = state;
  const d = distances(player.r, player.c);
  const at = (m, i) => [m.r + DIRS[i][0], m.c + DIRS[i][1]];

  for (const m of state.monsters) {
    const opts = [0, 1, 2, 3].filter((i) => { const [r, c] = at(m, i); return maze[r][c] === FLOOR; });
    if (!opts.length) continue;
    let pick;
    if (m.hunter && d[m.r][m.c] <= 10 && Math.random() < 0.8) {
      // caçador: segue o caminho mais curto até o jogador
      pick = opts.reduce((a, b) => (d[at(m, b)[0]][at(m, b)[1]] < d[at(m, a)[0]][at(m, a)[1]] ? b : a));
    } else {
      // andarilho: segue em frente, só volta se não houver opção
      const fwd = opts.filter((i) => i !== (m.dir ^ 1));
      const pool = fwd.length ? fwd : opts;
      pick = pool[rand(pool.length)];
    }
    m.dir = pick;
    [m.r, m.c] = at(m, pick);
    if (m.r === player.r && m.c === player.c) collide(m, now);
    if (!state.running) return;
  }
}

function collide(mon, now) {
  if (frozen(now)) {
    state.score += 200;
    toast("💥 +200");
    const spot = freeCells(Math.max(8, state.N * 0.5))[0];
    if (spot) { Object.assign(mon, spot); place(mon.group, spot.r, spot.c, 3); }
    return;
  }
  if (now < state.invulnUntil) return;

  state.lives--;
  shake = 0.6;
  const flash = $("#flash");
  flash.classList.add("on");
  requestAnimationFrame(() => requestAnimationFrame(() => flash.classList.remove("on")));

  if (state.lives <= 0) return gameOver();
  state.player = { r: 1, c: 1 };
  state.invulnUntil = now + 2000;
  toast("Ai! −1 vida");
}

function win(now) {
  state.running = false;
  held = null;
  const secs = Math.floor((now - state.startTime) / 1000);
  const timeBonus = Math.max(0, 300 - secs * 5);
  const levelBonus = 300 + state.level * 100;
  const allGems = state.gemsGot === state.gemsTotal ? 500 : 0;
  state.score += timeBonus + levelBonus + allGems;
  if (state.score > state.best) toast("🏆 Novo recorde!");
  saveProgress();
  hud();
  setTimeout(() => overlay(
    `Nível ${state.level} concluído`,
    "Saída encontrada!",
    row("Tempo", fmt(secs)) + row("Bônus de nível", `+${levelBonus}`) + row("Bônus de tempo", `+${timeBonus}`) +
      row(`Cristais ${state.gemsGot}/${state.gemsTotal}`, allGems ? "+500 coleção completa!" : "—") + row("Pontos", state.score),
    "Próximo nível →",
    () => { state.level++; startLevel(); },
  ), 450);
}

function gameOver() {
  state.running = false;
  held = null;
  const record = state.score > state.runStartBest;
  saveProgress();
  hud();
  setTimeout(() => overlay(
    record ? "🏆 Novo recorde!" : "Fim de jogo",
    "Você foi pego!",
    row("Nível alcançado", state.level) + row("Pontos", state.score) + row("Recorde", state.best),
    "Jogar de novo",
    newGame,
  ), 500);
}

function newGame() {
  if (state.score > 0) saveProgress(); // recomeçar no meio não perde o recorde
  Object.assign(state, { level: 1, lives: 3, score: 0, runStartBest: state.best });
  startLevel();
}

/* ---------- UI ---------- */
const fmt = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
const row = (k, v) => `<div class="row"><span>${k}</span><b>${v}</b></div>`;

function hud() {
  $("#level").textContent = state.level;
  $("#gems").textContent = `${state.gemsGot}/${state.gemsTotal}`;
  $("#score").textContent = state.score;
  $("#lives").textContent = "♥".repeat(Math.max(0, state.lives)) + "♡".repeat(3 - Math.max(0, state.lives));
}

let toastTimer = 0;
function toast(text) {
  const el = $("#toast");
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 1800);
}

let overlayAction = null;
function overlay(eyebrow, title, html, btn, action) {
  $("#ov-eyebrow").textContent = eyebrow;
  $("#ov-title").textContent = title;
  $("#ov-text").innerHTML = html;
  $("#ov-btn").textContent = btn;
  overlayAction = action;
  $("#overlay").hidden = false;
  $("#ov-btn").focus();
}
$("#ov-btn").addEventListener("click", () => overlayAction?.());
$("#restart").addEventListener("click", (e) => { e.currentTarget.blur(); newGame(); });

/* ---------- Controles ---------- */
function press(i) {
  if (!state.running) return;
  held = i;
  move(i);
  nextMoveAt = performance.now() + 170;
}
const release = (i) => { if (held === i) held = null; };

addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLInputElement) return; // não roubar teclas enquanto digita email/senha
  const i = KEYS[e.key.toLowerCase()];
  if (i === undefined) return;
  e.preventDefault();
  if (!e.repeat) press(i);
});
addEventListener("keyup", (e) => release(KEYS[e.key.toLowerCase()]));
addEventListener("blur", () => (held = null));

document.querySelectorAll(".pad button").forEach((b) => {
  const i = Number(b.dataset.dir);
  b.addEventListener("pointerdown", (e) => { e.preventDefault(); press(i); });
  for (const ev of ["pointerup", "pointerleave", "pointercancel"]) b.addEventListener(ev, () => release(i));
});

// swipe na tela
let touchStart = null;
$("#scene").addEventListener("pointerdown", (e) => (touchStart = { x: e.clientX, y: e.clientY }));
$("#scene").addEventListener("pointerup", (e) => {
  if (!touchStart) return;
  const dx = e.clientX - touchStart.x, dy = e.clientY - touchStart.y;
  touchStart = null;
  if (Math.max(Math.abs(dx), Math.abs(dy)) < 24) return;
  press(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 3 : 2) : (dy > 0 ? 1 : 0));
  held = null;
});

/* ---------- Loop ---------- */
const clock = new THREE.Clock();
const camTarget = new THREE.Vector3();

renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.elapsedTime;
  const now = performance.now();
  const k = (speed) => 1 - Math.exp(-dt * speed);

  if (state.running) {
    if (held !== null && now >= nextMoveAt) { move(held, now); nextMoveAt = now + 115; }
    tickAcc += dt * 1000;
    if (tickAcc >= tickMs()) { tickAcc = 0; tickMonsters(now); }
    $("#time").textContent = fmt(Math.floor((now - state.startTime) / 1000));
  }

  // jogador
  const p = state.player;
  playerMesh.position.x += (p.c - playerMesh.position.x) * k(20);
  playerMesh.position.z += (p.r - playerMesh.position.z) * k(20);
  playerMesh.position.y = 0.32 + Math.sin(t * 5) * 0.04;
  halo.rotation.z = t * 2;
  playerMesh.visible = now > state.invulnUntil || Math.floor(now / 90) % 2 === 0;
  playerLight.position.copy(playerMesh.position).y += 0.6;

  // monstros
  const isFrozen = frozen(now);
  const blink = isFrozen && state.frozenUntil - now < 1200 && Math.floor(now / 120) % 2;
  state.monsters.forEach((m, i) => {
    const g = m.group;
    g.position.x += (m.c - g.position.x) * k(14);
    g.position.z += (m.r - g.position.z) * k(14);
    g.position.y += (0.36 + (isFrozen ? 0 : Math.abs(Math.sin(t * 8 + i)) * 0.12) - g.position.y) * k(12);
    const turn = Math.atan2(DIRS[m.dir][1], DIRS[m.dir][0]) - g.rotation.y;
    g.rotation.y += Math.atan2(Math.sin(turn), Math.cos(turn)) * k(12);
    m.body.material = isFrozen && !blink ? mat.frozen : m.hunter ? mat.hunter : mat.wanderer;
  });

  // itens e saída
  for (const it of [...state.gems, ...state.powers]) {
    it.mesh.rotation.y = t * 2;
    it.mesh.position.y = 0.4 + Math.sin(t * 3 + it.r + it.c) * 0.06;
  }
  const exit = world.userData.exit;
  if (exit) { exit.userData.ring.rotation.y = t * 1.5; exit.userData.ring.rotation.x = Math.sin(t) * 0.3; }

  // câmera segue o jogador, com mergulho inicial e tremor ao levar dano
  camH += (9 - camH) * k(1.6);
  shake *= Math.exp(-dt * 6);
  camTarget.lerp(playerMesh.position, k(8));
  camera.position.set(
    camTarget.x + (Math.random() - 0.5) * shake,
    camTarget.y + camH,
    camTarget.z + camH * 0.55 + (Math.random() - 0.5) * shake,
  );
  camera.lookAt(camTarget);

  composer.render();
});

/* ---------- Início ---------- */
startLevel(); // labirinto de fundo atrás do menu
state.running = false;
Account.ready.then((user) => (state.best = user.best)).then(() => overlay(
  "Labirinto 3D",
  "Escape do labirinto",
  `Use <b>setas</b> / <b>WASD</b> (ou deslize no celular) para chegar ao <b>portal dourado</b>.<br>
   Colete <b>cristais</b> 💎, pegue o <b>floco</b> ❄ para congelar e esmagar os monstros.<br>
   <span style="color:#a78bfa">Roxos</span> vagam · <span style="color:#ff4d7d">Vermelhos</span> caçam você.<br>
   Recorde: <b>${state.best}</b>`,
  "Jogar",
  newGame,
));
}).catch((err) => {
  document.body.insertAdjacentHTML("beforeend",
    `<p style="position:fixed;inset:auto 16px 16px;padding:12px;border-radius:12px;background:#7f1d1d;color:#fff">
      Não foi possível carregar o Three.js (precisa de internet). ${err}</p>`);
});
