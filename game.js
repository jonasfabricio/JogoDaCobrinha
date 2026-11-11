const SIZE = 20;
const START = { r: 1, c: 1 };

function generateMaze(size) {
  const grid = Array.from({ length: size }, () => Array(size).fill(1));

  function carve(r, c) {
    grid[r][c] = 0;

    const dirs = [
      [-2, 0],
      [+2, 0],
      [0, -2],
      [0, +2],
    ];

    for (let i = dirs.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [dirs[i], dirs[j]] = [dirs[j], dirs[i]];
    }

    for (const [dr, dc] of dirs) {
      const nr = r + dr;
      const nc = c + dc;

      if (nr > 0 && nr < size - 1 && nc > 0 && nc < size - 1 && grid[nr][nc] === 1) {
        grid[r + dr / 2][c + dc / 2] = 0;
        carve(nr, nc);
      }
    }
  }

  carve(START.r, START.c);

  const exitPos = size - 2;
  grid[exitPos][exitPos] = 2;

  if (grid[exitPos - 1][exitPos] === 1 && grid[exitPos][exitPos - 1] === 1) {
    if (Math.random() < 0.5) {
      grid[exitPos - 1][exitPos] = 0;
    } else {
      grid[exitPos][exitPos - 1] = 0;
    }
  }

  return grid;
}

let MAZE = generateMaze(SIZE);

const DIRS = {
  up: [-1, 0],
  down: [+1, 0],
  left: [0, -1],
  right: [0, +1],
};

const KEY_DIRS = {
  ArrowUp: DIRS.up,
  ArrowDown: DIRS.down,
  ArrowLeft: DIRS.left,
  ArrowRight: DIRS.right,
  w: DIRS.up,
  a: DIRS.left,
  s: DIRS.down,
  d: DIRS.right,
  W: DIRS.up,
  A: DIRS.left,
  S: DIRS.down,
  D: DIRS.right,
};

const board = document.querySelector("#board");
const movesEl = document.querySelector("#moves");
const gameView = document.querySelector("#game-view");
const winView = document.querySelector("#win-view");
const loseView = document.querySelector("#lose-view");
const finalMoves = document.querySelector("#final-moves");
const movesLabel = document.querySelector("#moves-label");
const loseMoves = document.querySelector("#lose-moves");
const loseMovesLabel = document.querySelector("#lose-moves-label");
const perfectEl = document.querySelector("#perfect");
const confetti = document.querySelector("#confetti");
const againBtn = document.querySelector("#again");
const tryAgainBtn = document.querySelector("#try-again");

const cells = [];
let player = { ...START };
let moves = 0;
let won = false;
let winTimer = 0;
let loseTimer = 0;
let holdTimer = 0;
let keyTimer = 0;
const heldKeys = new Set();
let currentKey = null;

let monsters = [];
let monsterCount = 1;
let monsterTimer = 0;
let dead = false;

let shortest = shortestPath();

function shortestPath() {
  const queue = [[START.r, START.c, 0]];
  const seen = new Set([`${START.r},${START.c}`]);

  while (queue.length) {
    const [r, c, dist] = queue.shift();
    if (MAZE[r][c] === 2) return dist;

    for (const [dr, dc] of Object.values(DIRS)) {
      const nr = r + dr;
      const nc = c + dc;
      const key = `${nr},${nc}`;
      if (nr < 0 || nc < 0 || nr >= SIZE || nc >= SIZE) continue;
      if (MAZE[nr][nc] === 1 || seen.has(key)) continue;
      seen.add(key);
      queue.push([nr, nc, dist + 1]);
    }
  }

  return null;
}

function buildBoard() {
  board.replaceChildren();
  cells.length = 0;

  MAZE.forEach((row, r) => {
    row.forEach((tile, c) => {
      const cell = document.createElement("div");
      cell.className = tile === 1 ? "cell wall" : "cell floor";
      if (tile === 2) {
        cell.classList.add("exit");
        cell.setAttribute("aria-label", "Saída");
        const gate = document.createElement("span");
        gate.className = "gate";
        gate.setAttribute("aria-hidden", "true");
        cell.appendChild(gate);
      }
      board.appendChild(cell);
      cells.push(cell);
    });
  });

  renderPlayer();
  spawnMonsters();
  renderMonsters();
  window.clearInterval(monsterTimer);
  monsterTimer = window.setInterval(moveMonsters, 350);
}

