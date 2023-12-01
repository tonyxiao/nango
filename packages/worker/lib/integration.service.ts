import type { Context } from '@temporalio/activity';
import { NodeVM } from 'vm2';
import {
    IntegrationServiceInterface,
    createActivityLogMessage,
    getRootDir,
    NangoIntegrationData,
    NangoSync,
    NangoProps,
    localFileService,
    remoteFileService,
    isCloud,
    ServiceResponse,
    NangoError,
    formatScriptError,
    featureFlags
} from '@nangohq/shared';
import { execSync, spawn, ChildProcess } from 'child_process';
import { getRunnerClient } from '@nangohq/runner';
import * as path from 'path';

class IntegrationService implements IntegrationServiceInterface {
    public runningScripts: { [key: string]: Context } = {};

    constructor() {
        this.sendHeartbeat();
    }

    async runScript(
        syncName: string,
        syncId: string,
        activityLogId: number | undefined,
        nangoProps: NangoProps,
        integrationData: NangoIntegrationData,
        environmentId: number,
        writeToDb: boolean,
        isAction: boolean,
        optionalLoadLocation?: string,
        input?: object,
        temporalContext?: Context
    ): Promise<ServiceResponse<any>> {
        try {
            const nango = new NangoSync(nangoProps);
            const script: string | null =
                isCloud() && !optionalLoadLocation
                    ? await remoteFileService.getFile(integrationData.fileLocation as string, environmentId)
                    : localFileService.getIntegrationFile(syncName, optionalLoadLocation);

            if (!script) {
                const content = `Unable to find integration file for ${syncName}`;

                if (activityLogId && writeToDb) {
                    await createActivityLogMessage({
                        level: 'error',
                        environment_id: environmentId,
                        activity_log_id: activityLogId,
                        content,
                        timestamp: Date.now()
                    });
                }
            }

            if (!script && activityLogId && writeToDb) {
                await createActivityLogMessage({
                    level: 'error',
                    environment_id: environmentId,
                    activity_log_id: activityLogId,
                    content: `Unable to find integration file for ${syncName}`,
                    timestamp: Date.now()
                });

                const error = new NangoError('Unable to find integration file', 404);

                return { success: false, error, response: null };
            }

            // TODO: nsjail in worker dockerfile

            // TODO: timeout runner after 24 hours
            // TODO LATER: cap cpu and memory usage
            // TODO LATER: heartbeat to temporal based on runner health?
            // TODO LATER: high load protection
            try {
                if (temporalContext) {
                    this.runningScripts[syncId] = temporalContext;
                }
                const distinctId = `${environmentId}`;
                const flag = await featureFlags.isEnabled('runner-v1', distinctId, false);
                console.log(`Feature flag 'runner-v1' for environment '${distinctId}' is enabled=${flag}`);
                if (flag) {
                    let childProcess = undefined;
                    try {
                        const port = Math.floor(Math.random() * 1000) + 11000; // random port between 11000 and 12000;
                        const client = getRunnerClient(`http://localhost:${port}`);
                        const runnerId = `${syncName}-${nangoProps.environmentId}-${nangoProps.providerConfigKey}-${nangoProps.connectionId}`;
                        childProcess = await startRunner(runnerId, port, client);

                        const res = await client.run.mutate({ nangoProps, code: script as string, codeParams: input as object, isAction });
                        return { success: true, error: null, response: res };
                    } catch (err) {
                        const errMsg = `There was an error running integration '${syncName}': ${err}`;
                        return { success: false, error: new NangoError(errMsg, 500), response: null };
                    } finally {
                        if (childProcess) {
                            childProcess.kill();
                        }
                    }
                } else {
                    const vm = new NodeVM({
                        console: 'inherit',
                        sandbox: { nango },
                        require: {
                            external: true,
                            builtin: ['url', 'crypto']
                        }
                    });

                    const rootDir = getRootDir(optionalLoadLocation);
                    const scriptExports = vm.run(script as string, `${rootDir}/*.js`);

                    if (typeof scriptExports.default === 'function') {
                        const results = isAction ? await scriptExports.default(nango, input) : await scriptExports.default(nango);

                        return { success: true, error: null, response: results };
                    } else {
                        const content = `There is no default export that is a function for ${syncName}`;
                        if (activityLogId && writeToDb) {
                            await createActivityLogMessage({
                                level: 'error',
                                environment_id: environmentId,
                                activity_log_id: activityLogId,
                                content,
                                timestamp: Date.now()
                            });
                        }

                        return { success: false, error: new NangoError(content, 500), response: null };
                    }
                }
            } catch (err: any) {
                const errorType = isAction ? 'action_script_failure' : 'sync_script_failre';
                const { success, error, response } = formatScriptError(err, errorType, syncName);

                if (activityLogId && writeToDb) {
                    await createActivityLogMessage({
                        level: 'error',
                        environment_id: environmentId,
                        activity_log_id: activityLogId,
                        content: error.message,
                        timestamp: Date.now()
                    });
                }

                return { success, error, response };
            }
        } catch (err) {
            const errorMessage = JSON.stringify(err, ['message', 'name', 'stack'], 2);
            const content = `The script failed to load for ${syncName} with the following error: ${errorMessage}`;

            if (activityLogId && writeToDb) {
                await createActivityLogMessage({
                    level: 'error',
                    environment_id: environmentId,
                    activity_log_id: activityLogId,
                    content,
                    timestamp: Date.now()
                });
            }

            return { success: false, error: new NangoError(content, 500), response: null };
        } finally {
            delete this.runningScripts[syncId];
        }
    }

