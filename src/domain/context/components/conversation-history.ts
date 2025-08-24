import * as fs from "fs/promises";
import * as path from "path";
import { ContextComponent, ComponentInput, ComponentInputs, ComponentOutput } from "./types";

export interface ConversationHistoryInputs extends ComponentInputs {
  history: {
    entries: Array<{
      timestamp: string;
      role: "user" | "assistant" | "system";
      content: string;
      metadata?: {
        tools_used?: string[];
        context_components?: string[];
        task_id?: string;
        session_id?: string;
      };
    }>;
    totalMessages: number;
    timespan: {
      start: string;
      end: string;
      duration: string;
    };
    summary: {
      userQueries: number;
      assistantResponses: number;
      toolsUsed: string[];
      topicsDiscussed: string[];
    };
  };
  relevantEntries: Array<{
    timestamp: string;
    role: "user" | "assistant" | "system";
    content: string;
    relevanceScore: number;
    reason: string;
  }>;
}

/**
 * ConversationHistoryComponent - Hybrid Pattern
 *
 * Analyzes conversation history to provide relevant context for AI interactions.
 * Combines dynamic history discovery with template-based formatting.
 *
 * Features:
 * - Recent conversation history analysis
 * - Context-aware filtering based on user prompts
 * - Tool usage tracking and patterns
 * - Topic continuity detection
 * - Relevance scoring and summarization
 */
export const ConversationHistoryComponent: ContextComponent = {
  id: "conversation-history",
  name: "Conversation History",
  description:
    "Previous interactions, conversation context, and discussion continuity for AI assistance",

  async gatherInputs(context: ComponentInput): Promise<ConversationHistoryInputs> {
    const { userPrompt, task } = context;

    try {
      // In a real implementation, this would fetch from actual conversation storage
      // For now, we'll simulate conversation history discovery
      const history = await discoverConversationHistory(context);

      // Filter for relevant entries based on user prompt and current context
      const relevantEntries = await findRelevantHistoryEntries(history, userPrompt, task);

      return {
        history,
        relevantEntries,
      };
    } catch (error) {
      console.error("Error gathering conversation history inputs:", error);
      return {
        history: {
          entries: [],
          totalMessages: 0,
          timespan: { start: "", end: "", duration: "0" },
          summary: {
            userQueries: 0,
            assistantResponses: 0,
            toolsUsed: [],
            topicsDiscussed: [],
          },
        },
        relevantEntries: [],
      };
    }
  },

  render(inputs: ComponentInputs, context: ComponentInput): ComponentOutput {
    const { history, relevantEntries } = inputs as ConversationHistoryInputs;
    const { userPrompt } = context;

    const sections = ["## Conversation History"];

    // Overview section
    if (history.totalMessages > 0) {
      sections.push(
        "",
        "### Conversation Overview",
        `**Total Messages**: ${history.totalMessages}`,
        `**Duration**: ${history.timespan.duration}`,
        `**Period**: ${formatTimespan(history.timespan.start, history.timespan.end)}`,
        ""
      );

      // Conversation summary
      sections.push(
        "### Summary",
        `**User Queries**: ${history.summary.userQueries}`,
        `**Assistant Responses**: ${history.summary.assistantResponses}`,
        ""
      );

      if (history.summary.toolsUsed.length > 0) {
        sections.push(
          "**Tools Used**:",
          ...history.summary.toolsUsed.slice(0, 8).map((tool) => `- ${tool}`),
          ""
        );

        if (history.summary.toolsUsed.length > 8) {
          sections.push(`*... and ${history.summary.toolsUsed.length - 8} more tools*`, "");
        }
      }

      if (history.summary.topicsDiscussed.length > 0) {
        sections.push(
          "**Topics Discussed**:",
          ...history.summary.topicsDiscussed.slice(0, 6).map((topic) => `- ${topic}`),
          ""
        );
      }
    }

    // Relevant conversation entries
    if (relevantEntries.length > 0) {
      sections.push("### Relevant Previous Context");

      if (userPrompt) {
        sections.push(`*Entries relevant to "${userPrompt}":*`, "");
      }

      relevantEntries.slice(0, 5).forEach((entry, index) => {
        const timeAgo = getTimeAgo(entry.timestamp);
        sections.push(
          `#### ${entry.role === "user" ? "👤" : "🤖"} ${entry.role} (${timeAgo}${entry.relevanceScore ? ` - ${Math.round(entry.relevanceScore * 100)}% relevant` : ""})`,
          "",
          truncateContent(entry.content, 300),
          ""
        );

        if (entry.reason) {
          sections.push(`*Relevant because: ${entry.reason}*`, "");
        }
      });

      if (relevantEntries.length > 5) {
        sections.push(`*... and ${relevantEntries.length - 5} more relevant entries*`, "");
      }
    }

    // Context continuity insights
    if (history.totalMessages > 0) {
      const insights = generateContinuityInsights(history, relevantEntries, userPrompt);
      if (insights.length > 0) {
        sections.push("### Context Continuity", ...insights, "");
      }
    }

    // No history case
    if (history.totalMessages === 0) {
      sections.push(
        "",
        "### Status",
        "No conversation history available.",
        "This appears to be the start of a new conversation or session.",
        ""
      );
    }

    return {
      id: this.id,
      name: this.name,
      content: sections.join("\n"),
      metadata: {
        totalMessages: history.totalMessages,
        relevantEntries: relevantEntries.length,
        timespan: history.timespan.duration,
        toolsUsed: history.summary.toolsUsed.length,
        topicsCount: history.summary.topicsDiscussed.length,
      },
    };
  },

  // Legacy method for backwards compatibility
  async generate(input: ComponentInput): Promise<ComponentOutput> {
    const inputs = await this.gatherInputs(input);
    return this.render(inputs, input);
  },
};

