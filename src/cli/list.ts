import type { Command } from "commander";
import { createDefaultRegistries } from "../registry";

export function registerList(program: Command): void {
  program
    .command("list [kind]")
    .description("List registered plug-ins: drivers, evaluators, tasks (default: all).")
    .action((kind?: string) => {
      const { drivers, evaluators, tasks } = createDefaultRegistries();

      const show = (label: string, items: { name?: string; type?: string; description?: string }[]): void => {
        console.log(`\n${label}:`);
        for (const it of items) {
          const id = it.name ?? it.type ?? "?";
          console.log(`  ${id.padEnd(20)} ${it.description ?? ""}`);
        }
      };

      const k = kind?.toLowerCase();
      if (!k || k === "drivers" || k === "driver") show("Drivers", drivers.list());
      if (!k || k === "evaluators" || k === "evaluator") show("Evaluators", evaluators.list());
      if (!k || k === "tasks" || k === "task" || k === "task-types") show("Task types", tasks.list());
    });
}
