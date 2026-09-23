import { FileEvidenceStore } from '../../src/evidence/file-store.ts';
import { SqliteFactStore } from '../../src/storage/sqlite.ts';

const [database, evidenceRoot, expectedHead, variant, phase = 'none'] = process.argv.slice(2);
if (!database || !evidenceRoot || !expectedHead || !variant) {
  throw new Error('ARGUMENTS_REQUIRED');
}

const payload = Buffer.from(`evidence:${variant}:` + 'x'.repeat(256 * 1024));
const evidence = new FileEvidenceStore(evidenceRoot);
const authority = new SqliteFactStore(database);

try {
  const ref = evidence.put(payload);
  if (phase === 'after-evidence') {
    process.kill(process.pid, 'SIGKILL');
    throw new Error('UNREACHABLE');
  }

  const commit = authority.append(expectedHead, `overcenter: reference evidence ${variant}`, {
    'evidence-ref.json': {
      schema: 'overcenter-evidence-reference',
      label: variant,
      ref,
    },
  });

  if (phase === 'after-authority' && commit) {
    process.kill(process.pid, 'SIGKILL');
    throw new Error('UNREACHABLE');
  }

  process.stdout.write(JSON.stringify({ commit, ref }));
} finally {
  authority.close();
}
