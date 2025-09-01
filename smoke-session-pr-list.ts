import { createSessionPrListCommand } from "./src/adapters/shared/commands/session/pr-subcommand-commands";
import type { CommandExecutionContext } from "./src/adapters/shared/commands/command-registry";

async function main() {
  const cmd = createSessionPrListCommand();
  const ctx: CommandExecutionContext = {
    interface: "cli",
    debug: false,
    format: "json",
    cliSpecificData: { command: undefined as any, rawArgs: [] },
  };
  const result = await cmd.execute({ json: true } as any, ctx);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => { console.error(err); process.exit(1); });
