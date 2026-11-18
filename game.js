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
  combo: 1, comboUntil: 0, comboMax: 1,
};
// Combo: coletas seguidas (no máximo COMBO_MS entre uma e outra) multiplicam os pontos, até ×COMBO_MAX.
const COMBO_MS = 3000, COMBO_MAX = 5;
let queued = null, queuedAt = 0, tickAcc = 0, camH = 30, shake = 0;
const STEP_MS = 130;  // tempo para atravessar uma casa (um pouco mais lento = mais fácil acertar as curvas)
const QUEUE_MS = 300; // por quanto tempo uma tecla apertada "antes da curva" continua valendo
const camTarget = new THREE.Vector3();

// Recorde fica no servidor, ligado à conta do jogador.
function saveProgress() {
  if (state.score > state.best) state.best = state.score;
  Account.saveScore(state.score, state.level);
}

/* ---------- Three.js ---------- */
// O antialias do canvas não vale com EffectComposer (ele desenha em render target próprio), então fica desligado.
const renderer = new THREE.WebGLRenderer({ canvas: $("#scene"), antialias: false, powerPreference: "high-performance" });
let pixelRatio = Math.min(devicePixelRatio, 1.5);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x050b1f);
scene.fog = new THREE.Fog(0x050b1f, 16, 42);

const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 200);
const hemi = new THREE.HemisphereLight(0xa5c8ff, 0x0a1430, 1.1);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xdbeafe, 1.8);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
// A sombra cobre só uma área em volta do jogador e acompanha ele (ver loop).
const SHADOW_HALF = 12;
const SHADOW_TEXEL = (SHADOW_HALF * 2) / 1024;
Object.assign(sun.shadow.camera, { left: -SHADOW_HALF, right: SHADOW_HALF, top: SHADOW_HALF, bottom: -SHADOW_HALF, near: 1, far: 60 });
sun.shadow.camera.updateProjectionMatrix();
sun.shadow.bias = -0.0005;
scene.add(sun, sun.target);
const playerLight = new THREE.PointLight(0x38bdf8, 4, 7, 1.6);
scene.add(playerLight);

// Iluminação normal x nível escuro. No escuro só a "lanterna" do jogador ilumina; cristais, monstros
// e portal continuam visíveis porque têm brilho próprio (emissivo). No escuro a neblina acompanha a
// distância da câmera (ver loop). Como a câmera olha de cima, um ponto do chão a h casas do jogador
// fica só ~h²/(2·dist) mais longe que ele; por isso a faixa da neblina é bem estreita.
const DARK_FOG = [0, 1.6]; // começa a escurecer junto do jogador e some por completo a ~5-6 casas
const LIGHTING = {
  normal: { hemi: 1.1, sun: 1.8, fog: [16, 42], bg: 0x050b1f, lamp: [4, 7], glow: [0.5, 0.9] },
  dark: { hemi: 0.05, sun: 0.04, fog: null, bg: 0x010309, lamp: [9, 4.5], glow: [0, 0.02] },
};
function applyLighting(dark) {
  const L = dark ? LIGHTING.dark : LIGHTING.normal;
  hemi.intensity = L.hemi;
  sun.intensity = L.sun;
  [mat.wall.emissiveIntensity, mat.cap.emissiveIntensity] = L.glow; // paredes param de brilhar sozinhas
  if (L.fog) [scene.fog.near, scene.fog.far] = L.fog;
  scene.fog.color.setHex(L.bg);
  scene.background.setHex(L.bg);
  [playerLight.intensity, playerLight.distance] = L.lamp;
}

// Sem MSAA no composer: com ele apareciam linhas nas emendas entre os blocos (e custa mais).
const composer = new EffectComposer(renderer);
const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.6, 0.45, 0.8);
composer.addPass(new RenderPass(scene, camera));
composer.addPass(bloom);
composer.addPass(new OutputPass());
let useBloom = true;

