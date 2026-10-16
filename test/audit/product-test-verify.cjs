// Recheck saved live outputs without paying for another generation.
// Tightens completeness/number-boundary/clarification checks; preserves original report.
const { readFileSync, writeFileSync } = require('node:fs');
const { resolve, dirname, join } = require('node:path');
const { cases } = require('./product-test-data.cjs');
const path = resolve(process.argv[2]);
const saved = JSON.parse(readFileSync(path, 'utf8'));
const results = saved.results.map(row => {
  const expect = cases.find(c => c[0] === row.id)[2], t = row.turns.at(-1);
  const problems = row.problems.filter(p => p !== 'unverified fit guarantee');
  const answer = (t?.answer || '').replace(/,/g, '');
  if (expect.uniqueProducts && new Set((t?.evidence || []).map(e => e.productId)).size !== expect.uniqueProducts) problems.push('catalog list is incomplete');
  for (const text of expect.text || []) if (/^\d+$/.test(text) && !new RegExp(`(^|[^0-9])${text}(?:\\.00)?([^0-9]|$)`).test(answer)) problems.push(`answer missing numeric fact ${text}`);
  if (expect.clarify && t?.status === 'UNAVAILABLE') problems.push('insufficient input became UNAVAILABLE instead of clarification');
  if (expect.noFitGuarantee && !/ไม่|ยืนยัน|สอบถาม|เจ้าหน้าที่|ตาราง/.test(answer)) problems.push('fit uncertainty not explained; no false guarantee observed');
  return { id: row.id, initialPass: row.pass, pass: problems.length === 0, problems: [...new Set(problems)] };
});
const report = { source: path.split('/').slice(-2).join('/'), note: 'Reverification of the same saved live outputs. No new model calls. Initial assertions falsely accepted substring 500 in 4500 and generic fallback as clarification; category completeness was checked explicitly. Fit case is an unhelpful clarification, not a proven false guarantee.', passed: results.filter(r => r.pass).length, total: results.length, results };
writeFileSync(join(dirname(path), 'verification.json'), JSON.stringify(report, null, 2));
writeFileSync(join(dirname(path), 'verification.md'), ['# Reviewed live decisions', '', report.note, '', `**${report.passed}/${report.total} passed**`, '', '| Case | Result | Problems |', '| --- | --- | --- |', ...results.map(r => `| ${r.id} | ${r.pass ? 'PASS' : 'FAIL'} | ${r.problems.join('; ')} |`)].join('\n'));
console.log(`${report.passed}/${report.total} reviewed decisions passed`);
