// This subprocess exists only for the process-crash integration test.
import { createApp } from '../server/app.mjs';
const app = await createApp({ dataDir: process.env.TEST_DATA_DIR, password: 'crash-test-password-42', logErrors: false });
console.log(JSON.stringify({ url: await app.listen(0) }));
process.on('SIGTERM', async () => { await app.close(); process.exit(0); });
