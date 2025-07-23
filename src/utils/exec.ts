import { exec } from "child_process";
import { promisify } from "util";

const promisifiedExec = promisify(exec);

export const execAsync = promisifiedExec;
export const _execAsync = promisifiedExec; // Alias for backward compatibility
