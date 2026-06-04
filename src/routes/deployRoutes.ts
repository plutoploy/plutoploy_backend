import { Hono } from "hono";
import { PodmanClient } from "@pratyay360/podman-ts";
import db from "../handlers/db";

const deployRoutes = new Hono();
const client = new PodmanClient();

// ─── Image Management ───

deployRoutes.post("/pull", async (c) => {
  try {
    const body = await c.req.json();
    const { image, tag = "latest", tlsVerify = true } = body;

    if (!image) {
      return c.json({ error: "Image name is required" }, 400);
    }

    const repository = tag ? `${image}:${tag}` : image;
    const pulledImage = await client.images.pull(repository, { tlsVerify });

    return c.json({
      message: "Image pulled successfully",
      image: pulledImage,
    });
  } catch (error) {
    return c.json(
      {
        message: "Error pulling image",
        error: error instanceof Error ? error.message : String(error),
      },
      500,
    );
  }
});

deployRoutes.get("/images", async (c) => {
  try {
    const images = await client.images.list();
    return c.json({
      images: images.map((img) => ({
        id: img.id,
        tags: img.tags,
        labels: img.labels,
      })),
    });
  } catch (error) {
    return c.json(
      {
        message: "Error listing images",
        error: error instanceof Error ? error.message : String(error),
      },
      500,
    );
  }
});

deployRoutes.get("/images/:name", async (c) => {
  try {
    const { name } = c.req.param();
    const image = await client.images.get(name);
    return c.json({
      image: {
        id: image.id,
        tags: image.tags,
        labels: image.labels,
      },
    });
  } catch (error) {
    return c.json(
      {
        message: "Error inspecting image",
        error: error instanceof Error ? error.message : String(error),
      },
      500,
    );
  }
});

deployRoutes.delete("/images/:name", async (c) => {
  try {
    const { name } = c.req.param();
    await client.images.remove(name);
    return c.json({ message: "Image removed", name });
  } catch (error) {
    return c.json(
      {
        message: "Error removing image",
        error: error instanceof Error ? error.message : String(error),
      },
      500,
    );
  }
});

// ─── Container Lifecycle ───

deployRoutes.post("/deploy", async (c) => {
  try {
    const body = await c.req.json();
    const { image, name, tag = "latest", command, portMappings, environment, labels } = body;

    if (!image) {
      return c.json({ error: "Image name is required" }, 400);
    }

    const repository = tag ? `${image}:${tag}` : image;
    await client.images.pull(repository);

    const container = await client.containers.create({
      image: repository,
      name: name || undefined,
      command: command || undefined,
      portMappings: portMappings || undefined,
      env: environment || undefined,
      labels: labels || undefined,
    });

    await container.start();

    const inspect = await container.inspect() as any;

    return c.json({
      message: "Container deployed successfully",
      container: {
        id: container.id,
        name: inspect.Name,
        image: inspect.Config?.Image,
        status: inspect.State?.Status,
        ports: inspect.HostConfig?.PortBindings,
      },
    });
  } catch (error) {
    return c.json(
      {
        message: "Error deploying container",
        error: error instanceof Error ? error.message : String(error),
      },
      500,
    );
  }
});

deployRoutes.get("/containers", async (c) => {
  try {
    const containers = await client.containers.list({ all: true });
    return c.json({
      containers: containers.map((ct) => ({
        id: ct.id,
        name: ct.name,
        status: ct.status,
        labels: ct.labels,
        ports: ct.ports,
      })),
    });
  } catch (error) {
    return c.json(
      {
        message: "Error listing containers",
        error: error instanceof Error ? error.message : String(error),
      },
      500,
    );
  }
});

deployRoutes.get("/containers/:id", async (c) => {
  try {
    const { id } = c.req.param();
    const container = await client.containers.get(id);
    const inspect = await container.inspect();
    return c.json({ container: inspect });
  } catch (error) {
    return c.json(
      {
        message: "Error inspecting container",
        error: error instanceof Error ? error.message : String(error),
      },
      500,
    );
  }
});

deployRoutes.get("/containers/:id/logs", async (c) => {
  try {
    const { id } = c.req.param();
    const tail = c.req.query("tail") || "100";
    const container = await client.containers.get(id);
    const logs = await container.logs({ tail: Number(tail), stdout: true, stderr: true });
    return c.json({ id, logs });
  } catch (error) {
    return c.json(
      {
        message: "Error fetching logs",
        error: error instanceof Error ? error.message : String(error),
      },
      500,
    );
  }
});

