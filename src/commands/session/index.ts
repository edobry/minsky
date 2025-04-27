import { Command } from 'commander';
import { createListCommand } from './list';
import { createGetCommand } from './get';
import { createDirCommand } from './cd';
import { createStartCommand } from './start';

export function createSessionCommand(): Command {
  const session = new Command('session')
    .description('Session management commands');

  session.addCommand(createListCommand());
  session.addCommand(createGetCommand());
  session.addCommand(createDirCommand());
  session.addCommand(createStartCommand());

  return session;
} 
