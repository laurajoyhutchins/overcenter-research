import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const [allowedRead, outsideRead, allowedWrite, outsideWrite] = process.argv.slice(2);

function must(condition, message) {
  if (!condition) {
    console.error(message);
    process.exit(1);
  }
}

must(process.env.OVERCENTER_SANDBOX === 'landlock', 'sandbox marker missing');

must(fs.readFileSync(allowedRead, 'utf8').trim() === 'SAFE', 'allowed read failed');

let outsideReadDenied = false;
try {
  fs.readFileSync(outsideRead, 'utf8');
} catch (error) {
  outsideReadDenied = error?.code === 'EACCES' || error?.code === 'EPERM';
}
must(outsideReadDenied, 'outside read unexpectedly succeeded');

fs.writeFileSync(allowedWrite, 'TASK-WRITE\n');

let outsideWriteDenied = false;
try {
  fs.writeFileSync(outsideWrite, 'PWNED\n');
} catch (error) {
  outsideWriteDenied = error?.code === 'EACCES' || error?.code === 'EPERM';
}
must(outsideWriteDenied, 'outside write unexpectedly succeeded');

const cat = spawnSync('/bin/cat', [outsideRead], { encoding: 'utf8' });
must(cat.status !== 0, 'spawned child escaped filesystem sandbox');
must(!cat.stdout.includes('SECRET'), 'spawned child observed outside secret');

console.log('PASS');
console.log('node direct outside read: denied');
console.log('node direct outside write: denied');
console.log('spawned child outside read: denied');
