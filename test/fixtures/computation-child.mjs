import { appendFileSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { request } from 'node:http';

const [mode,arg='',pidFile='']=process.argv.slice(2);

function record(label,pid) {
  if (pidFile) appendFileSync(pidFile,`${label}:${pid}\n`);
}

function postThenWrite(url,markerPath,delayMs) {
  const req=request(url,{method:'POST'},response=>{
    response.resume();
    response.once('end',()=>{
      setTimeout(()=>{
        writeFileSync(markerPath,'passed');
        process.stdout.write('network-effect-complete');
      },delayMs);
    });
  });
  req.once('error',error=>{ throw error; });
  req.end('effect');
}

function runNodeTest(testPath,markerPath) {
  const result=spawnSync(
    process.execPath,
    ['--experimental-strip-types','--test',testPath],
    {stdio:'inherit',env:{}},
  );
  if (result.error) throw result.error;
  if (result.status!==0) process.exit(result.status??1);
  writeFileSync(markerPath,'passed');
  process.stdout.write('test-workload-complete');
}

if (mode==='env') {
  process.stdout.write(JSON.stringify(process.env));
} else if (mode==='large') {
  process.stdout.write('x'.repeat(Number.parseInt(arg,10)));
  process.stderr.write('y'.repeat(Number.parseInt(arg,10)));
} else if (mode==='sleep') {
  setTimeout(()=>process.stdout.write(arg),250);
} else if (mode==='write-file') {
  writeFileSync(pidFile,arg);
  process.stdout.write('test-workload-complete');
} else if (mode==='delayed-write-file') {
  setTimeout(()=>{
    writeFileSync(pidFile,arg);
    process.stdout.write('test-workload-complete');
  },1000);
} else if (mode==='node-test') {
  runNodeTest(arg,pidFile);
} else if (mode==='delayed-node-test') {
  setTimeout(()=>runNodeTest(arg,pidFile),1000);
} else if (mode==='symlink-file') {
  symlinkSync(arg,pidFile);
  process.stdout.write('symlink-created');
} else if (mode==='network-effect-then-write') {
  postThenWrite(arg,pidFile,1500);
} else if (mode==='detect-git-auth') {
  const config=readFileSync(arg,'utf8');
  const present=/authorization|extraheader/i.test(config);
  writeFileSync(pidFile,present?'present':'absent');
  process.stdout.write('credential-check-complete');
} else if (
  mode==='tree-ignore-term'
  || mode==='tree-child-ignore-term'
  || mode==='tree-detached-ignore-term'
) {
  record('parent',process.pid);
  if (mode!=='tree-child-ignore-term') {
    process.on('SIGTERM',()=>{});
  }
  const detached=mode==='tree-detached-ignore-term';
  const grandchild=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"],{
    detached,
    stdio:detached?'inherit':'ignore',
  });
  if (detached) grandchild.unref();
  record('grandchild',grandchild.pid);
  setInterval(()=>{},1000);
} else if (mode==='detached-child-exit') {
  record('parent',process.pid);
  const grandchild=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"],{
    detached:true,
    stdio:'inherit',
  });
  grandchild.unref();
  record('grandchild',grandchild.pid);
} else {
  process.stderr.write('unknown mode');
  process.exit(2);
}
