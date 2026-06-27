import { Hono } from 'hono';
import { buildsDb, deploymentDb } from '../db/database.ts';
import { deployApp } from '../services/deployment.service.ts';
import { randomUUID, createHmac } from 'crypto';

/**
 * Find next available port from database
 */
async function findAvailablePort(): Promise<number> {
    const usedPorts = new Set(await deploymentDb.getUsedPorts());
    let port = 3001;
    
    // Check if port is actually in use by checking with lsof
    while (true) {
        if (!usedPorts.has(port)) {
            try {
                // Quick check if port is available
                const { execSync } = await import('child_process');
                const result = execSync(`lsof -ti:${port} 2>/dev/null || echo "available"`).toString().trim();
                if (result === 'available') {
                    return port;
                }
            } catch {
                // If lsof fails, assume port is available
                return port;
            }
        }
        port++;
    }
}

const webhookRoutes = new Hono();

webhookRoutes.post('/github', async (c) => {
    const signature = c.req.header('x-hub-signature-256');
    const rawBody = await c.req.text();
    const secret = process.env.GITHUB_WEBHOOK_SECRET;

    if (secret && signature) {
        const hmac = createHmac('sha256', secret);
        const expectedSignature = 'sha256=' + hmac.update(rawBody).digest('hex');
        if (signature !== expectedSignature) {
            console.error('[Webhook] Invalid signature');
            return c.json({ error: 'Invalid signature' }, 401);
        }
    } else if (secret && !signature) {
        console.error('[Webhook] Missing signature');
        return c.json({ error: 'Missing signature' }, 401);
    }

    const event = c.req.header('x-github-event');
    let body;
    try {
        body = JSON.parse(rawBody);
    } catch (e) {
        return c.json({ error: 'Invalid JSON' }, 400);
    }

    if (event === 'workflow_run') {
        const { action, workflow_run, repository } = body;
        const repoFullName = repository.full_name;

        console.log(`[Webhook] workflow_run ${action} for ${repoFullName}`);

        // Find the latest build for this repo that might be associated with this run
        const latestBuild = await buildsDb.getLatestByRepo(repoFullName) as any;

        if (!latestBuild) {
            console.log('[Webhook] No tracking build found for this repo. Ignoring.');
            return c.json({ received: true });
        }

        if (action === 'requested' || action === 'in_progress') {
            // Update the build with the GitHub run ID so we can poll its logs later
            await buildsDb.updateState(latestBuild.id, 'in_progress', String(workflow_run.id));
            console.log(`[Webhook] Linked build ${latestBuild.id} to GitHub run ${workflow_run.id}`);
        } else if (action === 'completed') {
            const conclusion = workflow_run.conclusion;
            
            if (conclusion === 'success') {
                await buildsDb.updateState(latestBuild.id, 'success');
                console.log(`[Webhook] Build ${latestBuild.id} completed successfully. Starting deployment...`);
                
                // Extract image tag and trigger deployment
                // Our workflow pushes to ghcr.io/<repoFullName>:latest
                const imageName = `ghcr.io/${repoFullName.toLowerCase()}:latest`;
                
                // Generate a subdomain (e.g., from repo name or random)
                // Remove invalid characters from repo name for subdomain
                const safeName = repository.name.replace(/[^a-z0-9-]/gi, '').toLowerCase();
                const randomStr = Math.random().toString(36).substring(2, 6);
                const subdomain = `${safeName}-${randomStr}`;
                
                const deployId = randomUUID();
                
                try {
                    const port = await findAvailablePort();

                    // Start the container
                    const result = await deployApp({
                        deployId,
                        subdomain,
                        port,
                        imageName
                    });

                    // Store deployment in database
                    await deploymentDb.create({
                        deployId,
                        subdomain,
                        port,
                        imageName,
                        containerId: result.containerId,
                        repo: repoFullName
                    });

                    console.log(`[Webhook] Deployed successfully to ${subdomain}`);
                } catch (err) {
                    console.error('[Webhook] Deployment failed after build:', err);
                }
            } else {
                await buildsDb.updateState(latestBuild.id, 'failure');
                console.log(`[Webhook] Build ${latestBuild.id} failed with conclusion: ${conclusion}`);
            }
        }
    }

    return c.json({ received: true });
});

export { webhookRoutes };