function resize() {
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(innerWidth, innerHeight, false);
  composer.setPixelRatio(pixelRatio);
  composer.setSize(innerWidth, innerHeight);
  bloom.setSize((innerWidth * pixelRatio) / 2, (innerHeight * pixelRatio) / 2); // brilho em meia resolução
  camera.aspect = innerWidth / innerHeight;
  camera.fov = camera.aspect < 0.8 ? 65 : 50;
  camera.updateProjectionMatrix();
}
addEventListener("resize", resize);
resize();

// Qualidade adaptativa: se a média passar de ~20 ms por quadro, desce um degrau (nunca sobe de volta).
const perf = { level: 0, frames: 0, time: 0 };
function measureFrame(rawDt) {
  if (!state.running || rawDt > 0.25) return; // ignora menus e a volta de uma aba escondida
  perf.frames++;
  perf.time += rawDt;
  if (perf.time < 2) return;
  const slow = perf.time / perf.frames > 0.02;
  perf.frames = perf.time = 0;
  if (!slow || perf.level >= 3) return;
  perf.level++;
  if (perf.level === 1) { pixelRatio = 1; resize(); }
  if (perf.level === 2) useBloom = false;
  if (perf.level === 3) sun.castShadow = false;
  console.info("Qualidade reduzida para manter a fluidez, degrau", perf.level);
}

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
  exitLocked: std(0x64748b, 0xdc2626, 0.9, { roughness: 0.6 }), // portal trancado: apagado, borda vermelha
  key: std(0xfde68a, 0xf59e0b, 1.8, { metalness: 0.8, roughness: 0.2 }),
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
  keyBow: new THREE.TorusGeometry(0.1, 0.035, 10, 24),
  keyShaft: new THREE.BoxGeometry(0.05, 0.26, 0.05),
  keyTooth: new THREE.BoxGeometry(0.08, 0.05, 0.05),
};

// Chave: argola + haste + dente, deitada levemente para dar para ver de cima.
function makeKey() {
  const g = new THREE.Group();
  const bow = new THREE.Mesh(geo.keyBow, mat.key);
  bow.position.y = 0.15;
  const shaft = new THREE.Mesh(geo.keyShaft, mat.key);
  shaft.position.y = -0.04;
  const tooth = new THREE.Mesh(geo.keyTooth, mat.key);
  tooth.position.set(0.05, -0.13, 0);
  g.add(bow, shaft, tooth);
  g.rotation.x = -0.5;
  g.scale.setScalar(1.7); // grande o bastante para achar de longe
  return g;
}

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
  state.dark = level >= 3 && level % 3 === 0; // níveis 3, 6, 9… são no escuro
  applyLighting(state.dark);

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
  Object.assign(exit.userData, { ring, beam, light: exitLight });
  place(exit, N - 2, N - 2);
  world.add(body, cap, floor, grid, exit);
  world.userData.exit = exit;

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

  // chave: a partir do nível 2 o portal começa trancado e é preciso achá-la
  state.keyNeeded = level >= 2;
  state.hasKey = !state.keyNeeded;
  state.key = null;
  if (state.keyNeeded) {
    const spot = pickKeySpot();
    const mesh = makeKey();
    place(mesh, spot.r, spot.c, 0.45);
    world.add(mesh);
    state.key = { ...spot, mesh };
  }
  setExitLocked(!state.hasKey);

  place(playerMesh, 1, 1, 0.32);
  camTarget.set(1, 0.32, 1);
  queued = null;
  keysDown.length = 0;
  camH = N * 1.4; // câmera começa no alto e mergulha
  state.frozenUntil = state.invulnUntil = 0;
  resetCombo();
  state.startTime = performance.now();
  tickAcc = 0;
  state.running = true;
  $("#overlay").hidden = true;
  Sfx.music(state.dark ? "dark" : "normal");
  toast(state.dark ? `🌑 Nível ${level} no escuro · só sua lanterna ilumina` : `Nível ${level} · ${N}×${N}`);
  hud();
}

