#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function mergeFile(target, source, probeId) {
  if (target.source != null && source.source != null && target.source !== source.source) {
    throw new Error(`mutation shard source mismatch for ${probeId}`);
  }
  return {
    ...target,
    ...source,
    mutants: [
      ...(target.mutants ?? []),
      ...(source.mutants ?? []).map((mutant) => ({
        ...mutant,
        id: `${probeId}:${mutant.id}`,
      })),
    ],
  };
}

export function combineMutationShards(shards) {
  if (shards.length === 0) throw new Error('no mutation shards supplied');

  const probeIds = new Set();
  const files = {};
  const probes = [];
  let typescript = null;
  let report = null;

  for (const shard of shards) {
    if (probeIds.has(shard.probeId)) {
      throw new Error(`duplicate mutation shard: ${shard.probeId}`);
    }
    probeIds.add(shard.probeId);

    if (shard.ranges.probes?.length !== 1 || shard.ranges.probes[0].id !== shard.probeId) {
      throw new Error(`mutation shard range identity mismatch: ${shard.probeId}`);
    }
    if (typescript == null) typescript = shard.ranges.typescript;
    if (typescript !== shard.ranges.typescript) {
      throw new Error(`mutation shard TypeScript version mismatch: ${shard.probeId}`);
    }
    probes.push(shard.ranges.probes[0]);

    report ??= { ...shard.report };
    for (const [file, value] of Object.entries(shard.report.files ?? {})) {
      files[file] = mergeFile(files[file] ?? {}, value, shard.probeId);
    }
  }

  return {
    report: { ...report, files },
    ranges: {
      schema: 'overcenter-criticality-resolved-mutation-probes/v1',
      typescript,
      probes,
    },
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const directory = path.resolve(process.argv[2] ?? 'mutation-shards');
  const reportOutput = path.resolve(process.argv[3] ?? 'mutation.json');
  const rangesOutput = path.resolve(process.argv[4] ?? 'mutation-ranges.json');
  const reportFiles = fs
    .readdirSync(directory)
    .filter((name) => name.endsWith('.report.json'))
    .sort();
  const shards = reportFiles.map((name) => {
    const probeId = name.slice(0, -'.report.json'.length);
    return {
      probeId,
      report: JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')),
      ranges: JSON.parse(
        fs.readFileSync(path.join(directory, `${probeId}.ranges.json`), 'utf8'),
      ),
    };
  });
  const combined = combineMutationShards(shards);
  fs.writeFileSync(reportOutput, JSON.stringify(combined.report, null, 2) + '\n');
  fs.writeFileSync(rangesOutput, JSON.stringify(combined.ranges, null, 2) + '\n');
}
