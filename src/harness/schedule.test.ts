import assert from "node:assert/strict";
import test from "node:test";

import { schedule } from "./schedule.ts";
import type { Task } from "./contract.ts";

function task(id: string, dependsOn: string[] = []): Task {
  return { id, title: id, dependsOn, instructions: id };
}

test("依存のないタスクは同じ wave になり、依存先のあとへ回る", () => {
  const waves = schedule([task("c", ["a", "b"]), task("a"), task("b")]);
  assert.deepEqual(
    waves.map((wave) => wave.map((item) => item.id)),
    [["a", "b"], ["c"]],
  );
});

test("循環した依存は実行しない", () => {
  assert.throws(() => schedule([task("a", ["b"]), task("b", ["a"])]), /循環/);
});