// Casa da chave: longe do início (≥ 50% da maior distância) e não colada na saída (≥ N/3),
// sem cair em cima de cristal/floco. Se o labirinto não tiver uma casa assim, relaxa as regras.
function pickKeySpot() {
  const { N, maze } = state;
  const start = { r: 1, c: 1 };
  const fromStart = distances(1, 1), fromExit = distances(N - 2, N - 2);
  let far = 0;
  maze.forEach((row, r) => row.forEach((t, c) => { if (t === FLOOR) far = Math.max(far, fromStart[r][c]); }));
  const taken = new Set([...state.gems, ...state.powers].map((it) => it.r * N + it.c));
  const free = (p) => !taken.has(p.r * N + p.c);
  const candidates = freeCells(far * 0.5, start);
  return candidates.find((p) => free(p) && fromExit[p.r][p.c] >= N / 3) ?? candidates.find(free) ?? freeCells(1, start)[0];
}

// Portal trancado: anel apagado com borda vermelha, sem feixe nem luz.
// (A luz só tem a intensidade zerada: ligar/desligar luzes obrigaria o Three.js a recompilar os shaders.)
function setExitLocked(locked) {
  const { ring, beam, light } = world.userData.exit.userData;
  ring.material = locked ? mat.exitLocked : mat.exit;
  beam.visible = !locked;
  light.intensity = locked ? 0 : 5;
}

function addItem(p, g, m) {
  const mesh = new THREE.Mesh(g, m); // itens pequenos não projetam sombra (economia)
  place(mesh, p.r, p.c, 0.4);
  world.add(mesh);
  return { ...p, mesh };
}

/* ---------- Regras ---------- */
const tickMs = () => Math.max(160, 380 - state.level * 18);
const frozen = (now) => now < state.frozenUntil;

let lockedToastUntil = 0;

function move(i, now = performance.now()) {
  const p = state.player;
  const r = p.r + DIRS[i][0], c = p.c + DIRS[i][1];
  if (state.maze[r][c] === WALL) return false;
  p.r = r; p.c = c; p.dir = i;
  playerMesh.rotation.y = Math.atan2(DIRS[i][1], DIRS[i][0]);

  const take = (list) => {
    const k = list.findIndex((it) => it.r === r && it.c === c);
    if (k < 0) return false;
    world.remove(list[k].mesh);
    list.splice(k, 1);
    return true;
  };
  if (take(state.gems)) { state.gemsGot++; addCombo(now, 50, "💎"); Sfx.gem(state.combo); }
  if (take(state.powers)) { state.frozenUntil = now + 5000; toast("❄ Monstros congelados! Esmague-os!"); Sfx.power(); }

  const mon = state.monsters.find((m) => m.r === r && m.c === c);
  if (mon) collide(mon, now);
  if (state.key && state.key.r === r && state.key.c === c) {
    world.remove(state.key.mesh);
    state.key = null;
    state.hasKey = true;
    setExitLocked(false);
    toast("🔑 Chave encontrada! O portal abriu");
    Sfx.key();
  }
  if (state.running && state.maze[r][c] === EXIT) {
    if (state.hasKey) win(now);
    else if (now > lockedToastUntil) {
      lockedToastUntil = now + 1000; // não repete o aviso a cada passo
      toast("🔒 Portal trancado: encontre a chave!");
      Sfx.locked();
    }
  }
  hud();
  return true;
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
    addCombo(now, 200, "💥");
    Sfx.smash();
    const spot = freeCells(Math.max(8, state.N * 0.5))[0];
    if (spot) { Object.assign(mon, spot); place(mon.group, spot.r, spot.c, 3); }
    return;
  }
  if (now < state.invulnUntil) return;

  state.lives--;
  shake = 0.6;
  resetCombo(); // levar dano quebra o combo
  Sfx.hurt();
  const flash = $("#flash");
  flash.classList.add("on");
  requestAnimationFrame(() => requestAnimationFrame(() => flash.classList.remove("on")));

  if (state.lives <= 0) return gameOver();
  state.player = { r: 1, c: 1 };
  state.invulnUntil = now + 2000;
  toast("Ai! −1 vida");
}