    private sendHeartbeat() {
        setInterval(() => {
            Object.keys(this.runningScripts).forEach((syncId) => {
                const context = this.runningScripts[syncId];

                context?.heartbeat();
            });
        }, 300000);
    }
}

async function startRunner(runnerId: string, port: number, client: any): Promise<ChildProcess> {
    let nodePath = '';
    try {
        nodePath = execSync('which node', { encoding: 'utf-8' }).trim();
    } catch (err) {
        throw new Error('Unable to find node');
    }

    const nangoRunnerPath = process.env['NANGO_RUNNER_PATH'] || '../runner/dist/bin/runner-bin.js';
    let providersPath = process.env['NANGO_PROVIDERS_PATH'] || '../shared/providers.yaml';

    // check if nsjail is available
    let cmd: string;
    let cmdOptions: string[];
    try {
        execSync('which nsjail', { encoding: 'utf-8' }).trim();
        cmd = 'nsjail';
        const runnerDir = nangoRunnerPath.split('/').slice(0, -1).join('/');
        const runnerFile = nangoRunnerPath.split('/').slice(-1)[0];

        const jailedRunnerDir = `/jailed`;
        const jailedRunnerLocation = `${jailedRunnerDir}/${runnerFile}`;
        const jailedProvidersPath = `/providers.yaml`;

        // prettier-ignore
        cmdOptions = [
            '-Mo',
            '--quiet', // Suppress nsjail informational messages
            '--disable_proc', // disable /proc inside the jail
            '--disable_clone_newnet', // Enable global networking inside the jail. TODO: to harden
            '--user', '1',
            '--group', '1',
            /* */
            '-R', '/lib', // required for node to run. TODO: figure out what are the required libs
            '-R', '/etc/resolv.conf', // required for dns resolution.
            '-R', `${path.resolve(process.cwd(), providersPath)}:${jailedProvidersPath}`,
            '-R', `${path.resolve(process.cwd(), runnerDir)}:${jailedRunnerDir}`,
            /* */
            '-R', `${nodePath}`,
            '--rlimit_nofile', '1000',
            // TODO: cap cpu and memory usage
            // '--use_cgroupv2',
            // '--cgroupv2_mount', '/sys/fs/cgroup',
            // '--cgroup_cpu_ms_per_sec', '500',
            // '--cgroup_mem_max', `${256 * 1024 * 1024}`, // 256MB
            '--env', 'HOME=/',
            '--env', `NANGO_DB_HOST=${process.env['NANGO_DB_HOST']}`,
            '--', // end of nsjail options
            nodePath,
            jailedRunnerLocation,
            port.toString(),
            runnerId
        ];
        providersPath = jailedProvidersPath;
    } catch (err) {
        cmd = nodePath;
        const runnerLocation = `${nangoRunnerPath}`;
        cmdOptions = [runnerLocation, port.toString(), runnerId];
    }
    console.log(`[Runner] Starting runner with command: ${cmd} ${cmdOptions.join(' ')} `);

    const childProcess = spawn(cmd, cmdOptions, {
        stdio: [null, null, null],
        env: { NANGO_PROVIDERS_PATH: `${providersPath}` }
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
    return childProcess;
}

export default new IntegrationService();
