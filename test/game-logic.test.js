import { test } from "node:test";
import assert from "node:assert/strict";
import GameLogic from "../game-logic.cjs";

const { distancesFrom, createDistCache, cachedDistances, nextTickAcc, freeCellsFrom, shouldGrantLife,
  QUALITY, shouldDowngrade, shouldUpgrade,
  stepToward, phantomStep, patrolLoop, monsterTypes,
  isBossLevel, BOSS, bossNextPhase, dashDirection, levelBonus,
  MODIFIERS, levelModifier } = GameLogic;
const I = Infinity;

const maze = [
  [1, 1, 1, 1, 1],
  [1, 0, 0, 0, 1],
  [1, 1, 1, 0, 1],
  [1, 0, 0, 2, 1],
  [1, 1, 1, 1, 1],
];

test("distancesFrom calcula a distância BFS seguindo o corredor", () => {
  assert.deepEqual(distancesFrom(maze, 1, 1), [
    [I, I, I, I, I],
    [I, 0, 1, 2, I],
    [I, I, I, 3, I],
    [I, 6, 5, 4, I],
    [I, I, I, I, I],
  ]);
});

test("distancesFrom trata a saída como célula andável e paredes como inalcançáveis", () => {
  const d = distancesFrom(maze, 3, 3);
  assert.equal(d[3][3], 0);
  assert.equal(d[1][1], 4);
  assert.equal(d[2][1], I);
});

test("distancesFrom deixa regiões isoladas como Infinity", () => {
  const closed = [
    [1, 1, 1, 1, 1],
    [1, 0, 1, 0, 1],
    [1, 1, 1, 1, 1],
    [1, 0, 0, 0, 1],
    [1, 1, 1, 1, 1],
  ];
  const d = distancesFrom(closed, 1, 1);
  assert.equal(d[3][2], I);
  assert.equal(d[1][1], 0);
  assert.equal(d[1][3], I);
});

test("distancesFrom não altera o labirinto recebido", () => {
  const copy = maze.map((row) => [...row]);
  distancesFrom(maze, 1, 1);
  assert.deepEqual(maze, copy);
});

test("cachedDistances: mesma posição e mesmo labirinto devolvem o mesmo grid", () => {
  const cache = createDistCache();
  const a = cachedDistances(cache, maze, 1, 1);
  assert.equal(cachedDistances(cache, maze, 1, 1), a);
});

test("cachedDistances: posição diferente recomputa", () => {
  const cache = createDistCache();
  const a = cachedDistances(cache, maze, 1, 1);
  const b = cachedDistances(cache, maze, 3, 3);
  assert.notEqual(b, a);
  assert.deepEqual(b, distancesFrom(maze, 3, 3));
});

test("cachedDistances: labirinto novo (outra referência) recomputa", () => {
  const cache = createDistCache();
  const a = cachedDistances(cache, maze, 1, 1);
  const other = maze.map((row) => [...row]);
  other[2][3] = 1;
  const b = cachedDistances(cache, other, 1, 1);
  assert.notEqual(b, a);
  assert.equal(b[3][3], Infinity);
});

test("cachedDistances: resultado em cache é igual a uma chamada fresca", () => {
  const cache = createDistCache();
  cachedDistances(cache, maze, 1, 1);
  assert.deepEqual(cachedDistances(cache, maze, 1, 1), distancesFrom(maze, 1, 1));
});

test("nextTickAcc desconta um tick e mantém o resto", () => {
  assert.equal(nextTickAcc(215, 200), 15);
  assert.equal(nextTickAcc(200, 200), 0);
});

test("nextTickAcc abaixo do limiar não muda o acumulador", () => {
  assert.equal(nextTickAcc(150, 200), 150);
});

test("freeCellsFrom com distGrid pré-computado == computado internamente", () => {
  const start = { r: 1, c: 1 };
  const grid = distancesFrom(maze, 1, 1);
  for (const min of [0, 2, 4, 99]) {
    assert.deepEqual(freeCellsFrom(maze, min, start, grid), freeCellsFrom(maze, min, start));
  }
});

