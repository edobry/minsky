/**
 * Cockpit embeddings-infrastructure routes (mt#2615 — extracted from
 * server.ts, mt#2151).
 *
 *   GET  /api/embeddings/overview
 *   GET  /api/embeddings/errors
 *   POST /api/embeddings/reindex/:consumer
 */
import type express from "express";
import fs from "fs";
import path from "path";
import { log } from "@minsky/shared/logger";
import { getContextInspectorDb } from "../db-providers";

/** Mount the /api/embeddings/* routes on `app`. */
export function mountEmbeddingsRoutes(app: express.Express): void {
  app.get("/api/embeddings/overview", async (_req, res) => {
    try {
      const db = await getContextInspectorDb();
      if (db === null) {
        const { EmbeddingsHealthTracker } = await import(
          "@minsky/domain/ai/embeddings-health-tracker"
        );
        res.json({
          health: EmbeddingsHealthTracker.getInstance().getSummary(),
          consumers: [],
        });
        return;
      }
      const { getEmbeddingsOverview } = await import("../embeddings-api");
      const overview = await getEmbeddingsOverview(db);
      res.json(overview);
    } catch (err) {
      log.error("[embeddings] GET /api/embeddings/overview error", {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ error: "Failed to fetch embeddings overview" });
    }
  });

  app.get("/api/embeddings/errors", async (req, res) => {
    try {
      const db = await getContextInspectorDb();
      if (db === null) {
        res.json({ errors: [] });
        return;
      }
      const parsed = parseInt(String(req.query["limit"] ?? "50"), 10);
      const limit = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 200) : 50;
      const { getEmbeddingsErrors } = await import("../embeddings-api");
      const errors = await getEmbeddingsErrors(db, limit);
      res.json({ errors });
    } catch (err) {
      log.error("[embeddings] GET /api/embeddings/errors error", {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ error: "Failed to fetch embeddings errors" });
    }
  });

  app.post("/api/embeddings/reindex/:consumer", async (req, res) => {
    try {
      const { consumer } = req.params;
      const { REINDEX_COMMANDS } = await import("../embeddings-api");
      const cmd = REINDEX_COMMANDS[consumer];
      if (!cmd) {
        res.status(400).json({
          error: `Unknown or non-reindexable consumer: ${consumer}`,
          available: Object.keys(REINDEX_COMMANDS),
        });
        return;
      }

      const cliEntry = path.join(process.cwd(), "src", "cli.ts");
      if (!fs.existsSync(cliEntry)) {
        res.status(503).json({
          error: "Reindex unavailable: source tree not found at expected location",
        });
        return;
      }

      const { spawn: spawnChild, execFileSync } = await import("child_process");
      try {
        execFileSync("bun", ["--version"], { timeout: 5000, stdio: "ignore" });
      } catch {
        res.status(503).json({ error: "Reindex unavailable: bun runtime not found" });
        return;
      }

      const args = cmd.split(" ");
      const child = spawnChild("bun", [cliEntry, ...args], {
        cwd: process.cwd(),
        detached: true,
        stdio: "ignore",
      });

      await new Promise<void>((resolve, reject) => {
        child.on("spawn", () => resolve());
        child.on("error", (err) => reject(err));
      });
      child.unref();

      res.json({ success: true, message: `Reindex started for ${consumer}` });
    } catch (err) {
      log.error("[embeddings] POST /api/embeddings/reindex error", {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ error: "Failed to start reindex" });
    }
  });
}