function addCombo(now, base, icon) {
  state.combo = now < state.comboUntil ? Math.min(COMBO_MAX, state.combo + 1) : 1;
  state.comboUntil = now + COMBO_MS;
  state.comboMax = Math.max(state.comboMax, state.combo);
  const points = base * state.combo;
  state.score += points;
  toast(state.combo > 1 ? `${icon} +${points}  ×${state.combo}` : `${icon} +${points}`);
  renderCombo(true);
}

function resetCombo() {
  state.combo = 1;
  state.comboUntil = 0;
  renderCombo(false);
}

function win(now) {
  state.running = false;
  Sfx.win();
  keysDown.length = 0;
  const secs = Math.floor((now - state.startTime) / 1000);
  const timeBonus = Math.max(0, 300 - secs * 5);
  const levelBonus = Math.round((300 + state.level * 100) * (state.dark ? 1.5 : 1)); // escuro vale ×1,5
  const allGems = state.gemsGot === state.gemsTotal ? 500 : 0;
  state.score += timeBonus + levelBonus + allGems;
  if (state.score > state.best) toast("🏆 Novo recorde!");
  saveProgress();
  hud();
  setTimeout(() => overlay(
    `Nível ${state.level} concluído`,
    "Saída encontrada!",
    row("Tempo", fmt(secs)) + row(state.dark ? "Bônus de nível (escuro ×1,5)" : "Bônus de nível", `+${levelBonus}`) + row("Bônus de tempo", `+${timeBonus}`) +
      row(`Cristais ${state.gemsGot}/${state.gemsTotal}`, allGems ? "+500 coleção completa!" : "—") +
      row("Maior combo", `×${state.comboMax}`) + row("Pontos", state.score),
    "Próximo nível →",
    () => { state.level++; startLevel(); },
  ), 450);
}

function gameOver() {
  state.running = false;
  Sfx.gameOver();
  keysDown.length = 0;
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
  Object.assign(state, { level: 1, lives: 3, score: 0, runStartBest: state.best, comboMax: 1 });
  startLevel();
}

/* ---------- UI ---------- */
const fmt = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
const row = (k, v) => `<div class="row"><span>${k}</span><b>${v}</b></div>`;

function hud() {
  $("#level").textContent = state.level;
  $("#gems").textContent = `${state.gemsGot}/${state.gemsTotal}`;
  const keyIcon = $("#key-icon");
  keyIcon.classList.toggle("need", !!state.keyNeeded);
  keyIcon.classList.toggle("got", !!state.hasKey);
  $("#score").textContent = state.score;
  $("#lives").textContent = "♥".repeat(Math.max(0, state.lives)) + "♡".repeat(3 - Math.max(0, state.lives));
}

// HUD do combo: texto só muda quando o valor muda; a barra de tempo é atualizada no loop.
const comboEl = $("#combo"), comboStat = $("#combo-stat"), comboBar = $("#combo-bar");
function renderCombo(bump) {
  comboEl.textContent = `×${state.combo}`;
  comboStat.classList.toggle("active", state.combo > 1);
  if (!bump || state.combo < 2) return;
  comboStat.classList.remove("bump");
  void comboStat.offsetWidth; // reinicia a animação
  comboStat.classList.add("bump");
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
  Sfx.music(null);
  $("#ov-btn").focus();
}
$("#ov-btn").addEventListener("click", () => { Sfx.unlock(); overlayAction?.(); });
$("#restart").addEventListener("click", (e) => { e.currentTarget.blur(); Sfx.unlock(); newGame(); });

/* ---------- Controles ----------
   - keysDown guarda TODAS as direções seguradas, na ordem (a mais recente no fim).
     Segurar → e apertar ↑ antes da curva: continua indo para a direita e vira assim que der.
   - queued: toque rápido feito no meio do passo vale por QUEUE_MS (curva antecipada).
   - Voltar (direção oposta) é instantâneo, mesmo no meio do passo.
   - Perdão de curva atrasada: se o jogador acabou de sair do cruzamento (< 35% do caminho)
     e você aperta a direção que estava livre lá, ele volta e vira. */
