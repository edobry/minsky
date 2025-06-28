#!/usr/bin/env bun

import { sessionPrFromParams } from "./src/domain/session.js";

async function testSessionPr() {
  try {
    console.log("Testing session pr...");
    
    const result = await sessionPrFromParams({
      title: "Add CLOSED task status for irrelevant tasks",
      body: "Implements CLOSED status for tasks that are no longer relevant but shouldn't be deleted.",
      task: "207",
      noStatusUpdate: false,
      debug: true,
      noUpdate: false,
    });
    
    console.log("Session PR result:", result);
  } catch (error) {
    console.error("Session PR error:", error);
  }
}

testSessionPr(); 
