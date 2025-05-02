declare module "../../domain/session" {
  export interface SessionDB {
    name: string;
    taskId: string;
    repoPath: string;
    repoUrl?: string;
    branch?: string;
    createdAt: Date;
    updatedAt: Date;
  }

  export interface SessionRecord {
    session: string;
    repoUrl: string;
    repoName: string;
    taskId: string;
    repoPath: string;
    createdAt: string;
  }
} 
