import { defineConfig } from "drizzle-kit";

export default defineConfig({
  out: "./src/domain/storage/migrations",
  schema: "./src/domain/storage/schemas/*.ts",
  dialect: "sqlite",
}); 