async function discoverConversationHistory(
  context: ComponentInput
): Promise<ConversationHistoryInputs["history"]> {
  // In a real implementation, this would:
  // 1. Connect to conversation storage (database, files, etc.)
  // 2. Query recent conversation history
  // 3. Parse and structure the conversation data

  // For demonstration, we'll simulate a conversation history
  const simulatedHistory = generateSimulatedHistory(context);

  return simulatedHistory;
}

function generateSimulatedHistory(context: ComponentInput): ConversationHistoryInputs["history"] {
  const now = new Date();
  const startTime = new Date(now.getTime() - 2 * 60 * 60 * 1000); // 2 hours ago

  // Simulate conversation entries based on the current task context
  const entries: ConversationHistoryInputs["history"]["entries"] = [];

  // Add some realistic conversation entries
  entries.push({
    timestamp: new Date(startTime.getTime() + 0).toISOString(),
    role: "user",
    content:
      "md#082 @Start Task, first review the task spec to ensure its still relevant in light of architectural changes and work done since it was first authored, then present your analysis, recommendation, and next steps",
    metadata: {
      task_id: "md#082",
      session_id: "task-md#082",
    },
  });

  entries.push({
    timestamp: new Date(startTime.getTime() + 300000).toISOString(), // 5 minutes later
    role: "assistant",
    content: "I'll analyze the task specification for md#082 and assess its current relevance...",
    metadata: {
      tools_used: ["codebase_search", "read_file", "list_dir"],
      context_components: ["task-context", "project-context"],
      task_id: "md#082",
    },
  });

  entries.push({
    timestamp: new Date(startTime.getTime() + 900000).toISOString(), // 15 minutes later
    role: "user",
    content:
      "ok, update the task spec accordingly, commit/push, and then proceed with your plan in a new task session",
  });

  entries.push({
    timestamp: new Date(startTime.getTime() + 1200000).toISOString(), // 20 minutes later
    role: "assistant",
    content:
      "I'll update the task specification and create a new session. Let me implement the split-architecture context component system...",
    metadata: {
      tools_used: ["session_edit_file", "run_terminal_cmd", "session_start"],
      context_components: ["environment", "task-context", "workspace-rules"],
    },
  });

  entries.push({
    timestamp: new Date(startTime.getTime() + 3600000).toISOString(), // 1 hour later
    role: "user",
    content: "proceed",
  });

  entries.push({
    timestamp: new Date(startTime.getTime() + 3900000).toISOString(), // 1 hour 5 minutes later
    role: "assistant",
    content:
      "Implementing the FileContentComponent for dynamic file reading with relevance scoring...",
    metadata: {
      tools_used: ["session_write_file", "session_edit_file"],
      context_components: ["file-content", "dependency-context"],
    },
  });

  // Calculate summary statistics
  const userQueries = entries.filter((e) => e.role === "user").length;
  const assistantResponses = entries.filter((e) => e.role === "assistant").length;

  const allToolsUsed = entries
    .flatMap((e) => e.metadata?.tools_used || [])
    .filter((tool, index, arr) => arr.indexOf(tool) === index);

  const topicsDiscussed = [
    "Context Management Commands",
    "Split Architecture Components",
    "Task Specification Updates",
    "Component Implementation",
    "File Content Analysis",
    "Testing Framework Integration",
  ];

  return {
    entries,
    totalMessages: entries.length,
    timespan: {
      start: startTime.toISOString(),
      end: now.toISOString(),
      duration: formatDuration(now.getTime() - startTime.getTime()),
    },
    summary: {
      userQueries,
      assistantResponses,
      toolsUsed: allToolsUsed,
      topicsDiscussed,
    },
  };
}

