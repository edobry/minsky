// FastMCP Internals Debug Script
import { FastMCP } from "fastmcp";
import { z } from "zod";

// Create a minimal FastMCP server for testing
const server = new FastMCP({
  name: "Test MCP Server",
  version: "1.0.0",
});

// Add a simple test tool without a namespace
server.addTool({
  name: "testMethod",
  description: "Test method without namespace",
  parameters: z.object({}),
  execute: async () => {
    return "Test method result";
  },
});

// Add a test tool with a namespace using dot notation
server.addTool({
  name: "test.dotMethod",
  description: "Test method with dot notation",
  parameters: z.object({}),
  execute: async () => {
    return "Dot method result";
  },
});

// Add a test tool with underscores instead of dots
server.addTool({
  name: "test_underscoreMethod",
  description: "Test method with underscore",
  parameters: z.object({}),
  execute: async () => {
    return "Underscore method result";
  },
});

// Log available internal properties
console.log(`\n==== FastMCP Internal Properties ====`);
for (const prop in server) {
  if (prop.startsWith("_")) {
    try {
      const description =
        typeof server[prop] === "function"
          ? "Function"
          : Array.isArray(server[prop])
            ? `Array (${server[prop].length} items)`
            : typeof server[prop] === "object" && server[prop] !== null
              ? `Object with keys: ${Object.keys(server[prop]).join(", ")}`
              : String(server[prop]);

      console.log(`Property: ${prop}, Type: ${description}`);
    } catch (e) {
      console.log(`Property: ${prop}, Type: [Error accessing property]`);
    }
  }
}

// Try to directly access and log the tools property
console.log(`\n==== FastMCP Tools Property ====`);
try {
  if ("_tools" in server) {
    const tools = server["_tools"];
    console.log(`Tools object type: ${typeof tools}`);
    if (tools && typeof tools === "object") {
      console.log(`Tool keys: ${Object.keys(tools).join(", ")}`);

      // Log details of each tool
      for (const key in tools) {
        console.log(`\nTool: ${key}`);
        const tool = tools[key];
        console.log(`- Original Name: ${tool.name || "undefined"}`);
        console.log(`- Description: ${tool.description || "undefined"}`);
      }
    } else {
      console.log("Tools object is not valid or is empty");
    }
  } else {
    console.log("No _tools property found on server instance");
  }
} catch (e) {
  console.log(`Error accessing _tools: ${e.message}`);
}

// Test starting the server to see if we can access additional properties
console.log(`\n==== Starting FastMCP Server ====`);
server.start({ transportType: "stdio" }).then(() => {
  console.log("Server started");

  // Check for new properties after server start
  console.log(`\n==== FastMCP Properties After Start ====`);
  for (const prop in server) {
    if (prop.startsWith("_")) {
      try {
        const description =
          typeof server[prop] === "function"
            ? "Function"
            : Array.isArray(server[prop])
              ? `Array (${server[prop].length} items)`
              : typeof server[prop] === "object" && server[prop] !== null
                ? `Object with keys: ${Object.keys(server[prop]).join(", ")}`
                : String(server[prop]);

        console.log(`Property: ${prop}, Type: ${description}`);
      } catch (e) {
        console.log(`Property: ${prop}, Type: [Error accessing property]`);
      }
    }
  }

  // Try to access the tools property again
  console.log(`\n==== FastMCP Tools Property After Start ====`);
  try {
    if ("_tools" in server) {
      const tools = server["_tools"];
      console.log(`Tools object type: ${typeof tools}`);
      if (tools && typeof tools === "object") {
        console.log(`Tool keys: ${Object.keys(tools).join(", ")}`);
      } else {
        console.log("Tools object is not valid or is empty");
      }
    } else {
      console.log("No _tools property found on server instance after start");
    }
  } catch (e) {
    console.log(`Error accessing _tools after start: ${e.message}`);
  }

  // Shut down after 2 seconds
  setTimeout(() => {
    console.log("\nShutting down test server");
    process.exit(0);
  }, 2000);
});
