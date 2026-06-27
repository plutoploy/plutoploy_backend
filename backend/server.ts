import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { deployRoutes } from "./src/routes/deploy.routes";
import { authRoutes } from "./src/routes/auth.routes";
import { githubRoutes } from "./src/routes/github.routes";
import { webhookRoutes } from "./src/routes/webhook.routes";

const app = new Hono();

// Enable CORS
app.use("/*", cors());

// Health check endpoints
app.get("/", (c) => {
  return c.json({
    message: "Deployment Platform API",
    status: "running",
    version: "1.0.0"
  });
});

app.get("/health", (c) => {
  return c.json({ status: "healthy" });
});

// Test POST endpoint
app.post("/test", async (c) => {
  const body = await c.req.json();
  return c.json({ received: body, success: true });
});

// Mount auth routes (GitHub App OAuth)
app.route('/api/auth', authRoutes);

// Mount GitHub App routes (repos, etc.)
app.route('/api', githubRoutes);

// Mount GitHub Webhook routes
app.route('/api/webhooks', webhookRoutes);

// Mount deployment routes
app.route('/api', deployRoutes);

const port = parseInt(process.env.PORT || '3000');

export function startServer() {
  console.log('Initializing server...');
  process.stdout.write(''); // Flush stdout

  const server = serve({ fetch: app.fetch, port }, (info) => {
    console.log(`🚀 Deployment API running on port ${info.port}`);
    console.log(`📍 Endpoints:`);
    console.log(`   POST   /api/deploy`);
    console.log(`   GET    /api/deployments`);
    console.log(`   GET    /api/deployments/:id`);
    console.log(`   DELETE /api/deployments/:id`);
    process.stdout.write(''); // Flush stdout
  });

  // Graceful shutdown
  const shutdown = () => {
    console.log('\n👋 Shutting down gracefully...');
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return server;
}

export { app };
