import type { SimilarityBackend, SimilarityItem, SimilarityQuery } from "../../similarity/types";
import { sharedCommandRegistry } from "../../../adapters/shared/command-registry";
import { createLogger } from "../../../utils/logger";

const log = createLogger("tool-keyword-backend");

/**
 * ToolKeywordBackend: Keyword-based tool matching fallback
 * 
 * Provides intelligent keyword matching for tools when embeddings
 * are unavailable or produce poor results.
 */
export class ToolKeywordBackend implements SimilarityBackend {
  readonly name = "tool-keywords";

  async isAvailable(): Promise<boolean> {
    return true; // Always available as fallback
  }

  async search(query: SimilarityQuery): Promise<SimilarityItem[]> {
    const queryText = query.queryText?.toLowerCase() || "";
    const limit = query.limit || 20;

    if (!queryText.trim()) {
      return [];
    }

    // Get all tools from registry
    const allTools = sharedCommandRegistry.getAllCommands();
    const scoredTools: Array<{ id: string; score: number; metadata?: any }> = [];

    // Extract keywords from query
    const keywords = this.extractKeywords(queryText);
    const intentKeywords = this.extractIntentKeywords(queryText);

    for (const tool of allTools) {
      const score = this.calculateToolScore(tool, keywords, intentKeywords, queryText);
      
      if (score > 0) {
        scoredTools.push({
          id: tool.id,
          score,
          metadata: {
            category: tool.category,
            name: tool.name,
            description: tool.description,
          },
        });
      }
    }

    // Sort by score descending and limit results
    scoredTools.sort((a, b) => b.score - a.score);
    const results = scoredTools.slice(0, limit);

    log.debug(`Keyword search for "${queryText}" found ${results.length} tools`);
    return results;
  }

  /**
   * Extract keywords from query text
   */
  private extractKeywords(queryText: string): string[] {
    // Remove common stop words and extract meaningful keywords
    const stopWords = new Set([
      "a", "an", "and", "are", "as", "at", "be", "by", "for", 
      "from", "has", "he", "in", "is", "it", "its", "of", "on", 
      "that", "the", "to", "was", "will", "with", "me", "help",
      "i", "can", "how", "what", "where", "when", "why", "do"
    ]);

    return queryText
      .split(/\s+/)
      .map(word => word.replace(/[^\w]/g, ''))
      .filter(word => word.length > 2 && !stopWords.has(word))
      .map(word => word.toLowerCase());
  }

  /**
   * Extract intent-based keywords that map to tool categories
   */
  private extractIntentKeywords(queryText: string): Record<string, string[]> {
    const intentMap = {
      // Task management related
      'tasks': ['task', 'todo', 'work', 'project', 'issue', 'ticket', 'manage', 'list', 'create', 'update'],
      
      // Git/version control related  
      'git': ['git', 'commit', 'branch', 'merge', 'pull', 'push', 'repo', 'repository', 'version', 'control'],
      
      // Debug/troubleshooting related
      'debug': ['debug', 'fix', 'error', 'bug', 'issue', 'problem', 'troubleshoot', 'investigate', 'analyze'],
      
      // Session management related
      'session': ['session', 'workspace', 'context', 'environment', 'setup', 'init', 'start', 'switch'],
      
      // Configuration related
      'config': ['config', 'configure', 'setting', 'option', 'preference', 'setup', 'parameter'],
      
      // Rules related
      'rules': ['rule', 'policy', 'guideline', 'standard', 'practice', 'convention'],
      
      // AI/embedding related
      'ai': ['ai', 'embedding', 'similarity', 'search', 'semantic', 'intelligent', 'smart'],
      
      // Database related
      'sessiondb': ['database', 'db', 'data', 'store', 'persist', 'save', 'query', 'record'],
      
      // Testing related
      'test': ['test', 'testing', 'spec', 'verify', 'validate', 'check', 'assert'],
      
      // Code review related
      'review': ['review', 'diff', 'compare', 'examine', 'inspect', 'audit'],
      
      // Implementation related
      'implement': ['implement', 'code', 'develop', 'build', 'create', 'write', 'program'],
      
      // Deployment related
      'deploy': ['deploy', 'deployment', 'release', 'publish', 'launch', 'ship']
    };

    const detected: Record<string, string[]> = {};
    const words = queryText.toLowerCase().split(/\s+/);

    for (const [category, keywords] of Object.entries(intentMap)) {
      const matches = keywords.filter(keyword => 
        words.some(word => word.includes(keyword) || keyword.includes(word))
      );
      
      if (matches.length > 0) {
        detected[category] = matches;
      }
    }

    return detected;
  }

  /**
   * Calculate relevance score for a tool based on keywords and intent
   */
  private calculateToolScore(
    tool: any,
    keywords: string[],
    intentKeywords: Record<string, string[]>,
    originalQuery: string
  ): number {
    let score = 0;

    // Combine tool text for matching
    const toolText = [
      tool.name,
      tool.description,
      tool.category.toLowerCase(),
      ...Object.keys(tool.parameters || {})
    ].join(" ").toLowerCase();

    // Score based on direct keyword matches
    for (const keyword of keywords) {
      if (toolText.includes(keyword)) {
        score += 0.3; // Base keyword match
        
        // Boost if keyword appears in name
        if (tool.name.toLowerCase().includes(keyword)) {
          score += 0.4;
        }
        
        // Boost if keyword appears in description
        if (tool.description.toLowerCase().includes(keyword)) {
          score += 0.2;
        }
      }
    }

    // Score based on intent keywords (category matching)
    for (const [category, matches] of Object.entries(intentKeywords)) {
      if (tool.category.toLowerCase().includes(category) || 
          category.includes(tool.category.toLowerCase())) {
        score += 0.5 * matches.length; // Strong category match
      }
    }

    // Boost for exact command name matches
    if (tool.name.toLowerCase() === originalQuery.toLowerCase()) {
      score += 1.0;
    }

    // Normalize score to 0-1 range
    return Math.min(score, 1.0);
  }
}
