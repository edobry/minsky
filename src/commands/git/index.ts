import { Command } from 'commander';
import { createCloneCommand } from './clone';
import { createBranchCommand } from './branch';
import { createPrCommand } from './pr';
import { createGitCommitCommand } from './commit';

export function createGitCommand(): Command {
  const git = new Command('git')
    .description('Git repository operations');

  git.addCommand(createCloneCommand());
  git.addCommand(createBranchCommand());
  git.addCommand(createPrCommand());
  git.addCommand(createGitCommitCommand());

  return git;
} 
