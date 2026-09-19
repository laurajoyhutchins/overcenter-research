import { appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const [mode,arg='',pidFile='']=process.argv.slice(2);

function record(label,pid) {
  if (pidFile) appendFileSync(pidFile,`${label}:${pid}\n`);
}

if (mode==='env') {
  process.stdout.write(JSON.stringify(process.env));
} else if (mode==='large') {
  process.stdout.write('x'.repeat(Number.parseInt(arg,10)));
  process.stderr.write('y'.repeat(Number.parseInt(arg,10)));
} else if (mode==='sleep') {
  setTimeout(()=>process.stdout.write(arg),250);
} else if (mode==='tree-ignore-term') {
  record('parent',process.pid);
  process.on('SIGTERM',()=>{});
  const grandchild=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"],{
    stdio:'ignore',
  });
  record('grandchild',grandchild.pid);
  setInterval(()=>{},1000);
} else {
  process.stderr.write('unknown mode');
  process.exit(2);
}
