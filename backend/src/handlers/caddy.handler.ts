import { stopContainer, removeContainer } from './podman-cli.handler';
import { routesDb } from '../db/database';

/**
 * Add route to Caddy via SQLite
 * Caddy will automatically pick up the route without reload
 */
export const addCaddyRoute = async (deployId: string, subdomain: string, port: number) => {
    const domain = `${subdomain}.${process.env.DOMAIN || 'yourdomain.com'}`;
    const host = '127.0.0.1'; // localhost
    
    try {
        await routesDb.upsert(domain, host, port);
        console.log(`✅ Caddy route added: ${domain} -> ${host}:${port}`);
    } catch (error: any) {
        console.error('Failed to add Caddy route:', error.message);
        throw error;
    }
};

/**
 * Remove route from Caddy via SQLite
 */
export const removeCaddyRoute = async (subdomain: string) => {
    const domain = `${subdomain}.${process.env.DOMAIN || 'yourdomain.com'}`;
    
    try {
        await routesDb.delete(domain);
        console.log(`✅ Caddy route removed: ${domain}`);
    } catch (error: any) {
        console.error('Failed to remove Caddy route:', error.message);
        throw error;
    }
};


/**
 * remove caddy route and container
 * @param deployId
 */

export const removeDeployment = async (deployId : string) =>{
    const { deploymentDb } = await import('../db/database');
    const deployment = await deploymentDb.getById(deployId) as any;
    
    if (!deployment) {
        throw new Error('Deployment not found');
    }
    
    try {
        // Stop and remove container
        await stopContainer(deployId);
        await removeContainer(deployId);

        // Remove Caddy route
        await removeCaddyRoute(deployment.subdomain);
        
        console.log(`✅ Deployment ${deployId} removed`);
    } catch (err) {
        console.error("Failed to remove deployment:", err);
        throw err;
    }
}