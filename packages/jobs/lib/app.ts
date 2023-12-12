import { Temporal } from './temporal.js';
import { server } from './server.js';
import { featureFlags } from '@nangohq/shared';

try {
    const port = parseInt(process.env['NANGO_JOBS_PORT'] || '3005', 10);
    server.listen(port);
    console.log(`🚀 Jobs service ready at http://localhost:${port}`);

    const temporalNs = process.env['TEMPORAL_NAMESPACE'] || 'default';
    const temporal = new Temporal(temporalNs);

    // TODO: remove flag check once jobs is fully enabled by default
    setInterval(async () => {
        const isTemporalEnabled = await featureFlags.isEnabled('jobs-temporal', 'global', false);
        if (isTemporalEnabled) {
            temporal.start();
        } else {
            temporal.stop();
        }
    }, 5000);
} catch (err) {
    console.error(`[JOBS]: ${err}`);
    process.exit(1);
}
