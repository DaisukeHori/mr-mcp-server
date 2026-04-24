import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { Request, Response } from "express";
import { execSync } from "child_process";
import { createHmac, timingSafeEqual } from "crypto";
import { MrClient } from "./services/mr-client.js";
import { registerRunnerTools } from "./tools/runner-tools.js";

const PORT = parseInt(process.env.PORT || "4000", 10);
const ADMIN_KEY = process.env.ADMIN_KEY || "";
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";
const MR_DIR = process.env.MR_DIR || "/opt/multi-runners";
const DEFAULT_OWNER = process.env.DEFAULT_OWNER || "";

if (!ADMIN_KEY) {
  console.error("ERROR: ADMIN_KEY environment variable is required.");
  process.exit(1);
}

// Singleton
const mrClient = new MrClient(MR_DIR, DEFAULT_OWNER);

const app = express();

// Capture raw body for webhook HMAC verification, then parse JSON
app.use(express.json({
  verify: (req: Request, _res, buf) => {
    (req as Request & { rawBody?: Buffer }).rawBody = buf;
  },
}));

// ─────────────────────────────────────────────
// Health endpoint (no auth)
// ─────────────────────────────────────────────
app.get("/health", async (_req: Request, res: Response) => {
  try {
    const stats = await mrClient.healthCheck();
    res.json({
      status: "ok",
      uptimeSeconds: Math.round(process.uptime()),
      ...stats,
    });
  } catch (err) {
    res.status(500).json({ status: "error", message: (err as Error).message });
  }
});

// ─────────────────────────────────────────────
// MCP endpoint
// ─────────────────────────────────────────────
app.post("/mcp", async (req: Request, res: Response) => {
  const keyParam = req.query.key as string | undefined;
  if (!keyParam) {
    res.status(401).json({ error: "Missing ?key= parameter" });
    return;
  }

  // API key verification (single admin key only — simpler than ssh-mcp)
  try {
    const provided = Buffer.from(keyParam);
    const expected = Buffer.from(ADMIN_KEY);
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      res.status(403).json({ error: "Invalid key" });
      return;
    }
  } catch {
    res.status(403).json({ error: "Invalid key" });
    return;
  }

  try {
    const server = new McpServer({ name: "mr-mcp-server", version: "1.0.0" });
    registerRunnerTools(server, mrClient);

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => transport.close());
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("[MCP] Error:", error);
    if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/mcp", (_req, res) => res.status(405).json({ error: "Use POST" }));
app.delete("/mcp", (_req, res) => res.status(405).json({ error: "Use POST" }));

// ─────────────────────────────────────────────
// GitHub Webhook → auto-deploy on push
// ─────────────────────────────────────────────
app.post("/webhook/github", (req: Request, res: Response) => {
  if (WEBHOOK_SECRET) {
    const sig = req.headers["x-hub-signature-256"] as string | undefined;
    if (!sig) { res.status(401).json({ error: "Missing signature" }); return; }

    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
    if (!rawBody) { res.status(400).json({ error: "No body" }); return; }

    const expected = "sha256=" + createHmac("sha256", WEBHOOK_SECRET).update(rawBody).digest("hex");

    try {
      if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
        res.status(403).json({ error: "Invalid signature" }); return;
      }
    } catch {
      res.status(403).json({ error: "Invalid signature" }); return;
    }
  }

  const event = req.headers["x-github-event"];
  if (event !== "push") {
    res.json({ skipped: true, reason: `event=${event}, only push triggers deploy` });
    return;
  }

  console.error("[Webhook] Push received, starting auto-deploy...");
  res.json({ accepted: true, message: "Deploy started. Server will restart." });

  setTimeout(() => {
    try {
      const cwd = "/opt/mr-mcp-server";
      console.error("[Webhook] git pull...");
      execSync("git pull", { cwd, stdio: "inherit", timeout: 30000 });
      console.error("[Webhook] npm install...");
      execSync("npm install", { cwd, stdio: "inherit", timeout: 120000 });
      console.error("[Webhook] tsc build...");
      execSync("npx tsc", { cwd, stdio: "inherit", timeout: 30000 });
      console.error("[Webhook] Deploy complete. Restarting...");
      process.exit(0); // systemd will restart
    } catch (err) {
      console.error("[Webhook] Deploy FAILED:", err);
    }
  }, 500);
});

app.listen(PORT, "0.0.0.0", () => {
  console.error(`
╔═══════════════════════════════════════════════════╗
║         mr-mcp-server v1.0.0                      ║
║───────────────────────────────────────────────────║
║  Endpoint:   http://0.0.0.0:${PORT}/mcp?key=...        ║
║  Health:     http://0.0.0.0:${PORT}/health             ║
║  MR_DIR:     ${MR_DIR}
║  Default owner: ${DEFAULT_OWNER || "(not set)"}
╚═══════════════════════════════════════════════════╝
  `);
});

process.on("SIGTERM", () => { process.exit(0); });
process.on("SIGINT", () => { process.exit(0); });
