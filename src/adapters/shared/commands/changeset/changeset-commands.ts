/**
 * Changeset CLI Commands
 * 
 * Provides CLI access to the unified changeset abstraction layer.
 */

import { createChangesetService } from '../../../../domain/changeset/index';
import type { ChangesetListOptions, ChangesetSearchOptions } from '../../../../domain/changeset/types';
import { resolveRepositoryAndBackend } from '../../../../domain/session/repository-backend-detection';
import { BaseCommand, type CommandExecutionContext } from '../base-command';
import { log } from '../../../../utils/logger';
import { getErrorMessage } from '../../../../errors/index';

/**
 * Parameters for changeset list command
 */
interface ChangesetListParams {
  status?: string;
  author?: string;
  targetBranch?: string;
  limit?: number;
  includeClosed?: boolean;
  repo?: string;
  json?: boolean;
}

/**
 * Parameters for changeset search command
 */
interface ChangesetSearchParams {
  query: string;
  status?: string;
  author?: string;
  limit?: number;
  searchTitle?: boolean;
  searchDescription?: boolean;
  searchComments?: boolean;
  searchCommits?: boolean;
  repo?: string;
  json?: boolean;
}

/**
 * Parameters for changeset get command
 */
interface ChangesetGetParams {
  id: string;
  details?: boolean;
  repo?: string;
  json?: boolean;
}

/**
 * List changesets in the repository
 */
export class ChangesetListCommand extends BaseCommand {
  readonly id = 'changeset.list';
  readonly name = 'list';
  readonly description = 'List changesets (PRs/MRs) in the repository';
  
  readonly parameters = {
    status: {
      type: 'string',
      description: 'Filter by status (open, merged, closed, draft)',
      required: false,
    },
    author: {
      type: 'string', 
      description: 'Filter by author username',
      required: false,
    },
    targetBranch: {
      type: 'string',
      description: 'Filter by target branch',
      required: false,
    },
    limit: {
      type: 'number',
      description: 'Maximum number of results (default: 30)',
      required: false,
    },
    includeClosed: {
      type: 'boolean',
      description: 'Include closed/merged changesets',
      required: false,
    },
    repo: {
      type: 'string',
      description: 'Repository path or URL',
      required: false,
    },
    json: {
      type: 'boolean',
      description: 'Output in JSON format',
      required: false,
    },
  };
  
  async execute(params: ChangesetListParams, ctx?: CommandExecutionContext): Promise<any> {
    try {
      // Resolve repository
      const { repoUrl } = await resolveRepositoryAndBackend({
        repoParam: params.repo,
      });
      
      // Create changeset service
      const changesetService = await createChangesetService(repoUrl);
      
      // Build list options
      const listOptions: ChangesetListOptions = {
        status: params.status as any,
        author: params.author,
        targetBranch: params.targetBranch,
        limit: params.limit || 30,
        includeClosed: params.includeClosed,
      };
      
      // Get changesets
      const changesets = await changesetService.list(listOptions);
      
      if (params.json || ctx?.format === 'json') {
        return {
          success: true,
          data: {
            changesets,
            count: changesets.length,
            repository: repoUrl,
            platform: changesets[0]?.platform,
          },
        };
      }
      
      // Human-readable output
      if (changesets.length === 0) {
        log.cli('No changesets found matching criteria');
        return { success: true };
      }
      
      const platform = await changesetService.getPlatform();
      log.cli(`\n📋 Changesets in ${repoUrl} (${platform})\n${'━'.repeat(60)}\n`);
      
      for (const changeset of changesets) {
        const statusIcon = changeset.status === 'open' ? '🟢' : 
                          changeset.status === 'merged' ? '🟣' : '🔴';
        
        log.cli(`${statusIcon} ${changeset.id}: ${changeset.title}`);
        log.cli(`   Author: ${changeset.author.username} | Target: ${changeset.targetBranch} | Status: ${changeset.status}`);
        
        if (changeset.description && changeset.description !== changeset.title) {
          const shortDesc = changeset.description.substring(0, 80);
          log.cli(`   ${shortDesc}${changeset.description.length > 80 ? '...' : ''}`);
        }
        
        log.cli(''); // Empty line
      }
      
      log.cli(`Found ${changesets.length} changeset(s)`);
      
      return { success: true };
      
    } catch (error) {
      const errorMsg = `Failed to list changesets: ${getErrorMessage(error)}`;
      log.cliError(errorMsg);
      return { success: false, error: errorMsg };
    }
  }
}

/**
 * Search changesets by query
 */
export class ChangesetSearchCommand extends BaseCommand {
  readonly id = 'changeset.search';
  readonly name = 'search';
  readonly description = 'Search changesets by query';
  
