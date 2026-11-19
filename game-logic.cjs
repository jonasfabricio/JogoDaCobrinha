// Lógica pura do jogo, sem DOM/Three.js: roda no navegador (globalThis.GameLogic) e no Node (require).
(function (root) {
  const WALL = 1, FLOOR = 0;
  const DIRS = [[-1, 0], [1, 0], [0, -1], [0, 1]];

  function distancesFrom(maze, sr, sc) {
    const N = maze.length;
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

  const createDistCache = () => ({ r: -1, c: -1, maze: null, grid: null });

  // O labirinto nunca é alterado dentro de um nível: a identidade do array basta para invalidar.
  function cachedDistances(cache, maze, r, c) {
    if (cache.maze !== maze || cache.r !== r || cache.c !== c) {
      cache.grid = distancesFrom(maze, r, c);
      cache.maze = maze;
      cache.r = r;
      cache.c = c;
    }
    return cache.grid;
  }

  // Desconta um tick mantendo o resto fracionário (zerar faria os monstros atrasarem a cada quadro pesado).
  const nextTickAcc = (acc, tickMs) => (acc >= tickMs ? acc - tickMs : acc);

  // Casas de chão a pelo menos minDist de `from` (exceto o início 1,1), em ordem de leitura.
  function freeCellsFrom(maze, minDist, from, distGrid = distancesFrom(maze, from.r, from.c)) {
    const out = [];
    maze.forEach((row, r) => row.forEach((t, c) => {
      if (t === FLOOR && distGrid[r][c] >= minDist && !(r === 1 && c === 1)) out.push({ r, c });
    }));
    return out;
  }

  const shouldGrantLife = (completedLevel, lives, { every = 5, max = 3 } = {}) =>
    completedLevel > 0 && completedLevel % every === 0 && lives < max;

  // Qualidade adaptativa (tempos em segundos). Histerese: desce com média > 20 ms em 2 s,
  // mas só sobe depois de 6 s seguidos de quadros < 12 ms — assim não fica oscilando.
  const QUALITY = { maxLevel: 3, downAvg: 0.02, downWindow: 2, upFrame: 0.012, upWindow: 6 };
  const shouldDowngrade = (level, avg, q = QUALITY) => level < q.maxLevel && avg > q.downAvg;
  const shouldUpgrade = (level, goodTime, q = QUALITY) => level > 0 && goodTime >= q.upWindow;

  /* ---------- Monstros ---------- */

  // Direção (0-3) para a casa de chão vizinha mais perto do alvo do mapa `dist`; -1 se não houver.
  function stepToward(dist, maze, r, c) {
    let best = Infinity, pick = -1;
    for (let i = 0; i < 4; i++) {
      const nr = r + DIRS[i][0], nc = c + DIRS[i][1];
      if (maze[nr][nc] === FLOOR && dist[nr][nc] < best) { best = dist[nr][nc]; pick = i; }
    }
    return pick;
  }

  // Phantom atravessa paredes: anda no eixo em que está mais longe do alvo.
  function phantomStep(r, c, tr, tc) {
    const dr = tr - r, dc = tc - c;
    if (!dr && !dc) return -1;
    if (Math.abs(dr) >= Math.abs(dc)) return dr < 0 ? 0 : 1;
    return dc < 0 ? 2 : 3;
  }

  // Circuito fechado de casas vizinhas passando por (r, c): o menor caminho entre dois vizinhos
  // de (r, c) que não passa por ela. O labirinto é "braided", então quase toda casa está num ciclo.
  function patrolLoop(maze, r, c, maxLen = 40) {
    const N = maze.length;
    const nbs = DIRS.map(([dr, dc]) => [r + dr, c + dc]).filter(([nr, nc]) => maze[nr][nc] === FLOOR);
    let best = null;
    for (let a = 0; a < nbs.length; a++) {
      for (let b = a + 1; b < nbs.length; b++) {
        const prev = Array.from({ length: N }, () => Array(N).fill(null));
        const [sr, sc] = nbs[a], [er, ec] = nbs[b];
        prev[r][c] = prev[sr][sc] = [-1, -1];
        const q = [[sr, sc]];
        for (let i = 0; i < q.length && !prev[er][ec]; i++) {
          const [qr, qc] = q[i];
          for (const [dr, dc] of DIRS) {
            const nr = qr + dr, nc = qc + dc;
            if (maze[nr][nc] === FLOOR && !prev[nr][nc]) { prev[nr][nc] = [qr, qc]; q.push([nr, nc]); }
          }
        }
        if (!prev[er][ec]) continue;
        const path = [];
        for (let p = [er, ec]; p[0] !== -1; p = prev[p[0]][p[1]]) path.push({ r: p[0], c: p[1] });
        const loop = [{ r, c }, ...path.reverse()];
        if (loop.length <= maxLen && (!best || loop.length < best.length)) best = loop;
      }
    }
    return best;
  }

  // Tipos dos monstros do nível. Mantém o padrão antigo (andarilho/caçador alternados) e troca os
  // últimos por Phantoms (nível 6+, 2 no 12+) e Sentinelas (nível 4+, 2 no 9+); o primeiro é sempre andarilho.
  function monsterTypes(level, count) {
    const types = Array.from({ length: count }, (_, i) => (level >= 2 && i % 2 === 1 ? "hunter" : "wanderer"));
    const phantoms = level >= 12 ? 2 : level >= 6 ? 1 : 0;
    const sentinels = level >= 9 ? 2 : level >= 4 ? 1 : 0;
    let k = count - 1;
    for (let n = 0; n < phantoms && k > 0; n++) types[k--] = "phantom";
    for (let n = 0; n < sentinels && k > 0; n++) types[k--] = "sentinel";
    return types;
  }

  /* ---------- Chefe (níveis 10, 20, 30…) ---------- */

  const isBossLevel = (level) => level > 0 && level % 10 === 0;

  // Ciclo de fases: perseguir rápido → telegrafar (parado, piscando) → investida em linha reta → …
  const BOSS = { hp: 3, chase: 3000, telegraph: 1500, dash: 2500 };
  const BOSS_NEXT = { chase: "telegraph", telegraph: "dash", dash: "chase" };
  const bossNextPhase = (phase, now) => {
    const next = BOSS_NEXT[phase];
    return { phase: next, until: now + BOSS[next] };
  };

  // Direção da investida: se o jogador está na mesma linha/coluna e o primeiro passo é livre, vai reto
  // nele; senão, pela direção do caminho mais curto.
  function dashDirection(maze, r, c, pr, pc, dist) {
    for (let i = 0; i < 4; i++) {
      const [dr, dc] = DIRS[i];
      const aligned = (dc === 0 && pc === c && Math.sign(pr - r) === dr) || (dr === 0 && pr === r && Math.sign(pc - c) === dc);
      if (aligned && maze[r + dr][c + dc] === FLOOR) return i;
    }
    return stepToward(dist, maze, r, c);
  }

  /* ---------- Modificadores de nível ---------- */

  // Um a cada 3 níveis a partir do 4 (4, 7, 13, 16…), em rodízio. Esses níveis nunca são escuros
  // (múltiplos de 3), então a neblina densa não se soma ao escuro; níveis-chefe ficam sem modificador.
  const MODIFIERS = ["mirror", "noFlake", "denseFog"];
  const MIRROR_MS = 8000;
  const hasModifier = (level) => level >= 4 && level % 3 === 1 && !isBossLevel(level);
  function levelModifier(level) {
    if (!hasModifier(level)) return null;
    let k = 0;
    for (let l = 4; l < level; l++) if (hasModifier(l)) k++;
    return MODIFIERS[k % MODIFIERS.length];
  }

  // Bônus ao concluir o nível: escuro ×1,5 e chefe ×2 (acumulam; o nível 30 é os dois).
  const levelBonus = (level, { dark = false, boss = false } = {}) =>
    Math.round((300 + level * 100) * (dark ? 1.5 : 1) * (boss ? 2 : 1));
  const BOSS_DEFEAT_BONUS = 1000;

  const GameLogic = {
    levelBonus, BOSS_DEFEAT_BONUS,
    distancesFrom, createDistCache, cachedDistances, nextTickAcc, freeCellsFrom, shouldGrantLife,
    QUALITY, shouldDowngrade, shouldUpgrade,
    stepToward, phantomStep, patrolLoop, monsterTypes,
    isBossLevel, BOSS, bossNextPhase, dashDirection,
    MODIFIERS, MIRROR_MS, levelModifier,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = GameLogic;
  else root.GameLogic = GameLogic;
})(globalThis);
