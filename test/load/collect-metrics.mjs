// Samples queue depth, Postgres pressure and process/container resources
// every --interval seconds into <out>/metrics.csv until killed.
//   node test/load/collect-metrics.mjs --out <dir> --pid <appPid> [--containers chatbot-load-pg,chatbot-load-redis]
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadRedis, pg } from './lib.mjs';

const run = promisify(execFile);
const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, value, i, all) => {
    if (value.startsWith('--')) pairs.push([value.slice(2), all[i + 1]]);
    return pairs;
  }, []),
);
const out = `${args.out ?? 'load-results'}/metrics.csv`;
const interval = Number(args.interval ?? 5) * 1000;
const containers = (args.containers ?? 'chatbot-load-pg,chatbot-load-redis').split(',').filter(Boolean);
const redis = loadRedis();
const db = pg();

const COLUMNS = [
  'time', 'wait', 'active', 'delayed', 'completed', 'failed',
  'retry_wait', 'retry_active', 'retry_failed',
  'pg_conns', 'pg_active', 'pg_idle_tx', 'pg_lock_waits', 'pg_xact_commit', 'pg_xact_rollback', 'pg_deadlocks',
  'app_rss_mb', 'app_cpu', 'containers',
];
if (!existsSync(out)) appendFileSync(out, COLUMNS.join(',') + '\n');

async function queue(name) {
  const k = (s) => `bull:${name}:${s}`;
  const [wait, active, delayed, completed, failed, prioritized] = await Promise.all([
    redis.llen(k('wait')), redis.llen(k('active')), redis.zcard(k('delayed')),
    redis.zcard(k('completed')), redis.zcard(k('failed')), redis.zcard(k('prioritized')),
  ]);
  return { wait: wait + prioritized, active, delayed, completed, failed };
}

// CPU % of one core over the last interval (ps %cpu is a lifetime average).
const TICKS = 100;
let lastCpu;
function processUsage(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
    const ticks = Number(stat[11]) + Number(stat[12]);
    const rssMb = (Number(stat[21]) * 4096) / 1024 / 1024;
    const now = Date.now();
    const cpu = lastCpu ? (((ticks - lastCpu.ticks) / TICKS) / ((now - lastCpu.at) / 1000)) * 100 : 0;
    lastCpu = { ticks, at: now };
    return { rss: rssMb.toFixed(0), cpu: cpu.toFixed(1) };
  } catch {
    return { rss: '', cpu: '' };
  }
}

async function sample() {
  const [main, retry, conns, stat] = await Promise.all([
    queue('line-events'),
    queue('line-events-retry'),
    db.query(`select count(*)::int total,
                count(*) filter (where state='active')::int active,
                count(*) filter (where state like 'idle in transaction%')::int idle_tx,
                count(*) filter (where wait_event_type='Lock')::int lock_waits
              from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid()`),
    db.query(`select xact_commit::bigint c, xact_rollback::bigint r, deadlocks::bigint d
              from pg_stat_database where datname = current_database()`),
  ]);
  let rss = '', cpu = '';
  if (args.pid) ({ rss, cpu } = processUsage(args.pid));
  const docker = containers.length
    ? await run('docker', ['stats', '--no-stream', '--format', '{{.Name}}={{.CPUPerc}}/{{.MemUsage}}', ...containers])
        .then((r) => r.stdout.trim().split('\n').join(' ').replace(/,/g, ''))
        .catch(() => '')
    : '';
  const c = conns.rows[0];
  const s = stat.rows[0];
  appendFileSync(
    out,
    [
      new Date().toISOString(), main.wait, main.active, main.delayed, main.completed, main.failed,
      retry.wait, retry.active, retry.failed,
      c.total, c.active, c.idle_tx, c.lock_waits, s.c, s.r, s.d, rss, cpu, `"${docker}"`,
    ].join(',') + '\n',
  );
}

const stop = async () => {
  clearInterval(timer);
  await Promise.allSettled([db.end(), redis.quit()]);
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
const timer = setInterval(() => void sample().catch((e) => console.error('[metrics]', e.message)), interval);
void sample();
