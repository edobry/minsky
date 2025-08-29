import { sharedCommandRegistry } from "./src/adapters/shared/command-registry";
import { registerAllSharedCommands } from "./src/adapters/shared/commands";
import { log } from "./src/utils/logger";

async function debugToolCategory() {
  try {
    log.cli("🔍 Debugging tool category issue...\n");

    // First register all commands
    log.cli("📝 Registering all commands...");
    await registerAllSharedCommands();

    log.cli(`📊 Total commands registered: ${sharedCommandRegistry.getAllCommands().length}`);

    // Get the tools command
    const tool = sharedCommandRegistry.getCommand("tools.index-embeddings");

    if (!tool) {
      log.cli("❌ Tool not found in registry");
      return;
    }

    log.cli("📋 Tool object properties:");
    log.cli(`   id: ${tool.id}`);
    log.cli(`   category: ${tool.category}`);
    log.cli(`   name: ${tool.name}`);
    log.cli(`   description: ${tool.description}`);
    log.cli(`   has parameters: ${!!tool.parameters}`);
    log.cli(`   has execute: ${typeof tool.execute}`);

    log.cli("\n🔍 Full tool object:");
    log.cli(
      JSON.stringify(
        tool,
        (key, value) => {
          if (typeof value === "function") return "[function]";
          return value;
        },
        2
      )
    );

    log.cli("\n🧪 Testing what ToolEmbeddingService tries to access:");
    log.cli(`   tool.category: ${tool.category}`);
    log.cli(`   tool.description: ${tool.description}`);
    log.cli(`   tool.name: ${tool.name}`);
    log.cli(`   tool.parameters keys: ${Object.keys(tool.parameters || {}).join(",")}`);
  } catch (error) {
    log.cliError("❌ Error in debug-tool-category");
  }
}

debugToolCategory();
