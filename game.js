const SIZE = 12;

// 0 caminho, 1 parede, 2 saída. O quadradinho começa em (1, 1).
const MAZE = [
  [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
  [1, 1, 0, 0, 1, 1, 1, 0, 1, 1, 0, 1],
  [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1],
  [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
  [1, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1],
  [1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
  [1, 1, 0, 0, 1, 1, 0, 1, 1, 1, 0, 1],
  [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1],
  [2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
  [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
];

const START = { r: 1, c: 1 };
const DIRS = {
  up: [-1, 0],
  down: [1, 0],
  left: [0, -1],
  right: [0, 1],
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
const finalMoves = document.querySelector("#final-moves");
const movesLabel = document.querySelector("#moves-label");
const perfectEl = document.querySelector("#perfect");
const confetti = document.querySelector("#confetti");
const againBtn = document.querySelector("#again");

const cells = [];
let player = { ...START };
let moves = 0;
let won = false;
let winTimer = 0;
let holdTimer = 0;
let keyTimer = 0;
const heldKeys = new Set();
let currentKey = null;

const shortest = shortestPath();

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
}

function renderPlayer() {
  const current = board.querySelector(".player");
  if (current) current.remove();

  const token = document.createElement("span");
  token.className = "player";
  token.setAttribute("aria-label", "Jogador");
  cells[player.r * SIZE + player.c].appendChild(token);
}

function move(dr, dc) {
  if (won) return;

  const nr = player.r + dr;
  const nc = player.c + dc;
  if (nr < 0 || nc < 0 || nr >= SIZE || nc >= SIZE) return;
  if (MAZE[nr][nc] === 1) return;

  player = { r: nr, c: nc };
  moves += 1;
  movesEl.textContent = String(moves);
  renderPlayer();

  if (MAZE[nr][nc] === 2) {
    won = true;
    winTimer = window.setTimeout(showWin, 320);
  }
}

function showWin() {
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
  window.clearInterval(holdTimer);
  window.clearInterval(keyTimer);
  heldKeys.clear();
  currentKey = null;
  player = { ...START };
  moves = 0;
  won = false;
  movesEl.textContent = "0";
  confetti.replaceChildren();
  winView.hidden = true;
  gameView.hidden = false;
  renderPlayer();
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

buildBoard();
