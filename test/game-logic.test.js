import { test } from "node:test";
import assert from "node:assert/strict";
import GameLogic from "../game-logic.cjs";

const { distancesFrom, createDistCache, cachedDistances } = GameLogic;
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
