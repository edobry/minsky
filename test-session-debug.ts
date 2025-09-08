#!/usr/bin/env bun
import { createSessionProvider } from "./src/domain/session/session-db-adapter";

async function testSessionProvider() {
  console.log("Testing session provider creation...");

  try {
    const sessionProvider = await createSessionProvider();
    console.log("Session provider created:", typeof sessionProvider);
    console.log(
      "Available methods:",
      Object.getOwnPropertyNames(sessionProvider).filter(
        (prop) => typeof sessionProvider[prop] === "function"
      )
    );
    console.log("Has getSession?", typeof sessionProvider.getSession === "function");

    if (typeof sessionProvider.getSession === "function") {
      console.log("Attempting to call getSession...");
      const result = await sessionProvider.getSession("test-session");
      console.log("getSession result:", result);
    }
  } catch (error) {
    console.error("Error:", error);
  }
}

testSessionProvider();