function renderPlayer() {
  const current = board.querySelector(".player");
  if (current) current.remove();

  const token = document.createElement("span");
  token.className = "player";
  token.setAttribute("aria-label", "Jogador");
  cells[player.r * SIZE + player.c].appendChild(token);
}

function spawnMonsters() {
  const validCells = [];
  for (let r = 1; r < SIZE - 1; r++) {
    for (let c = 1; c < SIZE - 1; c++) {
      const dist = Math.abs(r - START.r) + Math.abs(c - START.c);
      if (MAZE[r][c] === 0 && dist >= 8) {
        validCells.push({ r, c });
      }
    }
  }

  // Embaralha as células válidas para não nascerem no mesmo lugar
  for (let i = validCells.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [validCells[i], validCells[j]] = [validCells[j], validCells[i]];
  }

  monsters = [];
  const total = Math.min(monsterCount, validCells.length);
  for (let i = 0; i < total; i++) {
    monsters.push({
      r: validCells[i].r,
      c: validCells[i].c,
      dir: DIRS.down,
    });
  }
}

function renderMonsters() {
  board.querySelectorAll(".monster").forEach((el) => el.remove());

  monsters.forEach((m) => {
    const token = document.createElement("span");
    token.className = "monster";
    token.setAttribute("aria-label", "Monstro");
    cells[m.r * SIZE + m.c].appendChild(token);
  });
}

function moveMonsters() {
  if (won || dead) return;

  monsters.forEach((m) => {
    const possibleDirs = Object.values(DIRS).filter(([dr, dc]) => {
      const nr = m.r + dr;
      const nc = m.c + dc;
      return (
        nr >= 0 &&
        nc >= 0 &&
        nr < SIZE &&
        nc < SIZE &&
        MAZE[nr][nc] === 0
      );
    });

    if (possibleDirs.length === 0) return;

    const [mdr, mdc] = m.dir;
    const forwardDirs = possibleDirs.filter(
      ([dr, dc]) => !(dr === -mdr && dc === -mdc)
    );
    const choices = forwardDirs.length > 0 ? forwardDirs : possibleDirs;

    m.dir = choices[Math.floor(Math.random() * choices.length)];
    const [nextDr, nextDc] = m.dir;
    m.r += nextDr;
    m.c += nextDc;
  });

  renderMonsters();
  checkCollision();
}

function checkCollision() {
  if (won || dead) return;

  const hit = monsters.some((m) => m.r === player.r && m.c === player.c);
  if (hit) {
    dead = true;
    monsterCount = 1; // Volta para 1 monstro se morrer
    window.clearInterval(monsterTimer);
    window.clearInterval(holdTimer);
    window.clearInterval(keyTimer);
    heldKeys.clear();
    currentKey = null;

    loseTimer = window.setTimeout(showLose, 280);
  }
}

function showLose() {
  if (loseMoves) loseMoves.textContent = String(moves);
  if (loseMovesLabel) loseMovesLabel.textContent = moves === 1 ? "movimento" : "movimentos";

  gameView.hidden = true;
  winView.hidden = true;
  if (loseView) loseView.hidden = false;
  if (tryAgainBtn) tryAgainBtn.focus();
}

function move(dr, dc) {
  if (won || dead) return;

  const nr = player.r + dr;
  const nc = player.c + dc;
  if (nr < 0 || nc < 0 || nr >= SIZE || nc >= SIZE) return;
  if (MAZE[nr][nc] === 1) return;

  player = { r: nr, c: nc };
  moves += 1;
  movesEl.textContent = String(moves);
  renderPlayer();

  checkCollision();
  if (dead) return;

  if (MAZE[nr][nc] === 2) {
    won = true;
    window.clearInterval(monsterTimer);
    winTimer = window.setTimeout(showWin, 320);
  }
}