test("freeCellsFrom respeita a distância mínima e ignora início, paredes e saída", () => {
  const cells = freeCellsFrom(maze, 3, { r: 1, c: 1 });
  assert.deepEqual(cells, [{ r: 2, c: 3 }, { r: 3, c: 1 }, { r: 3, c: 2 }]);
});

test("shouldGrantLife dá vida a cada 5 níveis, respeitando o teto de 3", () => {
  assert.equal(shouldGrantLife(5, 2), true);
  assert.equal(shouldGrantLife(5, 3), false);
  assert.equal(shouldGrantLife(4, 1), false);
  assert.equal(shouldGrantLife(10, 1), true);
  assert.equal(shouldGrantLife(15, 3), false);
});

test("shouldGrantLife aceita intervalo e teto personalizados", () => {
  assert.equal(shouldGrantLife(3, 4, { every: 3, max: 5 }), true);
  assert.equal(shouldGrantLife(5, 4, { every: 3, max: 5 }), false);
});

test("shouldDowngrade desce com média lenta e para no degrau 3", () => {
  assert.equal(shouldDowngrade(0, 0.025), true);
  assert.equal(shouldDowngrade(2, 0.03), true);
  assert.equal(shouldDowngrade(3, 0.05), false);
  assert.equal(shouldDowngrade(0, 0.016), false);
});

test("shouldUpgrade sobe só após a janela inteira de quadros bons e nunca abaixo de 0", () => {
  assert.equal(shouldUpgrade(1, 6), true);
  assert.equal(shouldUpgrade(3, 7.5), true);
  assert.equal(shouldUpgrade(1, 5.9), false);
  assert.equal(shouldUpgrade(0, 100), false);
});

test("histerese: quadros que contam para subir nunca disparam a descida", () => {
  assert.ok(QUALITY.upFrame < QUALITY.downAvg);
  assert.ok(QUALITY.upWindow > QUALITY.downWindow);
  for (let level = 0; level <= QUALITY.maxLevel; level++) {
    assert.equal(shouldDowngrade(level, QUALITY.upFrame), false);
  }
});

// 7×7 com um anel em volta de um bloco central de paredes.
const ring = [
  [1, 1, 1, 1, 1, 1, 1],
  [1, 0, 0, 0, 0, 0, 1],
  [1, 0, 1, 1, 1, 0, 1],
  [1, 0, 1, 1, 1, 0, 1],
  [1, 0, 1, 1, 1, 0, 1],
  [1, 0, 0, 0, 0, 0, 1],
  [1, 1, 1, 1, 1, 1, 1],
];
const adjacent = (a, b) => Math.abs(a.r - b.r) + Math.abs(a.c - b.c) === 1;

test("stepToward escolhe o vizinho de chão mais perto do alvo", () => {
  const d = distancesFrom(maze, 3, 1);
  assert.equal(stepToward(d, maze, 1, 1), 3); // do início, só dá para ir à direita
  assert.equal(stepToward(d, maze, 3, 2), 2); // vai para a esquerda, em direção a (3,1)
});

test("stepToward devolve -1 sem vizinho de chão", () => {
  const closed = [[1, 1, 1], [1, 0, 1], [1, 1, 1]];
  assert.equal(stepToward(distancesFrom(closed, 1, 1), closed, 1, 1), -1);
});

test("phantomStep anda no eixo mais distante e para no alvo", () => {
  assert.equal(phantomStep(5, 5, 1, 4), 0);
  assert.equal(phantomStep(5, 5, 9, 6), 1);
  assert.equal(phantomStep(5, 5, 6, 1), 2);
  assert.equal(phantomStep(5, 5, 4, 9), 3);
  assert.equal(phantomStep(5, 5, 5, 5), -1);
});

