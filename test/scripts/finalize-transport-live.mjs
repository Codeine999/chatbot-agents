// Merges manual verdicts into results.json, writes conversations.md + summary.json, updates manifest budget.
//   node test/scripts/finalize-transport-live.mjs <outDir>
import { readFileSync, writeFileSync } from 'node:fs';

const dir = process.argv[2];
const out = JSON.parse(readFileSync(`${dir}/results.json`, 'utf8'));
const manual = JSON.parse(readFileSync(`${dir}/manual-verdicts.json`, 'utf8'));
const cases = JSON.parse(readFileSync(`${dir}/cases.json`, 'utf8'));

for (const r of out.results) {
  r.planMode = r.commerceTurn?.plan?.plan?.mode ?? null; // plan snapshot is { plan, failed }
  r.planFailed = r.commerceTurn?.plan?.failed ?? null;
  const m = manual[r.id];
  if (m) r.manual = { verdict: m[0], note: m[1] };
}
writeFileSync(`${dir}/results.json`, JSON.stringify(out, null, 2));

const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : 'n/a');
const quant = (arr, q) => { const s = [...arr].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : null; };
const groups = {};
for (const r of out.results) {
  const g = (groups[r.group] ??= { run: 0, manualPass: 0, partial: 0, fail: 0, autoPass: 0, flowOk: 0 });
  g.run++;
  const v = r.manual?.verdict;
  if (v === 'PASS') g.manualPass++; else if (v === 'PARTIAL') g.partial++; else g.fail++;
  if (r.auto === 'PASS') g.autoPass++;
  if (r.verdict?.flowOk) g.flowOk++;
}
const total = { run: 0, manualPass: 0, partial: 0, fail: 0, autoPass: 0, flowOk: 0 };
for (const g of Object.values(groups)) for (const k of Object.keys(total)) total[k] += g[k];
const lat = out.results.map((r) => r.latencyMs).filter(Boolean);
const llmLat = out.results.filter((r) => (r.signals?.llmCallCount ?? 0) > 0).map((r) => r.latencyMs);
const planFails = out.results.filter((r) => r.signals?.fallbackReason === 'PRODUCT_PLAN_FAILED').map((r) => r.id);
const decoyOpenedTurn = out.results.filter((r) => r.group === 'decoy' && r.productFlowEntered).map((r) => r.id);
const decoyProductAnswer = out.results.filter((r) => r.group === 'decoy' && r.observed?.flow === 'PRODUCT').map((r) => r.id);
const productHandoff = out.results.filter((r) => r.expect.flow === 'PRODUCT' && (r.signals?.isFallback || r.meta?.handoff)).map((r) => r.id);
const llmByFlow = {};
for (const r of out.results) { const k = r.observed?.flow ?? '?'; (llmByFlow[k] ??= []).push(r.signals?.llmCallCount ?? 0); }
const llmAvg = Object.fromEntries(Object.entries(llmByFlow).map(([k, v]) => [k, { n: v.length, avg: +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(2) }]));
const answerModes = {};
for (const r of out.results) answerModes[r.signals?.answerMode ?? '?'] = (answerModes[r.signals?.answerMode ?? '?'] ?? 0) + 1;
const summary = {
  cases: cases.length, run: out.results.length, notRun: out.notRun,
  groups, total, rates: {
    manualStrict: pct(total.manualPass, total.run), manualWithPartial: pct(total.manualPass + total.partial, total.run),
    autoPass: pct(total.autoPass, total.run), flowOk: pct(total.flowOk, total.run),
  },
  latencyMs: { p50: quant(lat, 0.5), p90: quant(lat, 0.9), max: Math.max(...lat), p50WithLlm: quant(llmLat, 0.5), p90WithLlm: quant(llmLat, 0.9) },
  planFails, decoyOpenedTurn, decoyProductAnswer, productHandoff, llmAvg, answerModes, budget: out.budget, stopped: out.stopped,
};
writeFileSync(`${dir}/summary.json`, JSON.stringify(summary, null, 2));

// conversations.md
let md = `# Transcript: transport live audit\n\nbudget: chat used ${out.budget.final.usedChat}/${out.budget.cap}, embeddings used ${out.budget.final.usedEmbed}\n\n`;
const byConv = new Map();
for (const r of out.results) (byConv.get(r.conversation) ?? byConv.set(r.conversation, []).get(r.conversation)).push(r);
for (const [conv, list] of byConv) {
  md += `## ${conv}\n\n`;
  for (const r of list) {
    md += `### ${r.id} (turn ${r.turn}, ${r.group}) ${r.manual?.verdict ?? r.auto}\n`;
    md += `- ลูกค้า: ${r.text}\n`;
    md += `- บอท:\n\n\`\`\`\n${r.reply ?? r.error ?? ''}\n\`\`\`\n`;
    md += `- observed flow: **${r.observed?.flow}** (expected ${r.expect.flow}${r.expect.alt ? ' / alt ' + r.expect.alt.join(',') : ''}) | answerType=${r.signals?.answerType} answerMode=${r.signals?.answerMode} fallbackReason=${r.signals?.fallbackReason ?? '-'} handoff=${r.meta?.handoff} planMode=${r.planMode ?? '-'} commerceTurn=${r.commerceTurn?.id ?? '-'} llm=${r.signals?.llmCallCount} latency=${r.latencyMs}ms\n`;
    md += `- expected answer: ${r.expect.answer ?? ''}\n- judge: ${r.manual?.note ?? ''}\n\n`;
  }
}
if (out.notRun.length) md += `## NOT RUN (budget)\n\n${out.notRun.join(', ')}\n`;
writeFileSync(`${dir}/conversations.md`, md);

// manifest budget
const mpath = `${dir}/manifest.json`;
const manifest = JSON.parse(readFileSync(mpath, 'utf8'));
manifest.budget = { cap: out.budget.cap, baseline: out.budget.baseline, final: out.budget.final, stopped: out.stopped };
writeFileSync(mpath, JSON.stringify(manifest, null, 2));
console.log(JSON.stringify(summary, null, 2));
