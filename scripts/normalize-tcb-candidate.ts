import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

interface TcbReportProperty {
  id: string;
  semantic_loc: number;
  surface_sha256: string;
  module_closure_semantic_loc: number;
  module_closure_sha256: string;
  hybrid_closure_semantic_loc: number;
  hybrid_closure_sha256: string;
}

interface TcbReportComposition {
  id: string;
  hybrid_union_semantic_loc: number;
  hybrid_union_sha256: string;
}

interface TcbReport {
  schema: 'overcenter-tcb-report';
  schema_version: 1;
  properties: TcbReportProperty[];
  compositions: TcbReportComposition[];
  obligations: Array<{ id: string }>;
}

interface TcbPolicyProperty extends Record<string, unknown> {
  id: string;
  max_semantic_loc: number;
  expected_surface_sha256?: string;
  max_module_closure_semantic_loc?: number;
  expected_module_closure_sha256?: string;
  max_hybrid_closure_semantic_loc?: number;
  expected_hybrid_closure_sha256?: string;
}

interface TcbPolicyComposition extends Record<string, unknown> {
  id: string;
  max_hybrid_union_semantic_loc?: number;
  expected_hybrid_union_sha256?: string;
}

interface TcbPolicy extends Record<string, unknown> {
  properties: TcbPolicyProperty[];
  compositions?: TcbPolicyComposition[];
}

function option(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith('--')) throw new Error(`TCB_NORMALIZE_OPTION_REQUIRED:${name}`);
  return value;
}

function runReport(root: string, output: string, write: boolean): ReturnType<typeof spawnSync> {
  const trustedScript = resolve(dirname(fileURLToPath(import.meta.url)), 'report-tcb.ts');
  return spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      trustedScript,
      ...(write ? ['--write'] : []),
      '--output',
      output,
    ],
    { cwd: root, encoding: 'utf8' },
  );
}

function readReport(path: string): TcbReport {
  if (!existsSync(path)) throw new Error('TCB_NORMALIZE_REPORT_MISSING');
  const value = JSON.parse(readFileSync(path, 'utf8')) as TcbReport;
  if (value.schema !== 'overcenter-tcb-report' || value.schema_version !== 1) {
    throw new Error('TCB_NORMALIZE_REPORT_INVALID');
  }
  return value;
}

const root = resolve(option('--root'));
const findingId = option('--finding');
const baselineSha = option('--baseline').toLowerCase();
if (!/^tcb:/.test(findingId)) throw new Error('TCB_NORMALIZE_FINDING_INVALID');
if (!/^[0-9a-f]{40}$/.test(baselineSha)) throw new Error('TCB_NORMALIZE_BASELINE_INVALID');

const scratch = mkdtempSync(join(tmpdir(), 'overcenter-tcb-normalize-'));
try {
  const initialPath = join(scratch, 'initial.json');
  runReport(root, initialPath, false);
  const initial = readReport(initialPath);

  const policyPath = join(root, 'tcb-policy.json');
  const policy = JSON.parse(readFileSync(policyPath, 'utf8')) as TcbPolicy;
  const propertyById = new Map(initial.properties.map((property) => [property.id, property]));
  for (const property of policy.properties) {
    const measured = propertyById.get(property.id);
    if (!measured) throw new Error(`TCB_NORMALIZE_PROPERTY_MISSING:${property.id}`);
    property.max_semantic_loc = measured.semantic_loc;
    property.expected_surface_sha256 = measured.surface_sha256;
    property.max_module_closure_semantic_loc = measured.module_closure_semantic_loc;
    property.expected_module_closure_sha256 = measured.module_closure_sha256;
    property.max_hybrid_closure_semantic_loc = measured.hybrid_closure_semantic_loc;
    property.expected_hybrid_closure_sha256 = measured.hybrid_closure_sha256;
  }

  const compositionById = new Map(
    initial.compositions.map((composition) => [composition.id, composition]),
  );
  for (const composition of policy.compositions ?? []) {
    const measured = compositionById.get(composition.id);
    if (!measured) throw new Error(`TCB_NORMALIZE_COMPOSITION_MISSING:${composition.id}`);
    composition.max_hybrid_union_semantic_loc = measured.hybrid_union_semantic_loc;
    composition.expected_hybrid_union_sha256 = measured.hybrid_union_sha256;
  }
  writeFileSync(policyPath, `${JSON.stringify(policy, null, 2)}\n`, 'utf8');

  const finalPath = join(scratch, 'final.json');
  const finalRun = runReport(root, finalPath, true);
  const final = readReport(finalPath);
  if (finalRun.status !== 0) {
    throw new Error(
      `TCB_NORMALIZE_FINAL_REPORT_FAILED:${String(finalRun.stderr || finalRun.stdout || '').trim()}`,
    );
  }

  const baselineRaw = execFileSync(
    'git',
    ['-C', root, 'show', `${baselineSha}:.overcenter/tcb-obligations.json`],
    { encoding: 'utf8' },
  );
  const baseline = JSON.parse(baselineRaw) as { obligations?: Array<{ id?: unknown }> };
  const baselineIds = new Set(
    (baseline.obligations ?? [])
      .map((item) => item.id)
      .filter((id): id is string => typeof id === 'string'),
  );
  if (!baselineIds.has(findingId)) throw new Error('TCB_NORMALIZE_FINDING_NOT_IN_BASELINE');

  const finalIds = new Set(final.obligations.map((item) => item.id));
  if (finalIds.has(findingId)) throw new Error('TCB_NORMALIZE_FINDING_STILL_PRESENT');
  const introduced = [...finalIds].filter((id) => !baselineIds.has(id)).sort();
  if (introduced.length > 0) {
    throw new Error(`TCB_NORMALIZE_NEW_DEBT:${introduced.join(',')}`);
  }

  process.stdout.write(
    `${JSON.stringify({
      schema: 'overcenter-tcb-normalization/v1',
      finding_id: findingId,
      baseline_sha: baselineSha,
      remaining_findings: [...finalIds].sort(),
    })}\n`,
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
