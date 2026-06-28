import { pullImage, createAndStartContainer, removeContainer } from '../handlers/podman-cli.handler';
import { addCaddyRoute, removeCaddyRoute } from '../handlers/caddy.handler';
import type { DeploymentConfig } from '../types/config';

/**
 * Main deployment orchestration service.
 *
 * Steps: pull image → run container → add Caddy route. If a later step fails
 * after an earlier one created state (e.g. the container started but the route
 * insert threw), we roll back so we don't leave orphaned containers/routes.
 */
export const deployApp = async (config: DeploymentConfig) => {
    const { deployId, subdomain, port, imageName, containerPort = 80 } = config;

    let containerCreated = false;
    let routeAdded = false;

    try {
        console.log(`Starting deployment ${deployId}...`);

        // 1. Pull image from registry
        console.log(`Pulling image: ${imageName}`);
        await pullImage(imageName);

        // 2. Create and start container
        console.log(`Creating container on port ${port} (container port ${containerPort})`);
        const containerId = await createAndStartContainer(port, imageName, deployId, containerPort);
        containerCreated = true;

        // 3. Add Caddy route via SQLite
        console.log(`Adding Caddy route for ${subdomain}...`);
        await addCaddyRoute(deployId, subdomain, port);
        routeAdded = true;

        console.log(`✅ Deployment ${deployId} successful!`);

        return {
            success: true,
            deployId,
            subdomain,
            port,
            url: `https://${subdomain}.${process.env.DOMAIN || 'yourdomain.com'}`,
            containerId,
        };
    } catch (error: any) {
        console.error(`❌ Deployment ${deployId} failed:`, error.message);
        await rollback(deployId, subdomain, { containerCreated, routeAdded });
        throw error;
    }
};

/**
 * Undo whatever partial state a failed deployment created.
 * Best-effort: each step is independently guarded so one failure doesn't
 * block the rest of the cleanup.
 */
export const rollback = async (
    deployId: string,
    subdomain: string,
    state: { containerCreated: boolean; routeAdded: boolean }
) => {
    console.log(`Rolling back deployment ${deployId}...`);

    if (state.routeAdded) {
        try {
            await removeCaddyRoute(subdomain);
        } catch (err: any) {
            console.error('Rollback: failed to remove route:', err.message);
        }
    }

    if (state.containerCreated) {
        try {
            await removeContainer(deployId);
        } catch (err: any) {
            console.error('Rollback: failed to remove container:', err.message);
        }
    }
};