deployRoutes.get("/containers/:id/stats", async (c) => {
  try {
    const { id } = c.req.param();
    const container = await client.containers.get(id);
    const stats = await container.stats({ stream: false });
    return c.json({ id, stats });
  } catch (error) {
    return c.json(
      {
        message: "Error fetching stats",
        error: error instanceof Error ? error.message : String(error),
      },
      500,
    );
  }
});

deployRoutes.post("/containers/:id/start", async (c) => {
  try {
    const { id } = c.req.param();
    const container = await client.containers.get(id);
    await container.start();
    return c.json({ message: "Container started", id });
  } catch (error) {
    return c.json(
      {
        message: "Error starting container",
        error: error instanceof Error ? error.message : String(error),
      },
      500,
    );
  }
});

deployRoutes.post("/containers/:id/stop", async (c) => {
  try {
    const { id } = c.req.param();
    const container = await client.containers.get(id);
    await container.stop();
    return c.json({ message: "Container stopped", id });
  } catch (error) {
    return c.json(
      {
        message: "Error stopping container",
        error: error instanceof Error ? error.message : String(error),
      },
      500,
    );
  }
});

deployRoutes.post("/containers/:id/restart", async (c) => {
  try {
    const { id } = c.req.param();
    const container = await client.containers.get(id);
    await container.restart();
    return c.json({ message: "Container restarted", id });
  } catch (error) {
    return c.json(
      {
        message: "Error restarting container",
        error: error instanceof Error ? error.message : String(error),
      },
      500,
    );
  }
});

deployRoutes.delete("/containers/:id", async (c) => {
  try {
    const { id } = c.req.param();
    const container = await client.containers.get(id);
    await container.remove({ force: true });

    // also clean up any route mapping for this container
    db.run("DELETE FROM routes WHERE container = ?", [id]);

    return c.json({ message: "Container removed", id });
  } catch (error) {
    return c.json(
      {
        message: "Error removing container",
        error: error instanceof Error ? error.message : String(error),
      },
      500,
    );
  }
});

// ─── Route Management ───

deployRoutes.get("/routes", (c) => {
  try {
    const routes = db.query("SELECT rowid as id, route, container, port FROM routes").all();
    return c.json({ routes });
  } catch (error) {
    return c.json(
      {
        message: "Error listing routes",
        error: error instanceof Error ? error.message : String(error),
      },
      500,
    );
  }
});

deployRoutes.post("/routes", async (c) => {
  try {
    const { route, container, port } = await c.req.json();

    if (!route || !container || !port) {
      return c.json({ error: "route, container, and port are required" }, 400);
    }

    db.run("INSERT INTO routes (route, container, port) VALUES (?, ?, ?)", [route, container, port]);

    return c.json({ message: "Route added", route, container, port });
  } catch (error) {
    return c.json(
      {
        message: "Error adding route",
        error: error instanceof Error ? error.message : String(error),
      },
      500,
    );
  }
});

deployRoutes.delete("/routes/:id", (c) => {
  try {
    const { id } = c.req.param();
    const result = db.run("DELETE FROM routes WHERE rowid = ?", [id]);

    if (result.changes === 0) {
      return c.json({ error: "Route not found" }, 404);
    }

    return c.json({ message: "Route removed", id });
  } catch (error) {
    return c.json(
      {
        message: "Error removing route",
        error: error instanceof Error ? error.message : String(error),
      },
      500,
    );
  }
});

// ─── System ───

deployRoutes.get("/system/info", async (c) => {
  try {
    const info = await client.system.info();
    return c.json({ info });
  } catch (error) {
    return c.json(
      {
        message: "Error fetching system info",
        error: error instanceof Error ? error.message : String(error),
      },
      500,
    );
  }
});

deployRoutes.post("/prune", async (c) => {
  try {
    const result = await client.system.prune();
    return c.json({ message: "Prune completed", result });
  } catch (error) {
    return c.json(
      {
        message: "Error pruning",
        error: error instanceof Error ? error.message : String(error),
      },
      500,
    );
  }
});

export { deployRoutes };

