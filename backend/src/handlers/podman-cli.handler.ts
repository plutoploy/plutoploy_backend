import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/**
 * Validate a container image reference before passing it to Podman.
 *
 * Even though we now use execFile (no shell), we still validate to reject
 * obviously malformed input early. Allows: registry host, namespace, repo,
 * :tag and @sha256 digest. Rejects anything with shell metacharacters,
 * whitespace, or flag-like leading dashes.
 */
const IMAGE_REF_RE = /^[a-z0-9]([a-z0-9._/-]*[a-z0-9])?(:[a-zA-Z0-9._-]+)?(@sha256:[a-f0-9]{64})?$/i;

export const isValidImageRef = (imageName: string): boolean => {
    if (!imageName || imageName.length > 255) return false;
    if (imageName.startsWith('-')) return false; // avoid arg injection as a flag
    return IMAGE_REF_RE.test(imageName);
};

const assertValidImageRef = (imageName: string): void => {
    if (!isValidImageRef(imageName)) {
        throw new Error(`Invalid image reference: ${imageName}`);
    }
};

/**
 * Pull image using Podman CLI (execFile — no shell, no injection).
 */
export const pullImage = async (imageName: string): Promise<void> => {
    if (!imageName) return;
    assertValidImageRef(imageName);

    console.log(`Pulling image via Podman CLI: ${imageName}`);

    try {
        const { stderr } = await execFileAsync('podman', ['pull', imageName]);
        if (stderr && !stderr.includes('Trying to pull')) {
            console.error('Pull stderr:', stderr);
        }
        console.log('Image pulled successfully');
    } catch (error: any) {
        console.error('Failed to pull image:', error.message);
        throw new Error(`Failed to pull image: ${error.message}`);
    }
};

/**
 * Create and start container using Podman CLI.
 *
 * @param port          host port to publish on
 * @param imageName     image reference (validated)
 * @param deployId      deployment id → container name `deploy-<deployId>`
 * @param containerPort port the app listens on inside the container (default 80)
 */
export const createAndStartContainer = async (
    port: number,
    imageName: string,
    deployId: string,
    containerPort: number = 80
): Promise<string> => {
    assertValidImageRef(imageName);
    const containerName = `deploy-${deployId}`;

    console.log(`Creating container: ${containerName} (${port}->${containerPort})`);

    try {
        const { stdout } = await execFileAsync('podman', [
            'run', '-d',
            '--name', containerName,
            '-p', `${port}:${containerPort}`,
            '--memory=512m',
            '--pids-limit=100',
            '--restart=unless-stopped',
            imageName,
        ]);

        const containerId = stdout.trim();
        console.log(`Container created: ${containerId}`);

        return containerId;
    } catch (error: any) {
        console.error('Failed to create container:', error.message);
        throw new Error(`Failed to create container: ${error.message}`);
    }
}
    console.log(`Creating container: ${containerName}`);

    try {
        let exposedPort = 80;

        try {
            const { stdout } = await execAsync(
                `podman image inspect ${imageName} --format '{{json .Config.ExposedPorts}}'`
            );

            const ports: Record<string, unknown> = JSON.parse(
                stdout.trim() || '{}'
            );

            const portKeys = Object.keys(ports);

            if (portKeys.length > 0) {
                const firstKey = portKeys[0];

                if (firstKey) {
                    const splitParts = firstKey.split('/');
                    const portString = splitParts[0];

                    if (portString) {
                        const parsedPort = Number.parseInt(portString, 10);

                        if (!Number.isNaN(parsedPort)) {
                            exposedPort = parsedPort;
                        }
                    }
                }

                console.log(
                    `Detected exposed port from image: ${exposedPort}`
                );
            } else {
                console.log(
                    'No exposed port detected, defaulting to 80'
                );
            }
        } catch (e: any) {
            console.log(
                `Could not determine exposed port for ${imageName}, defaulting to 80. Error: ${e.message}`
            );
        }

        console.log(
            `Mapping host port ${port} to container port ${exposedPort}`
        );

        const { stdout } = await execAsync(`
            podman run -d \
            --name ${containerName} \
            -p ${port}:${exposedPort} \
            --memory=512m \
            --pids-limit=100 \
            --restart=unless-stopped \
            ${imageName}
        `);

        const containerId = stdout.trim();

        console.log(`Container created: ${containerId}`);

        return containerId;
    } catch (error: any) {
        console.error(
            'Failed to create container:',
            error.message
        );

        throw new Error(
            `Failed to create container: ${error.message}`
        );
    };
/**
 * Stop container using Podman CLI.
 */
export const stopContainer = async (deployId: string): Promise<void> => {
    const containerName = `deploy-${deployId}`;

    try {
        await execFileAsync('podman', ['stop', containerName]);
        console.log(`Container stopped: ${containerName}`);
    } catch (error: any) {
        console.error('Failed to stop container:', error.message);
        throw error;
    }
};

/**
 * Remove container using Podman CLI.
 */
export const removeContainer = async (deployId: string): Promise<void> => {
    const containerName = `deploy-${deployId}`;

    try {
        await execFileAsync('podman', ['rm', '-f', containerName]);
        console.log(`Container removed: ${containerName}`);
    } catch (error: any) {
        console.error('Failed to remove container:', error.message);
        throw error;
    }
};

/**
 * Get container logs using Podman CLI.
 */
export const getContainerLogs = async (deployId: string, tail: number = 100): Promise<string> => {
    const containerName = `deploy-${deployId}`;

    try {
        const { stdout } = await execFileAsync('podman', ['logs', '--tail', String(tail), containerName]);
        return stdout;
    } catch (error: any) {
        console.error('Failed to get logs:', error.message);
        throw error;
    }
};

/**
 * Check if container is running using Podman CLI.
 */
export const isContainerRunning = async (deployId: string): Promise<boolean> => {
    const containerName = `deploy-${deployId}`;

    try {
        const { stdout } = await execFileAsync('podman', [
            'ps', '--filter', `name=${containerName}`, '--format', '{{.Names}}',
        ]);
        return stdout.trim() === containerName;
    } catch (error) {
        return false;
    }
};
