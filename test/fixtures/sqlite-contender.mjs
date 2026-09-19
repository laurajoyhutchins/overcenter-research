import { SqliteFactStore } from '../../src/sqlite-store.ts';

const [database,expectedHead,label]=process.argv.slice(2);
if (!database || !expectedHead || !label) {
  throw new Error('usage: sqlite-contender.mjs DATABASE EXPECTED_HEAD LABEL');
}

const store=new SqliteFactStore(database);
try {
  const commit=store.append(
    expectedHead,
    `contender ${label}`,
    {'claim.json':{schema:'sqlite-contention-test',label}},
  );
  process.stdout.write(`${JSON.stringify({commit})}\n`);
} finally {
  store.close();
}
