# Plutoploy

A container deployment platform backend built with [Hono](https://hono.dev) + [Bun](https://bun.sh), wrapping [Podman](https://podman.io) via [`@pratyay360/podman-ts`](https://mintlify.wiki/Pratyay360/podman-ts).

## Prerequisites

- [Bun](https://bun.sh) (latest)
- [Podman](https://podman.io) with the socket enabled:
  ```bash
  systemctl --user enable --now podman.socket
  ```

## Quick Start

```bash
# Install dependencies
bun install

# Run dev server (hot-reload on port 3000)
bun run dev

# Build standalone binary
bun run build

# Run the built binary
bun run start
```

## Production (systemd)

```bash
# Build the binary
bun run build

# Copy binary and service file
cp plutoploy ~/.local/bin/
cp plutoploy.service ~/.local/share/systemd/user/

# Enable and start
systemctl --user daemon-reload
systemctl --user enable --now plutoploy.service
```

---

## API Reference

Base URL: `http://localhost:3000`

### General

#### `GET /`

Returns API status info.

```bash
curl http://localhost:3000/
```

```json
{
  "message": "Deployment Platform API",
  "status": "running",
  "version": "1.0.0"
}
```

#### `GET /health`

Health check endpoint.

```bash
curl http://localhost:3000/health
```

```json
{ "status": "healthy" }
```

---

### Image Management

#### `POST /api/pull`

Pull a container image from a registry.

```bash
curl -X POST http://localhost:3000/api/pull \
  -H "Content-Type: application/json" \
  -d '{"image": "docker.io/library/nginx", "tag": "latest"}'
```

| Field       | Type    | Required | Default  | Description                    |
|-------------|---------|----------|----------|--------------------------------|
| `image`     | string  | ✅       | —        | Full image name                |
| `tag`       | string  | ❌       | `latest` | Image tag                      |
| `tlsVerify` | boolean | ❌       | `true`   | Verify TLS when pulling        |

#### `GET /api/images`

List all local images.

```bash
curl http://localhost:3000/api/images
```

#### `GET /api/images/:name`

Inspect a specific image by name or ID.

```bash
curl http://localhost:3000/api/images/nginx
```

#### `DELETE /api/images/:name`

Remove an image by name or ID.

```bash
curl -X DELETE http://localhost:3000/api/images/nginx
```

---

### Container Lifecycle

#### `POST /api/deploy`

Pull an image, create a container, and start it in one step.

```bash
curl -X POST http://localhost:3000/api/deploy \
  -H "Content-Type: application/json" \
  -d '{
    "image": "docker.io/library/nginx",
    "name": "my-nginx",
    "tag": "latest",
    "portMappings": [{"hostPort": 8080, "containerPort": 80}],
    "environment": {"MY_VAR": "hello"},
    "labels": {"app": "web"}
  }'
```

| Field          | Type     | Required | Default  | Description                        |
|----------------|----------|----------|----------|------------------------------------|
| `image`        | string   | ✅       | —        | Full image name                    |
| `name`         | string   | ❌       | —        | Container name                     |
| `tag`          | string   | ❌       | `latest` | Image tag                          |
| `command`      | string[] | ❌       | —        | Override container command          |
| `portMappings` | array    | ❌       | —        | Port mappings (`hostPort`, `containerPort`) |
| `environment`  | object   | ❌       | —        | Environment variables              |
| `labels`       | object   | ❌       | —        | Container labels                   |

#### `GET /api/containers`

List all containers (running and stopped).

```bash
curl http://localhost:3000/api/containers
```

#### `GET /api/containers/:id`

Inspect a container by ID or name.

```bash
curl http://localhost:3000/api/containers/my-nginx
```

#### `GET /api/containers/:id/logs`

Fetch container logs. Supports a `tail` query param (default: 100).

```bash
# Last 100 lines (default)
curl http://localhost:3000/api/containers/my-nginx/logs

# Last 50 lines
curl http://localhost:3000/api/containers/my-nginx/logs?tail=50
```

| Query Param | Type   | Default | Description              |
|-------------|--------|---------|--------------------------|
| `tail`      | number | `100`   | Number of log lines      |

#### `GET /api/containers/:id/stats`

Get resource usage statistics for a container.

```bash
curl http://localhost:3000/api/containers/my-nginx/stats
```

#### `POST /api/containers/:id/start`

Start a stopped container.

```bash
curl -X POST http://localhost:3000/api/containers/my-nginx/start
```

#### `POST /api/containers/:id/stop`

Stop a running container.

```bash
curl -X POST http://localhost:3000/api/containers/my-nginx/stop
```

#### `POST /api/containers/:id/restart`

Restart a container.

```bash
curl -X POST http://localhost:3000/api/containers/my-nginx/restart
```

#### `DELETE /api/containers/:id`

Force-remove a container. Also cleans up any associated route mappings from the database.

```bash
curl -X DELETE http://localhost:3000/api/containers/my-nginx
```

---

### Route Management

Routes map incoming paths to containers. Stored in a local SQLite database (`routes.db`).

#### `GET /api/routes`

List all route-to-container mappings.

```bash
curl http://localhost:3000/api/routes
```

```json
{
  "routes": [
    { "id": 1, "route": "/app", "container": "my-nginx", "port": 8080 }
  ]
}
```

#### `POST /api/routes`

Add a new route mapping.

```bash
curl -X POST http://localhost:3000/api/routes \
  -H "Content-Type: application/json" \
  -d '{"route": "/app", "container": "my-nginx", "port": 8080}'
```

| Field       | Type   | Required | Description                  |
|-------------|--------|----------|------------------------------|
| `route`     | string | ✅       | URL path to map              |
| `container` | string | ✅       | Container name or ID         |
| `port`      | number | ✅       | Port the container listens on|

#### `DELETE /api/routes/:id`

Remove a route mapping by its ID.

```bash
curl -X DELETE http://localhost:3000/api/routes/1
```

---

### System

#### `GET /api/system/info`

Get Podman system information.

```bash
curl http://localhost:3000/api/system/info
```

#### `POST /api/prune`

Prune unused containers, images, and volumes.

```bash
curl -X POST http://localhost:3000/api/prune
```

---

## Project Structure

```
├── index.ts                    # Entry point — Hono app, CORS, route mounting
├── src/
│   ├── handlers/
│   │   └── db.ts               # SQLite database setup (routes table)
│   └── routes/
│       └── deployRoutes.ts     # All API route handlers
├── package.json
├── plutoploy.service           # systemd user service template
├── routes.db                   # SQLite database (auto-created)
└── tsconfig.json
```

## Scripts

| Command          | Description                              |
|------------------|------------------------------------------|
| `bun run dev`    | Start dev server with hot reload         |
| `bun run build`  | Compile to standalone Linux binary       |
| `bun run start`  | Run the compiled binary                  |
| `bun run lint`   | Lint with oxlint                         |
| `bun run format` | Format with oxfmt                        |
