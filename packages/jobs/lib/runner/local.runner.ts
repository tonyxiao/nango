import type { Runner } from './runner.js';
import { execSync, spawn, ChildProcess } from 'child_process';
import { getRunnerClient } from '@nangohq/nango-runner';

class LocalRunner implements Runner {
    constructor(public client: any, private readonly childProcess: ChildProcess) {}

    async stop(): Promise<void> {
        this.childProcess.kill();
    }
}

export async function getLocalRunner(runnerId: string): Promise<LocalRunner> {
    const port = Math.floor(Math.random() * 1000) + 11000; // random port between 11000 and 12000;
    let nodePath = '';
    try {
        nodePath = execSync('which node', { encoding: 'utf-8' }).trim();
    } catch (err) {
        throw new Error('Unable to find node');
    }

    const nangoRunnerPath = process.env['NANGO_RUNNER_PATH'] || '../runner/dist/app.js';

    const cmd = nodePath;
    const runnerLocation = `${nangoRunnerPath}`;
    const cmdOptions = [runnerLocation, port.toString(), runnerId];
    console.log(`[Runner] Starting runner with command: ${cmd} ${cmdOptions.join(' ')} `);

    const childProcess = spawn(cmd, cmdOptions, {
        stdio: [null, null, null]
    });

    if (!childProcess) {
        throw new Error('Unable to spawn runner process');
    }

    if (childProcess.stdout) {
        childProcess.stdout.on('data', (data) => {
            console.log(`[Runner] ${data.toString()} `);
        });
    }

    if (childProcess.stderr) {
        childProcess.stderr.on('data', (data) => {
            console.log(`[Runner][ERROR] ${data.toString()} `);
        });
    }

    const client = getRunnerClient(`http://localhost:${port}`);
    // Wait for runner to start and be healthy
    let healthCheck = false;
    let timeoutMs = 10000;
    let startTime = Date.now();
    while (!healthCheck && Date.now() - startTime < timeoutMs) {
        try {
            await client.health.query();
            healthCheck = true;
        } catch (err) {
            await new Promise((resolve) => setTimeout(resolve, 1000));
        }
    }
    if (!healthCheck) {
        throw new Error(`Runner hasn't started after ${timeoutMs}ms,`);
    }
    return new LocalRunner(client, childProcess);
}
