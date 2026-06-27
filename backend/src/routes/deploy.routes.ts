import { Hono } from 'hono';
import { deployApp } from '../services/deployment.service';
import { removeDeployment } from '../handlers/caddy.handler';
import { randomUUID } from 'crypto';
import { deploymentDb, routesDb } from '../db/database';
import { requireAuth, type AuthEnv } from '../middleware/auth.middleware';

const deployRoutes = new Hono<AuthEnv>();

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

/**
 * Deploy a new app
 */
deployRoutes.post('/deploy', requireAuth, async (c) => {
    try {
        const { login } = c.get('user');
        console.log('Deploy endpoint hit');
        const body = await c.req.json();
        console.log('Request body:', body);
        const { image, subdomain, repo, containerPort } = body;

        // Validate input
        if (!image || !subdomain) {
            return c.json({ error: 'Missing required fields: image, subdomain' }, 400);
        }

        // Validate subdomain format
        if (!/^[a-z0-9-]+$/.test(subdomain)) {
            return c.json({ error: 'Invalid subdomain format' }, 400);
        }

        // Validate optional container port (port the app listens on inside the container)
        if (containerPort !== undefined) {
            if (!Number.isInteger(containerPort) || containerPort < 1 || containerPort > 65535) {
                return c.json({ error: 'Invalid containerPort: must be an integer 1-65535' }, 400);
            }
        }
        
        // Check if subdomain is taken
        if (await deploymentDb.subdomainExists(subdomain)) {
            return c.json({ error: 'Subdomain already taken' }, 409);
        }
        
        // Generate deployment ID and allocate port
        const deployId = randomUUID();
        const port = await findAvailablePort();
        
        console.log('Starting deployment:', { deployId, subdomain, port, image });
        
        // Deploy the app
        const result = await deployApp({
            deployId,
            subdomain,
            port,
            imageName: image,
            containerPort
        });
        
        // Store deployment in database
        await deploymentDb.create({
            deployId,
            subdomain,
            port,
            imageName: image,
            containerId: result.containerId,
            repo,
            login
        });
        
        const deployment = {
            ...result,
            repo,
            createdAt: new Date().toISOString()
        };
        
        return c.json({
            success: true,
            deployment
        });
        
    } catch (error: any) {
        console.error('Deployment error:', error);
        console.error('Error stack:', error.stack);
        return c.json({ 
            success: false, 
            error: error.message || 'Unknown error'
        }, 500);
    }
});

/**
 * List all deployments
 */
deployRoutes.get('/deployments', requireAuth, async (c) => {
    const { login } = c.get('user');
    const deployments = await deploymentDb.getByLogin(login);
    return c.json({
        deployments,
        count: deployments.length
    });
});

/**
 * Get single deployment (must belong to the requesting user)
 */
deployRoutes.get('/deployments/:id', requireAuth, async (c) => {
    const { login } = c.get('user');
    const deployId = c.req.param('id');
    const deployment = await deploymentDb.getById(deployId);

    if (!deployment || deployment.login !== login) {
        return c.json({ error: 'Deployment not found' }, 404);
    }

    return c.json({ deployment });
});

/**
 * Delete a deployment (must belong to the requesting user)
 */
deployRoutes.delete('/deployments/:id', requireAuth, async (c) => {
    const { login } = c.get('user');
    const deployId = c.req.param('id');

    const deployment = await deploymentDb.getById(deployId);
    if (!deployment || deployment.login !== login) {
        return c.json({ error: 'Deployment not found' }, 404);
    }

    try {
        await removeDeployment(deployId);
        await deploymentDb.delete(deployId);
        
        return c.json({ 
            success: true,
            message: 'Deployment removed successfully'
        });
    } catch (error: any) {
        return c.json({ 
            success: false,
            error: error.message 
        }, 500);
    }
});

/**
 * Get all Caddy routes (for debugging)
 */
deployRoutes.get('/routes', async (c) => {
    try {
        const routes = await routesDb.getAll();
        return c.json({
            routes,
            count: routes.length
        });
    } catch (error: any) {
        console.error('Error fetching routes:', error);
        return c.json({ 
            error: 'Failed to fetch routes',
            message: error.message 
        }, 500);
    }
});

export { deployRoutes };
