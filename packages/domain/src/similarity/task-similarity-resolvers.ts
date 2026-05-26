import type { Task } from "../tasks";

export interface TaskSimilarityResolvers {
  getById(id: string): Promise<Task | null>;
  listCandidateIds(): Promise<string[]>;
  getContent(id: string): Promise<string>;
}
