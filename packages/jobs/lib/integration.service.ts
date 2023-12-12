import type { Context } from '@temporalio/activity';
import type { Runner } from './runner/runner.js';
import {
    IntegrationServiceInterface,
    createActivityLogMessage,
    NangoIntegrationData,
    NangoProps,
    localFileService,
    remoteFileService,
    isCloud,
    ServiceResponse,
    NangoError,
    formatScriptError
} from '@nangohq/shared';
import { getRunner } from './runner/runner.js';

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

            try {
                if (temporalContext) {
                    this.runningScripts[syncId] = temporalContext;
                }
                let runner: Runner | undefined = undefined;
                try {
                    const runnerId = `${syncName}:${nangoProps.connectionId}:${nangoProps.providerConfigKey}:${environmentId}`; // TODO
                    runner = await getRunner(runnerId);

                    // TODO: does this need to be synchronous? Add timeout if yes?
                    const res = await runner.client.run.mutate({ nangoProps, code: script as string, codeParams: input as object, isAction });
                    return { success: true, error: null, response: res };
                } catch (err) {
                    const errMsg = `There was an error running integration '${syncName}': ${err}`;
                    return { success: false, error: new NangoError(errMsg, 500), response: null };
                } finally {
                    if (runner) {
                        await runner.stop();
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

export default new IntegrationService();
