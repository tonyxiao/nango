import { getLocalRunner } from './local.runner.js';

export async function getRunner(runnerId: string): Promise<Runner> {
    // TODO: render or local
    return getLocalRunner(runnerId);
}

export interface Runner {
    client: any;
    stop(): Promise<void>;
}