function showWin() {
  monsterCount += 1;
  finalMoves.textContent = String(moves);
  movesLabel.textContent = moves === 1 ? "movimento" : "movimentos";

  if (shortest != null && moves === shortest) {
    perfectEl.textContent = "Esse é o caminho mais curto.";
  } else if (shortest != null) {
    perfectEl.textContent = `O caminho mais curto tem ${shortest} movimentos.`;
  } else {
    perfectEl.textContent = "";
  }

  spawnConfetti();
  gameView.hidden = true;
  if (loseView) loseView.hidden = true;
  winView.hidden = false;
  againBtn.focus();
}

function spawnConfetti() {
  const colors = ["#ffd166", "#2ec4b6", "#ff8fab", "#f4f1de", "#c77dff", "#f4a261"];
  confetti.replaceChildren();

  for (let i = 0; i < 42; i += 1) {
    const bit = document.createElement("span");
    bit.style.setProperty("--x", `${Math.random() * 100}%`);
    bit.style.setProperty("--r", `${120 + Math.random() * 420}deg`);
    bit.style.setProperty("--d", `${2.4 + Math.random() * 2.2}s`);
    bit.style.setProperty("--delay", `${Math.random() * 0.8}s`);
    bit.style.setProperty("--c", colors[i % colors.length]);
    confetti.appendChild(bit);
  }
}

function reset() {
  window.clearTimeout(winTimer);
  window.clearTimeout(loseTimer);
  window.clearInterval(holdTimer);
  window.clearInterval(keyTimer);
  window.clearInterval(monsterTimer);
  heldKeys.clear();
  currentKey = null;

  MAZE = generateMaze(SIZE);
  shortest = shortestPath();

  player = { ...START };
  moves = 0;
  won = false;
  dead = false;
  movesEl.textContent = "0";
  confetti.replaceChildren();
  winView.hidden = true;
  if (loseView) loseView.hidden = true;
  gameView.hidden = false;

  buildBoard();
}

function directionFrom(name) {
  return DIRS[name] || null;
}

document.querySelectorAll(".pad button").forEach((button) => {
  const dir = directionFrom(button.dataset.dir);

  const startHold = (event) => {
    event.preventDefault();
    move(...dir);
    window.clearInterval(holdTimer);
    holdTimer = window.setInterval(() => move(...dir), 150);
  };

  button.addEventListener("pointerdown", startHold);
  button.addEventListener("pointerup", () => window.clearInterval(holdTimer));
  button.addEventListener("pointerleave", () => window.clearInterval(holdTimer));
  button.addEventListener("pointercancel", () => window.clearInterval(holdTimer));
});

window.addEventListener("pointerup", () => window.clearInterval(holdTimer));

function heldDirection() {
  return currentKey ? KEY_DIRS[currentKey] : null;
}

window.addEventListener("keydown", (event) => {
  const dir = KEY_DIRS[event.key];
  if (!dir) return;
  event.preventDefault();
  if (event.repeat || heldKeys.has(event.key)) return;

  heldKeys.add(event.key);
  currentKey = event.key;
  move(...dir);
  window.clearInterval(keyTimer);
  keyTimer = window.setInterval(() => {
    const next = heldDirection();
    if (next) move(...next);
  }, 150);
});

window.addEventListener("keyup", (event) => {
  if (!KEY_DIRS[event.key]) return;
  heldKeys.delete(event.key);
  if (currentKey !== event.key) return;

  currentKey = [...heldKeys].pop() || null;
  if (!currentKey) window.clearInterval(keyTimer);
});

window.addEventListener("blur", () => {
  heldKeys.clear();
  currentKey = null;
  window.clearInterval(keyTimer);
  window.clearInterval(holdTimer);
});

document.querySelector("#restart").addEventListener("click", reset);
againBtn.addEventListener("click", reset);
if (tryAgainBtn) tryAgainBtn.addEventListener("click", reset);

buildBoard();

document.querySelector("#restart").addEventListener("click", () => {
  monsterCount = 1;
  reset();
});
againBtn.addEventListener("click", reset);
if (tryAgainBtn) tryAgainBtn.addEventListener("click", reset);

buildBoard();