  readonly parameters = {
    query: {
      type: 'string',
      description: 'Search query',
      required: true,
    },
    status: {
      type: 'string',
      description: 'Filter by status (open, merged, closed, draft)',
      required: false,
    },
    author: {
      type: 'string',
      description: 'Filter by author username',
      required: false,
    },
    limit: {
      type: 'number',
      description: 'Maximum number of results (default: 20)',
      required: false,
    },
    searchTitle: {
      type: 'boolean',
      description: 'Search in titles (default: true)',
      required: false,
    },
    searchDescription: {
      type: 'boolean',
      description: 'Search in descriptions (default: true)',
      required: false,
    },
    searchComments: {
      type: 'boolean',
      description: 'Search in comments (default: true)',
      required: false,
    },
    searchCommits: {
      type: 'boolean',
      description: 'Search in commit messages (default: true)',
      required: false,
    },
    repo: {
      type: 'string',
      description: 'Repository path or URL',
      required: false,
    },
    json: {
      type: 'boolean',
      description: 'Output in JSON format',
      required: false,
    },
  };
  
  async execute(params: ChangesetSearchParams, ctx?: CommandExecutionContext): Promise<any> {
    try {
      // Resolve repository
      const { repoUrl } = await resolveRepositoryAndBackend({
        repoParam: params.repo,
      });
      
      // Create changeset service
      const changesetService = await createChangesetService(repoUrl);
      
      // Build search options
      const searchOptions: ChangesetSearchOptions = {
        query: params.query,
        status: params.status as any,
        author: params.author,
        limit: params.limit || 20,
        searchTitle: params.searchTitle !== false,
        searchDescription: params.searchDescription !== false,
        searchComments: params.searchComments !== false,
        searchCommits: params.searchCommits !== false,
      };
      
      // Perform search
      const changesets = await changesetService.search(searchOptions);
      
      if (params.json || ctx?.format === 'json') {
        return {
          success: true,
          data: {
            query: params.query,
            changesets,
            count: changesets.length,
            repository: repoUrl,
          },
        };
      }
      
      // Human-readable output
      if (changesets.length === 0) {
        log.cli(`No changesets found matching "${params.query}"`);
        return { success: true };
      }
      
      const platform = await changesetService.getPlatform();
      log.cli(`\n🔍 Search results for "${params.query}" in ${repoUrl} (${platform})\n${'━'.repeat(60)}\n`);
      
      for (const changeset of changesets) {
        const statusIcon = changeset.status === 'open' ? '🟢' : 
                          changeset.status === 'merged' ? '🟣' : '🔴';
        
        log.cli(`${statusIcon} ${changeset.id}: ${changeset.title}`);
        log.cli(`   Author: ${changeset.author.username} | Target: ${changeset.targetBranch}`);
        
        // Show matching context
        if (changeset.description.toLowerCase().includes(params.query.toLowerCase())) {
          const desc = changeset.description.substring(0, 100);
          log.cli(`   📝 ${desc}${changeset.description.length > 100 ? '...' : ''}`);
        }
        
        log.cli(''); // Empty line
      }
      
      log.cli(`Found ${changesets.length} matching changeset(s)`);
      
      return { success: true };
      
    } catch (error) {
      const errorMsg = `Failed to search changesets: ${getErrorMessage(error)}`;
      log.cliError(errorMsg);
      return { success: false, error: errorMsg };
    }
  }
}

/**
 * Get details for a specific changeset
 */
export class ChangesetGetCommand extends BaseCommand {
  readonly id = 'changeset.get';
  readonly name = 'get';
  readonly description = 'Get details for a specific changeset';
  
  readonly parameters = {
    id: {
      type: 'string',
      description: 'Changeset ID (PR number, branch name, etc.)',
      required: true,
    },
    details: {
      type: 'boolean',
      description: 'Include detailed diff information',
      required: false,
    },
    repo: {
      type: 'string',
      description: 'Repository path or URL',
      required: false,
    },
    json: {
      type: 'boolean',
      description: 'Output in JSON format',
      required: false,
    },
  };
  
