import { type ContextComponent, type ComponentInput, type ComponentOutput, type ComponentInputs } from "./types";

interface EnvironmentInputs {
  osVersion: string;
  shell: string;
  workspacePath: string;
  nodeVersion: string;
}

export const EnvironmentComponent: ContextComponent = {
  id: "environment",
  name: "Environment Setup",
  description: "System environment and workspace information",

  // Phase 1: Async input gathering (component-specific data collection)
  async gatherInputs(context: ComponentInput): Promise<ComponentInputs> {
    const osVersion = context.environment?.os || `${process.platform} ${process.arch}`;
    const shell = context.environment?.shell || process.env.SHELL || "unknown";
    const workspacePath = context.workspacePath || process.cwd();
    const nodeVersion = process.version;

    return {
      osVersion,
      shell,
      workspacePath,
      nodeVersion,
    } as EnvironmentInputs;
  },

  // Phase 2: Pure rendering using template-style approach
  render(inputs: ComponentInputs, context: ComponentInput): ComponentOutput {
    const envInputs = inputs as EnvironmentInputs;
    
    // Using template literal approach (could be enhanced with full template system later)
    const content = `## Environment Setup

OS Version: ${envInputs.osVersion}
Shell: ${envInputs.shell}
Workspace Path: ${envInputs.workspacePath}
Node Version: ${envInputs.nodeVersion}
Note: Context generated for AI collaboration in Minsky environment.`;

    return {
      content,
      metadata: { 
        componentId: this.id, 
        generatedAt: new Date().toISOString() 
      },
    };
  },

  // Legacy method for backwards compatibility (delegates to new split architecture)
  async generate(input: ComponentInput): Promise<ComponentOutput> {
    const gatheredInputs = await this.gatherInputs(input);
    return this.render(gatheredInputs, input);
  },
};

export function createEnvironmentComponent(): ContextComponent { 
  return EnvironmentComponent; 
}