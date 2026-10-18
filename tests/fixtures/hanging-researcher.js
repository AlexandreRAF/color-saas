import { spawn } from 'node:child_process';

for await (const chunk of process.stdin) { /* Drain the adapter input. */ }
const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
process.stdout.write(`${JSON.stringify({ type: 'progress', progress: { pid: process.pid, descendant: descendant.pid,
  hasDatabaseCredential: Boolean(process.env.DATABASE_URL), hasStripeCredential: Boolean(process.env.STRIPE_SECRET_KEY) } })}\n`);
setInterval(() => {}, 1000);
