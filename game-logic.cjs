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

  const GameLogic = { distancesFrom, createDistCache, cachedDistances, nextTickAcc, freeCellsFrom, shouldGrantLife };
  if (typeof module !== "undefined" && module.exports) module.exports = GameLogic;
  else root.GameLogic = GameLogic;
})(globalThis);
