// Opt-in live evaluation: real AI requests, disposable DB/Redis, no live LINE.
// Run: node --env-file=.env test/product-test.mjs --live
import { spawnSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const diagnostics = process.argv.includes('--diagnostics');
if (!process.argv.includes('--live') && !diagnostics) {
  console.error('Use --live for 40 Fashion cases with real AI, or --diagnostics for DB checks without AI calls. See product-audit.md.');
  process.exit(2);
}
const run = randomUUID().slice(0, 8);
const containers = [];
function command(args, env = process.env, quiet = false) {
  const result = spawnSync(args[0], args.slice(1), { env, encoding: 'utf8', stdio: quiet ? 'pipe' : 'inherit' });
  if (result.status !== 0) throw new Error(`${args[0]} failed (exit ${result.status})`);
  return result.stdout?.trim();
}
async function container(image, port, extra = []) {
  const name = `product-audit-${port}-${run}`;
  command(['docker', 'run', '-d', '--rm', '--name', name, '-p', `127.0.0.1::${port}`, ...extra, image], process.env, true);
  containers.push(name);
  for (let i = 0; i < 80; i++) {
    const ready = spawnSync('docker', ['exec', name, ...(port === 5432 ? ['pg_isready', '-U', 'product_test'] : ['redis-cli', 'ping'])], { stdio: 'ignore' });
    if (ready.status === 0) break;
    await new Promise(r => setTimeout(r, 250));
  }
  return command(['docker', 'port', name, `${port}/tcp`], process.env, true).split(':').at(-1);
}
try {
  command(['npm', 'run', 'build']);
  const pg = await container('pgvector/pgvector:pg16', 5432, ['-e', 'POSTGRES_USER=product_test', '-e', 'POSTGRES_PASSWORD=synthetic_test', '-e', 'POSTGRES_DB=product_test']);
  const redis = await container('redis:7-alpine', 6379);
  const out = resolve(process.env.PRODUCT_TEST_OUT || `test/results/product-test-${run}`);
  mkdirSync(out, { recursive: true });
  const env = {
    ...process.env,
    DATABASE_URL: `postgresql://product_test:synthetic_test@127.0.0.1:${pg}/product_test`,
    REDIS_HOST: '127.0.0.1', REDIS_PORT: redis, REDIS_PASSWORD: '',
    PRODUCT_TEST_ISOLATED: run, PRODUCT_TEST_OUT: out,
    PRODUCT_TEST_DIAGNOSTICS: diagnostics ? '1' : '0',
    PRODUCT_ENABLED: 'true', PRODUCT_RAG_ENABLED: 'true', PRODUCT_SEMANTIC_ENABLED: diagnostics ? 'false' : 'true',
    COMMERCE_LEGACY_ADMIN_COMPANY_ID: '', JWT_SECRET: randomUUID(),
    AI_USER_LIMIT_PER_HOUR: '1000',
  };
  command(['node', 'node_modules/prisma/build/index.js', 'migrate', 'deploy'], env);
  const status = await new Promise((done, reject) => {
    const child = spawn('node', ['test/audit/product-test.cjs'], { env, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', code => done(code ?? 1));
  });
  console.log(`Report: ${out}/results.md`);
  process.exitCode = status;
} finally {
  for (const name of containers.reverse()) spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
}
