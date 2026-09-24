import path from "node:path";
import fs from "node:fs";

export default function (pi: any) {
  const role = process.env.PI_HARNESS_ROLE;
  const root = path.resolve(process.env.PI_HARNESS_CWD || process.cwd());
  pi.on("tool_call", async (event: any, ctx: any) => {
    const name = event.toolName ?? event.name;
    const args = event.input ?? event.args ?? {};
    if (name === "bash" || name === "exec") return { block: true, reason: "コマンド実行は禁止されています" };
    if (name !== "write" && name !== "edit") return;
    if (role !== "edit") return { block: true, reason: "読み取り役割ではファイル変更は禁止されています" };
    const raw = args.path ?? args.file_path;
    if (typeof raw !== "string" || path.isAbsolute(raw)) return { block: true, reason: "絶対パスへの書き込みは禁止されています" };
    const target = path.resolve(root, raw);
    const rel = path.relative(root, target);
    if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return { block: true, reason: "作業ツリー外への書き込みは禁止されています" };
    let probe = target;
    while (true) {
      try {
        const real = fs.realpathSync(probe);
        const rootReal = fs.realpathSync(root);
        const realRel = path.relative(rootReal, real);
        if (realRel === ".." || realRel.startsWith(`..${path.sep}`) || path.isAbsolute(realRel)) return { block: true, reason: "シンボリックリンク経由の外部書き込みは禁止されています" };
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { block: true, reason: "書き込み先を検証できません" };
        const parent = path.dirname(probe);
        if (parent === probe) break;
        probe = parent;
      }
    }
  });
}
