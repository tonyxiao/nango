interface ProxyConfig {
    connectionId: string;
    providerConfigKey: string;
    activityLogId: number;
    accountId: number;
    environmentId: number;

    isSync?: boolean;
    isDryRun?: boolean;
    retries?: number;
    baseUrlOverride?: string;

}

export class ProxyService {
}

export class ProxyCaller {

}
