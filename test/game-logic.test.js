import { test } from "node:test";
import assert from "node:assert/strict";
import GameLogic from "../game-logic.cjs";

const { distancesFrom, createDistCache, cachedDistances, nextTickAcc, freeCellsFrom, shouldGrantLife } = GameLogic;
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
