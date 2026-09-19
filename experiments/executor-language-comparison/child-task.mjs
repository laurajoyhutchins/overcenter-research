import { appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const [mode,result='',pidFile='']=process.argv.slice(2);

function record(label,pid) {
  if (pidFile) appendFileSync(pidFile,`${label}:${pid}\n`);
}

record('parent',process.pid);

if (mode==='complete') {
  process.stdout.write(result);
  process.exit(0);
}

if (mode==='fail') {
  process.stderr.write('synthetic child failure');
  process.exit(17);
}

if (mode==='hang') {
  setInterval(()=>{},1000);
} else if (mode==='grandchild-hang' || mode==='grandchild-ignore-term') {
  if (mode==='grandchild-ignore-term') {
    process.on('SIGTERM',()=>{});
  }
  const grandchildProgram=mode==='grandchild-ignore-term'
    ? "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"
    : "setInterval(()=>{},1000)";
  const grandchild=spawn(process.execPath,['-e',grandchildProgram],{
    detached:false,
    stdio:'ignore',
  });
  record('grandchild',grandchild.pid);
  setInterval(()=>{},1000);
} else {
  process.stderr.write(`unknown mode: ${mode}`);
  process.exit(2);
}
