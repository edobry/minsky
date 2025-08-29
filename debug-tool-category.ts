import { sharedCommandRegistry } from "./src/adapters/shared/command-registry";
import { registerAllSharedCommands } from "./src/adapters/shared/commands";

async function debugToolCategory() {
  try {
    console.log("🔍 Debugging tool category issue...\n");

    // First register all commands
    console.log("📝 Registering all commands...");
    await registerAllSharedCommands();

    console.log("📊 Total commands registered:", sharedCommandRegistry.getAllCommands().length);

    // Get the tools command
    const tool = sharedCommandRegistry.getCommand('tools.index-embeddings');

    if (!tool) {
      console.log("❌ Tool not found in registry");
      return;
    }

    console.log("📋 Tool object properties:");
    console.log("   id:", tool.id);
    console.log("   category:", tool.category);
    console.log("   name:", tool.name);
    console.log("   description:", tool.description);
    console.log("   has parameters:", !!tool.parameters);
    console.log("   has execute:", typeof tool.execute);

    console.log("\n🔍 Full tool object:");
    console.log(JSON.stringify(tool, (key, value) => {
      if (typeof value === 'function') return '[function]';
      return value;
    }, 2));

    console.log("\n🧪 Testing what ToolEmbeddingService tries to access:");
    console.log("   tool.category:", tool.category);
    console.log("   tool.description:", tool.description);
    console.log("   tool.name:", tool.name);
    console.log("   tool.parameters keys:", Object.keys(tool.parameters || {}));

  } catch (error) {
    console.error("❌ Error:", error);
  }
}

debugToolCategory();
