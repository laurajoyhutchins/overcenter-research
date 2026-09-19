import assert from 'node:assert/strict';
import {
  existsSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

function sourceFiles(root:string):string[] {
  if (!existsSync(root)) return [];
  const files:string[]=[];
  for (const entry of readdirSync(root,{withFileTypes:true})) {
    const path=join(root,entry.name);
    if (entry.isDirectory()) {
      files.push(...sourceFiles(path));
    } else if (/\.(?:ts|js)$/.test(entry.name)) {
      files.push(path);
    }
  }
  return files;
}

test('project state has one production projection path',()=>{
  const legacyEligibility=['eligibility','.ts'].join('');
  const legacyLifecycleModule=['lifecycle','.ts'].join('');
  const legacyLifecycleDeriver=['derive','Lifecycles'].join('');
  const legacyHistoryLifecycle=['history','.lifecycles'].join('');
  const legacyAdmissibilitySet=['admissible','RealizationRuns'].join('');
  for (const removed of [legacyEligibility,legacyLifecycleModule]) {
    const removedPath=join('src',removed);
    assert.equal(
      existsSync(removedPath),
      false,
      `${removedPath} must stay deleted; projection has one production path`,
    );
  }

  const violations:Array<{file:string;symbol:string}>=[];
  for (const file of [
    ...sourceFiles('src'),
    ...sourceFiles('test'),
    ...sourceFiles('experiments'),
  ]) {
    const source=readFileSync(file,'utf8');
    if (source.includes(legacyEligibility)) {
      violations.push({file,symbol:legacyEligibility});
    }
    if (source.includes(legacyLifecycleModule)) {
      violations.push({file,symbol:legacyLifecycleModule});
    }
    if (source.includes(legacyLifecycleDeriver)) {
      violations.push({file,symbol:legacyLifecycleDeriver});
    }
    if (source.includes(legacyHistoryLifecycle)) {
      violations.push({file,symbol:legacyHistoryLifecycle});
    }
    if (source.includes(legacyAdmissibilitySet)) {
      violations.push({file,symbol:legacyAdmissibilitySet});
    }
  }

  assert.deepEqual(
    violations,
    [],
    'project state and current realization judgments must have one production path',
  );
});