const keysDown = [];
let playerLeft = 0; // quanto falta (em casas) para o mesh chegar na casa lógica

function press(i) {
  if (!state.running) return;
  const k = keysDown.indexOf(i);
  if (k >= 0) keysDown.splice(k, 1);
  keysDown.push(i);
  queued = i;
  queuedAt = performance.now();

  const p = state.player;
  if (p.dir === undefined || playerLeft <= 0) return; // parado: o loop move no próximo quadro
  if (i === (p.dir ^ 1)) { if (move(i)) queued = null; return; }
  if (i === p.dir || playerLeft < 0.65) return;
  const fromR = p.r - DIRS[p.dir][0], fromC = p.c - DIRS[p.dir][1];
  if (state.maze[fromR + DIRS[i][0]][fromC + DIRS[i][1]] === WALL) return;
  p.r = fromR; p.c = fromC; // ainda estava saindo do cruzamento: volta para ele…
  if (move(i)) queued = null; // …e vira
}
function release(i) {
  const k = keysDown.indexOf(i);
  if (k >= 0) keysDown.splice(k, 1);
}
const releaseAll = () => (keysDown.length = 0);

addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLInputElement) return; // não roubar teclas enquanto digita email/senha
  if (e.key.toLowerCase() === "m" && !e.repeat) return Sfx.toggleMute();
  const i = KEYS[e.key.toLowerCase()];
  if (i === undefined) return;
  e.preventDefault();
  if (!e.repeat) press(i);
});
addEventListener("keyup", (e) => release(KEYS[e.key.toLowerCase()]));
addEventListener("blur", releaseAll);

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
  const dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 3 : 2) : (dy > 0 ? 1 : 0);
  press(dir);
  release(dir); // swipe é um toque: vale como curva antecipada, não como tecla segurada
});

/* ---------- Loop ---------- */
const clock = new THREE.Clock();
const followPoint = new THREE.Vector3();
const timeEl = $("#time");
let lastSecs = -1;

// Anda em velocidade constante até (x, z); longe demais (respawn) teleporta. Devolve a distância restante.
function approach(pos, x, z, maxStep) {
  const dx = x - pos.x, dz = z - pos.z, d = Math.hypot(dx, dz);
  if (d <= maxStep || d > 2.5) { pos.x = x; pos.z = z; return 0; }
  pos.x += (dx / d) * maxStep;
  pos.z += (dz / d) * maxStep;
  return d - maxStep;
}

// Ao chegar (quase) na casa: primeiro a curva pedida (enquanto a tecla está segurada ou foi
// tocada há pouco), depois as teclas seguradas, da mais recente para a mais antiga.
function nextStep(now) {
  if (queued !== null) {
    const valid = keysDown.includes(queued) || now - queuedAt < QUEUE_MS;
    if (valid && move(queued, now)) { queued = null; return; }
    if (!valid) queued = null;
  }
  for (let k = keysDown.length - 1; k >= 0; k--) if (move(keysDown[k], now)) return;
}

