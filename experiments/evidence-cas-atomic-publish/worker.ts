import { AtomicFileCas, evidenceBytes } from './store.ts';

const [dir,phaseArg='none']=process.argv.slice(2);
if (!dir) throw new Error('DIR_REQUIRED');
const phase=phaseArg==='none'
  ? null
  : phaseArg as 'after-temp-fsync'|'after-link-fsync';
const store=new AtomicFileCas(dir);
const result=store.put(evidenceBytes(),phase);
process.stdout.write(JSON.stringify(result));
