import { Command } from 'commander';
import { join } from 'path';

export function createCdCommand(): Command {
  return new Command('cd')
    .description('Print the workdir path for a session (for use with cd $(minsky session cd <session>))')
    .argument('<session>', 'Session identifier')
    .action((session: string) => {
      const xdgStateHome = process.env.XDG_STATE_HOME || join(process.env.HOME || '', '.local/state');
      const workdir = join(xdgStateHome, 'minsky', 'git', session);
      console.log(workdir);
    });
} 
