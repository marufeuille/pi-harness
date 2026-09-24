import type { Task } from "./contract.ts";

const taskIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,48}$/;

export function schedule(tasks: Task[]): Task[][] {
  if (tasks.length === 0) {
    throw new Error("プランにタスクがありません");
  }

  const byId = new Map<string, Task>();
  for (const task of tasks) {
    if (!taskIdPattern.test(task.id)) {
      throw new Error(`タスク id は英数字で始まる短い名前にしてください: ${task.id}`);
    }
    if (byId.has(task.id)) {
      throw new Error(`タスク id が重複しています: ${task.id}`);
    }
    byId.set(task.id, task);
  }

  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!byId.has(dependency)) {
        throw new Error(`${task.id} が存在しないタスク ${dependency} に依存しています`);
      }
    }
  }

  const pending = new Set(tasks.map((task) => task.id));
  const done = new Set<string>();
  const waves: Task[][] = [];

  while (pending.size > 0) {
    const wave = [...pending]
      .map((id) => byId.get(id) as Task)
      .filter((task) => task.dependsOn.every((dependency) => done.has(dependency)))
      .sort((left, right) => left.id.localeCompare(right.id));

    if (wave.length === 0) {
      throw new Error("タスクの依存関係が循環しています");
    }

    waves.push(wave);
    for (const task of wave) {
      pending.delete(task.id);
      done.add(task.id);
    }
  }

  return waves;
}