async function findRelevantHistoryEntries(
  history: ConversationHistoryInputs["history"],
  userPrompt?: string,
  task?: any
): Promise<ConversationHistoryInputs["relevantEntries"]> {
  const relevantEntries: ConversationHistoryInputs["relevantEntries"] = [];

  for (const entry of history.entries) {
    const relevance = calculateRelevanceScore(entry, userPrompt, task);

    if (relevance.score > 0.3) {
      // Only include entries with >30% relevance
      relevantEntries.push({
        timestamp: entry.timestamp,
        role: entry.role,
        content: entry.content,
        relevanceScore: relevance.score,
        reason: relevance.reason,
      });
    }
  }

  // Sort by relevance score (highest first)
  relevantEntries.sort((a, b) => b.relevanceScore - a.relevanceScore);

  return relevantEntries.slice(0, 10); // Return top 10 most relevant
}

function calculateRelevanceScore(
  entry: ConversationHistoryInputs["history"]["entries"][0],
  userPrompt?: string,
  task?: any
): { score: number; reason: string } {
  let score = 0;
  const reasons: string[] = [];

  // Base relevance for recent entries
  const entryTime = new Date(entry.timestamp).getTime();
  const now = Date.now();
  const ageHours = (now - entryTime) / (1000 * 60 * 60);

  if (ageHours < 1) {
    score += 0.3;
    reasons.push("recent conversation");
  } else if (ageHours < 4) {
    score += 0.2;
    reasons.push("relatively recent");
  }

  // Relevance based on user prompt
  if (userPrompt) {
    const promptLower = userPrompt.toLowerCase();
    const contentLower = entry.content.toLowerCase();

    if (contentLower.includes(promptLower)) {
      score += 0.5;
      reasons.push(`mentions "${userPrompt}"`);
    }

    // Check for related keywords
    const keywords = promptLower.split(/\s+/).filter((w) => w.length > 3);
    const matchingKeywords = keywords.filter((keyword) => contentLower.includes(keyword));

    if (matchingKeywords.length > 0) {
      score += 0.2 * (matchingKeywords.length / keywords.length);
      reasons.push(`related to ${matchingKeywords.join(", ")}`);
    }
  }

  // Relevance based on task context
  if (task?.id && entry.metadata?.task_id === task.id) {
    score += 0.4;
    reasons.push("same task context");
  }

  // Tool usage relevance
  if (entry.metadata?.tools_used?.length) {
    score += 0.1;
    reasons.push("tool usage context");
  }

  // Context components relevance
  if (entry.metadata?.context_components?.length) {
    score += 0.1;
    reasons.push("context component usage");
  }

  return {
    score: Math.min(1.0, score),
    reason: reasons.join(", ") || "general context",
  };
}

function formatTimespan(start: string, end: string): string {
  if (!start || !end) return "unknown";

  const startDate = new Date(start);
  const endDate = new Date(end);

  const startStr = startDate.toLocaleString();
  const endStr = endDate.toLocaleString();

  return `${startStr} → ${endStr}`;
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  } else {
    return `${seconds}s`;
  }
}

function getTimeAgo(timestamp: string): string {
  const now = Date.now();
  const time = new Date(timestamp).getTime();
  const diffMs = now - time;

  const diffSeconds = Math.floor(diffMs / 1000);
  const diffMinutes = Math.floor(diffSeconds / 60);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffDays > 0) return `${diffDays}d ago`;
  if (diffHours > 0) return `${diffHours}h ago`;
  if (diffMinutes > 0) return `${diffMinutes}m ago`;
  return `${diffSeconds}s ago`;
}

function truncateContent(content: string, maxLength: number): string {
  if (content.length <= maxLength) {
    return content;
  }

  return `${content.substring(0, maxLength - 3)}...`;
}

function generateContinuityInsights(
  history: ConversationHistoryInputs["history"],
  relevantEntries: ConversationHistoryInputs["relevantEntries"],
  userPrompt?: string
): string[] {
  const insights: string[] = [];

  // Analyze conversation patterns
  if (history.summary.userQueries > 3) {
    insights.push("📈 **Active Discussion**: Multiple user queries indicate ongoing collaboration");
  }

  if (history.summary.toolsUsed.length > 5) {
    insights.push(
      `🔧 **Tool-Rich Session**: ${history.summary.toolsUsed.length} different tools used`
    );
  }

  if (relevantEntries.length > 0) {
    const avgRelevance =
      relevantEntries.reduce((sum, e) => sum + e.relevanceScore, 0) / relevantEntries.length;
    insights.push(
      `🎯 **Context Relevance**: ${Math.round(avgRelevance * 100)}% average relevance to current query`
    );
  }

  // Topic continuity
  if (
    userPrompt &&
    history.summary.topicsDiscussed.some(
      (topic) =>
        topic.toLowerCase().includes(userPrompt.toLowerCase()) ||
        userPrompt.toLowerCase().includes(topic.toLowerCase())
    )
  ) {
    insights.push("🔗 **Topic Continuity**: Current query relates to previous discussion topics");
  }

  return insights;
}

export function createConversationHistoryComponent(): ContextComponent {
  return ConversationHistoryComponent;
}