renderer.setAnimationLoop(() => {
  const rawDt = clock.getDelta();
  const dt = Math.min(rawDt, 0.05);
  measureFrame(rawDt);
  const t = clock.elapsedTime;
  const now = performance.now();
  const k = (speed) => 1 - Math.exp(-dt * speed);

  if (state.running) {
    tickAcc += dt * 1000;
    if (tickAcc >= tickMs()) { tickAcc = 0; tickMonsters(now); }
    const secs = Math.floor((now - state.startTime) / 1000);
    if (secs !== lastSecs) { lastSecs = secs; timeEl.textContent = fmt(secs); }
    if (state.combo > 1) {
      const left = state.comboUntil - now;
      if (left <= 0) resetCombo();
      else comboBar.style.transform = `scaleX(${left / COMBO_MS})`;
    }
  }

  // jogador: desliza em velocidade constante e emenda o próximo passo sem parar
  const p = state.player;
  playerLeft = approach(playerMesh.position, p.c, p.r, (dt * 1000) / STEP_MS);
  if (state.running && playerLeft < 0.1) {
    nextStep(now);
    playerLeft = Math.hypot(p.c - playerMesh.position.x, p.r - playerMesh.position.z);
  }
  playerMesh.position.y = 0.32 + Math.sin(t * 5) * 0.04;
  halo.rotation.z = t * 2;
  playerMesh.visible = now > state.invulnUntil || Math.floor(now / 90) % 2 === 0;
  playerLight.position.copy(playerMesh.position).y += 0.6;

  // monstros
  const isFrozen = frozen(now);
  const blink = isFrozen && state.frozenUntil - now < 1200 && Math.floor(now / 120) % 2;
  const monsterStep = (dt * 1000) / tickMs();
  state.monsters.forEach((m, i) => {
    const g = m.group;
    approach(g.position, m.c, m.r, monsterStep);
    g.position.y += (0.36 + (isFrozen ? 0 : Math.abs(Math.sin(t * 8 + i)) * 0.12) - g.position.y) * k(12);
    const turn = Math.atan2(DIRS[m.dir][1], DIRS[m.dir][0]) - g.rotation.y;
    g.rotation.y += Math.atan2(Math.sin(turn), Math.cos(turn)) * k(12);
    const look = isFrozen && !blink ? mat.frozen : m.hunter ? mat.hunter : mat.wanderer;
    if (m.body.material !== look) m.body.material = look;
  });

  // itens e saída
  for (const list of [state.gems, state.powers]) {
    for (const it of list) {
      it.mesh.rotation.y = t * 2;
      it.mesh.position.y = 0.4 + Math.sin(t * 3 + it.r + it.c) * 0.06;
    }
  }
  const exit = world.userData.exit;
  if (exit) {
    // trancado gira devagar; aberto gira rápido e balança
    const spin = state.hasKey ? 1.5 : 0.4;
    exit.userData.ring.rotation.y = t * spin;
    exit.userData.ring.rotation.x = state.hasKey ? Math.sin(t) * 0.3 : 0;
  }
  if (state.key) {
    state.key.mesh.rotation.y = t * 2.5;
    state.key.mesh.position.y = 0.45 + Math.sin(t * 3) * 0.07;
  }

  // câmera segue o jogador, com mergulho inicial e tremor ao levar dano
  camH += (9 - camH) * k(1.6);
  if (state.dark) {
    const camDist = camH * Math.hypot(1, 0.55); // distância câmera → jogador
    scene.fog.near = camDist + DARK_FOG[0];
    scene.fog.far = camDist + DARK_FOG[1];
  }
  shake *= Math.exp(-dt * 6);
  // segue só x/z: o "quique" do jogador não balança a câmera
  camTarget.lerp(followPoint.set(playerMesh.position.x, 0.32, playerMesh.position.z), k(8));

  // sombra acompanha o jogador, alinhada à grade de texels para não "tremer"
  const sx = Math.round(camTarget.x / SHADOW_TEXEL) * SHADOW_TEXEL;
  const sz = Math.round(camTarget.z / SHADOW_TEXEL) * SHADOW_TEXEL;
  sun.position.set(sx + 8, 22, sz + 6);
  sun.target.position.set(sx, 0, sz);
  camera.position.set(
    camTarget.x + (Math.random() - 0.5) * shake,
    camTarget.y + camH,
    camTarget.z + camH * 0.55 + (Math.random() - 0.5) * shake,
  );
  camera.lookAt(camTarget);

  if (useBloom) composer.render();
  else renderer.render(scene, camera);
});

/* ---------- Início ---------- */
startLevel(); // labirinto de fundo atrás do menu
state.running = false;
Account.ready.then((user) => (state.best = user.best)).then(() => overlay(
  "Labirinto 3D",
  "Escape do labirinto",
  `Use <b>setas</b> / <b>WASD</b> (ou deslize no celular) para chegar ao <b>portal dourado</b>.<br>
   A partir do nível 2 o portal começa <b>trancado</b>: ache a <b>chave</b> 🔑 escondida no labirinto.<br>
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
