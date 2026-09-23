import fs from 'node:fs';

const files=process.argv.slice(2);
if (files.length!==6) throw new Error('expected three baseline/treatment pairs');
const parsed=files.map(file=>JSON.parse(fs.readFileSync(file,'utf8')));
const baseline=[parsed[0],parsed[3],parsed[4]];
const treatment=[parsed[1],parsed[2],parsed[5]];

function median(values) {
  const sorted=[...values].sort((a,b)=>a-b);
  return sorted[Math.floor(sorted.length/2)];
}
function metric(group,name) {
  return median(group.map(result=>result.summary[name].median));
}
for (const name of ['effect_reservation_ms','overcenter_local_ms']) {
  const b=metric(baseline,name);
  const t=metric(treatment,name);
  const ratio=t/b;
  console.log(`${name}: baseline=${b.toFixed(3)} treatment=${t.toFixed(3)} ratio=${ratio.toFixed(3)}`);
  if (ratio>1.10) throw new Error(`${name} regressed >10%: ${ratio.toFixed(3)}`);
}
console.log('PASS: same-runner production latency non-regression');
