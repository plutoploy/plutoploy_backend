/**
 * Container Service client — talks to the remote container agent (separate repo)
 * that owns Docker on the deploy host. `POST /containers` auto-pulls the image if
 * it's missing, creates the container, and starts it.
 *
 * Routing (Caddy) is a different service and is NOT handled here.
 */

const SERVICE_URL = process.env.CONTAINER_SERVICE_URL;
const SERVICE_TOKEN = process.env.CONTAINER_SERVICE_TOKEN;

export interface CreateContainerInput {
  image: string; // e.g. ghcr.io/owner/repo:latest
  name?: string; // container name (we use deploy-<deployId>)
  hostPort: number; // port to expose on the agent host
  containerPort?: number; // port the app listens on inside (default 80 — our nginx image)
  labels?: Record<string, string>;
}

/**
 * Create + start a container on the remote agent. Returns the new container id.
 * Maps our deploy config onto the agent's Docker-shaped body (config / host_config).
 */
export async function createRemoteContainer(
  input: CreateContainerInput,
): Promise<{ id: string; warnings: string[] }> {
  if (!SERVICE_URL) throw new Error("CONTAINER_SERVICE_URL is not set");

  // ponytail: minimal body for now — Go service only accepts `image`. Add port/name/labels when Go supports them.
  const body = {
    image: input.image,
  };

  const res = await fetch(`${SERVICE_URL}/containers`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // ponytail: shared bearer secret. The agent validates it on its side
      // (you said that's a later task there). Swap for mTLS only if it ever leaves a trusted network.
      ...(SERVICE_TOKEN ? { Authorization: `Bearer ${SERVICE_TOKEN}` } : {}),
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(
      `Container service POST /containers → ${res.status} ${res.statusText}: ${await res.text()}`,
    );
  }

  const json = (await res.json()) as {
    ok?: boolean;
    data?: { id?: string; warnings?: string[] };
  };
  if (!json.ok || !json.data?.id) {
    throw new Error(
      `Container service returned unexpected payload: ${JSON.stringify(json)}`,
    );
  }
  return { id: json.data.id, warnings: json.data.warnings ?? [] };
}
