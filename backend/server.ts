import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { deployRoutes } from "./src/routes/deploy.routes";
import { authRoutes } from "./src/routes/auth.routes";
import { githubRoutes } from "./src/routes/github.routes";
import { webhookRoutes } from "./src/routes/webhook.routes";

const app = new Hono();

// Enable CORS — echo the request origin (wildcard is rejected when credentials: 'include')
// ponytail: reflects any origin for testing. Pin to an allowlist before prod.
app.use("/*", cors({
  origin: (o) => o,            // Hono: a function reflects the incoming Origin back
  credentials: true,
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'ngrok-skip-browser-warning'],
}));

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

const port = parseInt(process.env.PORT || "6000" );

export function startServer() {
  console.log('Initializing server...');
  process.stdout.write(''); // Flush stdout

  const server = serve({ fetch: app.fetch, port }, (info) => {
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
