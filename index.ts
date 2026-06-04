import { Hono } from "hono";
import { cors } from "hono/cors";
import { deployRoutes } from "./src/routes/deployRoutes";
const app = new Hono();

app.use("*", cors());

app.route("/api", deployRoutes);


app.get("/", (c) => {
  return c.json({
    message: "Deployment Platform API",
    status: "running",
    version: "1.0.0",
  });
});

app.get("/health", (c) => {
  return c.json({ status: "healthy" });
});

export default {
  port: 3000,
  fetch: app.fetch,
};