test("patrolLoop fecha um circuito de casas vizinhas passando pela origem", () => {
  const loop = patrolLoop(ring, 1, 3);
  assert.equal(loop.length, 16);
  assert.deepEqual(loop[0], { r: 1, c: 3 });
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i], b = loop[(i + 1) % loop.length];
    assert.ok(adjacent(a, b), `${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
    assert.equal(ring[a.r][a.c], 0);
  }
  assert.equal(new Set(loop.map((p) => p.r * 7 + p.c)).size, loop.length);
});

test("patrolLoop devolve null num corredor sem ciclo ou acima do tamanho máximo", () => {
  assert.equal(patrolLoop(maze, 1, 2), null);
  assert.equal(patrolLoop(ring, 1, 3, 10), null);
});

test("monsterTypes mantém o padrão antigo e adiciona Sentinela/Phantom por nível", () => {
  assert.deepEqual(monsterTypes(1, 2), ["wanderer", "wanderer"]);
  assert.deepEqual(monsterTypes(3, 4), ["wanderer", "hunter", "wanderer", "hunter"]);
  assert.deepEqual(monsterTypes(4, 4), ["wanderer", "hunter", "wanderer", "sentinel"]);
  assert.deepEqual(monsterTypes(6, 5), ["wanderer", "hunter", "wanderer", "sentinel", "phantom"]);
  const t12 = monsterTypes(12, 10);
  assert.equal(t12.filter((t) => t === "phantom").length, 2);
  assert.equal(t12.filter((t) => t === "sentinel").length, 2);
  assert.equal(monsterTypes(12, 2)[0], "wanderer");
});

test("isBossLevel só nos múltiplos de 10", () => {
  assert.deepEqual([1, 5, 9, 10, 11, 20, 30].map(isBossLevel), [false, false, false, true, false, true, true]);
});

test("bossNextPhase cicla perseguir → telegrafar → investida → perseguir com a duração de cada fase", () => {
  let p = { phase: "chase", until: 0 };
  const seen = [];
  for (let i = 0, now = 1000; i < 4; i++, now = p.until) {
    p = bossNextPhase(p.phase, now);
    seen.push(p.phase);
    assert.equal(p.until - now, BOSS[p.phase]);
  }
  assert.deepEqual(seen, ["telegraph", "dash", "chase", "telegraph"]);
});

test("dashDirection vai reto no jogador alinhado e cai no caminho mais curto quando não está", () => {
  const d = distancesFrom(ring, 1, 5);
  assert.equal(dashDirection(ring, 1, 1, 1, 5, d), 3); // mesma linha, à direita
  assert.equal(dashDirection(ring, 5, 1, 1, 1, distancesFrom(ring, 1, 1)), 0); // mesma coluna, acima
  const far = distancesFrom(ring, 5, 5);
  const dir = dashDirection(ring, 1, 3, 5, 5, far);
  assert.equal(far[1 + [-1, 1, 0, 0][dir]][3 + [0, 0, -1, 1][dir]], far[1][3] - 1);
});

test("dashDirection não investe através de parede", () => {
  // jogador na mesma coluna, mas com parede logo abaixo: segue o caminho
  const d = distancesFrom(ring, 5, 3);
  const dir = dashDirection(ring, 1, 3, 5, 3, d);
  assert.notEqual(dir, 1);
});

test("levelBonus aplica escuro ×1,5 e chefe ×2 acumulados", () => {
  assert.equal(levelBonus(1), 400);
  assert.equal(levelBonus(3, { dark: true }), 900);
  assert.equal(levelBonus(10, { boss: true }), 2600);
  assert.equal(levelBonus(30, { dark: true, boss: true }), 9900);
});

test("levelModifier: um a cada 3 níveis a partir do 4, em rodízio, pulando o nível-chefe", () => {
  const got = {};
  for (let l = 1; l <= 31; l++) if (levelModifier(l)) got[l] = levelModifier(l);
  assert.deepEqual(got, { 4: "mirror", 7: "noFlake", 13: "denseFog", 16: "mirror", 19: "noFlake", 22: "denseFog", 25: "mirror", 28: "noFlake", 31: "denseFog" });
});

test("levelModifier nunca cai em nível escuro nem em nível-chefe e usa todos os modificadores", () => {
  const seen = new Set();
  for (let l = 1; l <= 200; l++) {
    const m = levelModifier(l);
    if (!m) continue;
    seen.add(m);
    assert.notEqual(l % 3, 0, `nível ${l} é escuro`);
    assert.equal(isBossLevel(l), false, `nível ${l} é chefe`);
  }
  assert.deepEqual([...seen].sort(), [...MODIFIERS].sort());
});
