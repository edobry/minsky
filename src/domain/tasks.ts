import { promises as fs } from 'fs';
import { join } from 'path';
import { parse as parsePath } from 'path';
import { SessionDB } from './session';
import { exec } from 'child_process';
import { promisify } from 'util';
const execAsync = promisify(exec);

export interface Task {
  id: string;
  title: string;
  description: string;
  status: string;
}

export interface TaskBackend {
  name: string;
  listTasks(options?: TaskListOptions): Promise<Task[]>;
  getTask(id: string): Promise<Task | null>;
  getTaskStatus(id: string): Promise<string | null>;
  setTaskStatus(id: string, status: string): Promise<void>;
}

export interface TaskListOptions {
  status?: string;
}

// Task status constants and checkbox mapping
export const TASK_STATUS = {
  TODO: 'TODO',
  DONE: 'DONE',
  IN_PROGRESS: 'IN-PROGRESS',
  IN_REVIEW: 'IN-REVIEW',
} as const;

export type TaskStatus = typeof TASK_STATUS[keyof typeof TASK_STATUS];

export const TASK_STATUS_CHECKBOX: Record<string, string> = {
  [TASK_STATUS.TODO]: ' ',
  [TASK_STATUS.DONE]: 'x',
  [TASK_STATUS.IN_PROGRESS]: '-',
  [TASK_STATUS.IN_REVIEW]: '+',
};

export const CHECKBOX_TO_STATUS: Record<string, TaskStatus> = {
  ' ': TASK_STATUS.TODO,
  'x': TASK_STATUS.DONE,
  '-': TASK_STATUS.IN_PROGRESS,
  '+': TASK_STATUS.IN_REVIEW,
};

export class MarkdownTaskBackend implements TaskBackend {
  name = 'markdown';
  private filePath: string;
  
  constructor(repoPath: string) {
    this.filePath = join(repoPath, 'process', 'tasks.md');
  }
  
  async listTasks(options?: TaskListOptions): Promise<Task[]> {
    const tasks = await this.parseTasks();
    
    if (options?.status) {
      return tasks.filter(task => task.status === options.status);
    }
    
    return tasks;
  }
  
  async getTask(id: string): Promise<Task | null> {
    const tasks = await this.parseTasks();
    return tasks.find(task => task.id === id) || null;
  }
  
  async getTaskStatus(id: string): Promise<string | null> {
    const task = await this.getTask(id);
    return task ? task.status : null;
  }
  
  async setTaskStatus(id: string, status: string): Promise<void> {
    if (!Object.values(TASK_STATUS).includes(status as TaskStatus)) {
      throw new Error(`Status must be one of: ${Object.values(TASK_STATUS).join(', ')}`);
    }
    const content = await fs.readFile(this.filePath, 'utf-8');
    const idNum = id.startsWith('#') ? id.slice(1) : id;
    const newStatusChar = TASK_STATUS_CHECKBOX[status];
    const lines = content.split('\n');
    let inCodeBlock = false;
    const updatedLines = lines.map(line => {
      if (line.trim().startsWith('```')) {
        inCodeBlock = !inCodeBlock;
        return line;
      }
      if (inCodeBlock) return line;
      if (line.includes(`[#${idNum}]`)) {
        // Replace only the first checkbox in the line
        return line.replace(/^(\s*- \[)( |x|\-|\+)(\])/, `$1${newStatusChar}$3`);
      }
      return line;
    });
    await fs.writeFile(this.filePath, updatedLines.join('\n'), 'utf-8');
  }
  
  private async parseTasks(): Promise<Task[]> {
    try {
      const content = await fs.readFile(this.filePath, 'utf-8');
      // Split into lines and track code block state
      const lines = content.split('\n');
      const tasks: Task[] = [];
      let inCodeBlock = false;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';
        if (line.trim().startsWith('```')) {
          inCodeBlock = !inCodeBlock;
          continue;
        }
        if (inCodeBlock) continue;
        // Match top-level tasks: - [ ] Title [#123](...)
        const match = /^- \[( |x|\-|\+)\] (.+?) \[#(\d+)\]\([^)]+\)/.exec(line);
        if (!match) continue;
        const checkbox = match[1];
        const title = match[2]?.trim() ?? '';
        const id = `#${match[3] ?? ''}`;
        if (!title || !id || !/^#\d+$/.test(id)) continue; // skip malformed or empty
        const status = CHECKBOX_TO_STATUS[checkbox as keyof typeof CHECKBOX_TO_STATUS] || TASK_STATUS.TODO;
        // Aggregate indented lines as description
        let description = '';
        for (let j = i + 1; j < lines.length; j++) {
          const subline = lines[j] ?? '';
          if (subline.trim().startsWith('```')) break;
          if (/^- \[.\]/.test(subline)) break; // next top-level task
          if (/^\s+- /.test(subline)) {
            description += (subline.trim().replace(/^- /, '') ?? '') + '\n';
          } else if ((subline.trim() ?? '') === '') {
            continue;
          } else {
            break;
          }
        }
        tasks.push({ id, title, status, description: description.trim() });
      }
      return tasks;
    } catch (error) {
      console.error('Error reading tasks file:', error);
      return [];
    }
  }
}

export class GitHubTaskBackend implements TaskBackend {
  name = 'github';
  
  constructor(repoPath: string) {
    // Would initialize GitHub API client here
  }
  
  async listTasks(options?: TaskListOptions): Promise<Task[]> {
    // Placeholder for GitHub API integration
    console.log('GitHub task backend not fully implemented');
    return [];
  }
  
  async getTask(id: string): Promise<Task | null> {
    // Placeholder for GitHub API integration
    console.log('GitHub task backend not fully implemented');
    return null;
  }
  
  async getTaskStatus(id: string): Promise<string | null> {
    // Placeholder for GitHub API integration
    console.log('GitHub task backend not fully implemented');
    return null;
  }
  
  async setTaskStatus(id: string, status: string): Promise<void> {
    // Placeholder for GitHub API integration
    console.log('GitHub task backend not fully implemented');
  }
}

export interface TaskServiceOptions {
  repoPath: string;
  backend?: string;
}

export class TaskService {
  private backends: TaskBackend[] = [];
  private currentBackend: TaskBackend;
  
  constructor(options: TaskServiceOptions) {
    // Initialize backends
    this.backends.push(new MarkdownTaskBackend(options.repoPath));
    this.backends.push(new GitHubTaskBackend(options.repoPath));
    
    // Set default backend
    const requestedBackend = options.backend || 'markdown';
    const backend = this.backends.find(b => b.name === requestedBackend);
    
    if (!backend) {
      throw new Error(`Task backend '${requestedBackend}' not found`);
    }
    
    this.currentBackend = backend;
  }
  
  async listTasks(options?: TaskListOptions): Promise<Task[]> {
    return this.currentBackend.listTasks(options);
  }
  
  async getTask(id: string): Promise<Task | null> {
    return this.currentBackend.getTask(id);
  }
  
  async getTaskStatus(id: string): Promise<string | null> {
    return this.currentBackend.getTaskStatus(id);
  }
  
  async setTaskStatus(id: string, status: string): Promise<void> {
    return this.currentBackend.setTaskStatus(id, status);
  }
} 
