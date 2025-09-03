import { initializeConfiguration, CustomConfigFactory } from "./src/domain/configuration/index";
import { PersistenceService } from "./src/domain/persistence/service";

async function testPersistence() {
  try {
    console.log("=== Testing Persistence Configuration ===");

    // Test config
    const testConfig = {
      persistence: {
        backend: "postgres" as const,
        postgres: {
          connectionString: "postgresql://localhost:5432/testdb",
        },
      },
      sessiondb: {
        backend: "postgres" as const,
        connectionString: "postgresql://localhost:5432/testdb",
      },
    };

    console.log("1. Initializing configuration...");
    const factory = new CustomConfigFactory();
    await initializeConfiguration(factory, {
      overrides: testConfig,
      enableCache: true,
      skipValidation: true,
    });

    console.log("2. Initializing PersistenceService...");
    await PersistenceService.initialize();

    console.log("3. Getting provider...");
    const provider = PersistenceService.getProvider();
    console.log("Provider type:", provider.constructor.name);
    console.log("Provider capabilities:", provider.capabilities);
    console.log("Provider connection info:", provider.getConnectionInfo());

    console.log("4. Checking getDatabaseConnection method...");
    console.log("Has getDatabaseConnection:", typeof provider.getDatabaseConnection);

    if (provider.getDatabaseConnection) {
      console.log("5. Attempting to get database connection...");
      try {
        const connection = await provider.getDatabaseConnection();
        console.log("Connection:", connection ? "Available" : "Null");
      } catch (err) {
        console.log("Connection error:", err);
      }
    } else {
      console.log("5. No getDatabaseConnection method available");
    }
  } catch (error) {
    console.error("Error:", error);
  }
}

testPersistence();