  async execute(params: ChangesetGetParams, ctx?: CommandExecutionContext): Promise<any> {
    try {
      // Resolve repository
      const { repoUrl } = await resolveRepositoryAndBackend({
        repoParam: params.repo,
      });
      
      // Create changeset service
      const changesetService = await createChangesetService(repoUrl);
      
      // Get changeset
      const changeset = params.details 
        ? await changesetService.getDetails(params.id)
        : await changesetService.get(params.id);
      
      if (!changeset) {
        const errorMsg = `Changeset not found: ${params.id}`;
        log.cliError(errorMsg);
        return { success: false, error: errorMsg };
      }
      
      if (params.json || ctx?.format === 'json') {
        return {
          success: true,
          data: changeset,
        };
      }
      
      // Human-readable output
      const statusIcon = changeset.status === 'open' ? '🟢' : 
                        changeset.status === 'merged' ? '🟣' : '🔴';
      
      log.cli(`\n${statusIcon} Changeset ${changeset.id} (${changeset.platform})`);
      log.cli(`${'━'.repeat(60)}`);
      log.cli(`Title: ${changeset.title}`);
      log.cli(`Author: ${changeset.author.username}`);
      log.cli(`Status: ${changeset.status}`);
      log.cli(`Target: ${changeset.targetBranch} ← ${changeset.sourceBranch || 'HEAD'}`);
      log.cli(`Created: ${changeset.createdAt.toLocaleDateString()}`);
      log.cli(`Updated: ${changeset.updatedAt.toLocaleDateString()}`);
      
      if (changeset.description) {
        log.cli(`\nDescription:\n${changeset.description}`);
      }
      
      if (changeset.commits.length > 0) {
        log.cli(`\nCommits (${changeset.commits.length}):`);
        changeset.commits.forEach(commit => {
          const shortSha = commit.sha.substring(0, 7);
          log.cli(`  ${shortSha} ${commit.message.split('\n')[0]}`);
        });
      }
      
      if (changeset.reviews.length > 0) {
        log.cli(`\nReviews (${changeset.reviews.length}):`);
        changeset.reviews.forEach(review => {
          const statusIcon = review.status === 'approved' ? '✅' :
                           review.status === 'changes_requested' ? '❌' : '⏳';
          log.cli(`  ${statusIcon} ${review.author.username}: ${review.status}`);
        });
      }
      
      // Show diff stats if available (for details mode)
      if ('diffStats' in changeset) {
        const details = changeset as import('../../../../domain/changeset/adapter-interface').ChangesetDetails;
        log.cli(`\nChanges: ${details.diffStats.filesChanged} files, +${details.diffStats.additions}/-${details.diffStats.deletions}`);
      }
      
      return { success: true };
      
    } catch (error) {
      const errorMsg = `Failed to get changeset: ${getErrorMessage(error)}`;
      log.cliError(errorMsg);
      return { success: false, error: errorMsg };
    }
  }
}

/**
 * Show changeset platform information and capabilities
 */
export class ChangesetInfoCommand extends BaseCommand {
  readonly id = 'changeset.info';
  readonly name = 'info';
  readonly description = 'Show changeset platform information and capabilities';
  
  readonly parameters = {
    repo: {
      type: 'string',
      description: 'Repository path or URL',
      required: false,
    },
    json: {
      type: 'boolean',
      description: 'Output in JSON format',
      required: false,
    },
  };
  
  async execute(params: { repo?: string; json?: boolean }, ctx?: CommandExecutionContext): Promise<any> {
    try {
      // Resolve repository
      const { repoUrl } = await resolveRepositoryAndBackend({
        repoParam: params.repo,
      });
      
      // Create changeset service
      const changesetService = await createChangesetService(repoUrl);
      const platform = await changesetService.getPlatform();
      
      // Check supported features
      const features: Array<{ feature: string; supported: boolean }> = [];
      const featuresToCheck = [
        'approval_workflow',
        'draft_changesets', 
        'file_comments',
        'suggested_changes',
        'auto_merge',
        'branch_protection',
        'status_checks',
        'assignee_management',
        'label_management',
        'milestone_tracking',
      ] as const;
      
      for (const feature of featuresToCheck) {
        const supported = await changesetService.supportsFeature(feature);
        features.push({ feature, supported });
      }
      
      if (params.json || ctx?.format === 'json') {
        return {
          success: true,
          data: {
            repository: repoUrl,
            platform,
            features: features.reduce((acc, f) => ({ ...acc, [f.feature]: f.supported }), {}),
          },
        };
      }
      
      // Human-readable output
      log.cli(`\n📊 Changeset Platform Information\n${'━'.repeat(60)}`);
      log.cli(`Repository: ${repoUrl}`);
      log.cli(`Platform: ${platform}`);
      log.cli(`\n🔧 Supported Features:`);
      
      for (const { feature, supported } of features) {
        const icon = supported ? '✅' : '❌';
        const displayName = feature.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
        log.cli(`  ${icon} ${displayName}`);
      }
      
      return { success: true };
      
    } catch (error) {
      const errorMsg = `Failed to get changeset info: ${getErrorMessage(error)}`;
      log.cliError(errorMsg);
      return { success: false, error: errorMsg };
    }
  }
}

/**
 * Available changeset commands
 */
export const changesetCommands = [
  new ChangesetListCommand(),
  new ChangesetSearchCommand(),
  new ChangesetGetCommand(),
  new ChangesetInfoCommand(),
];
