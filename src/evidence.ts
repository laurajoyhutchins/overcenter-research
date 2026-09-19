import type {
  AbsenceEvidenceCertificate,
  Data,
} from './model.ts';

export const ABSENCE_EVIDENCE_SCHEMA='overcenter-absence-evidence-v1' as const;
export const LOCAL_FILE_ENOENT_EVIDENCE='local-file-enoent/v1' as const;

function isData(value:unknown):value is Data {
  return !!value && typeof value==='object' && !Array.isArray(value);
}

function exactKeys(
  value:Data,
  required:readonly string[],
  optional:readonly string[]=[],
):boolean {
  const allowed=new Set([...required,...optional]);
  return Object.keys(value).every(key=>allowed.has(key))
    && required.every(key=>Object.hasOwn(value,key));
}

export function validateAbsenceEvidenceEnvelope(
  value:unknown,
):asserts value is AbsenceEvidenceCertificate {
  if (!isData(value)) throw new Error('INVALID_ABSENCE_EVIDENCE');
  if (!exactKeys(value,[
    'schema','kind','subject','scope','snapshot','completeness','provenance',
  ])) throw new Error('INVALID_ABSENCE_EVIDENCE_SHAPE');
  if (value.schema!==ABSENCE_EVIDENCE_SCHEMA) {
    throw new Error('INVALID_ABSENCE_EVIDENCE_SCHEMA');
  }
  if (typeof value.kind!=='string' || value.kind.length===0) {
    throw new Error('INVALID_ABSENCE_EVIDENCE_KIND');
  }
  if (!isData(value.subject)) throw new Error('INVALID_ABSENCE_EVIDENCE_SUBJECT');
  if (!isData(value.scope)) throw new Error('INVALID_ABSENCE_EVIDENCE_SCOPE');
  if (value.snapshot!==null && !isData(value.snapshot)) {
    throw new Error('INVALID_ABSENCE_EVIDENCE_SNAPSHOT');
  }
  if (!isData(value.completeness)) {
    throw new Error('INVALID_ABSENCE_EVIDENCE_COMPLETENESS');
  }
  if (!isData(value.provenance)) {
    throw new Error('INVALID_ABSENCE_EVIDENCE_PROVENANCE');
  }
}

export function localFileEnoentEvidence(
  path:string,
):AbsenceEvidenceCertificate {
  return {
    schema:ABSENCE_EVIDENCE_SCHEMA,
    kind:LOCAL_FILE_ENOENT_EVIDENCE,
    subject:{kind:'file-path',path},
    scope:{
      kind:'exact-coordinate',
      coordinate:{kind:'file-path',path},
    },
    snapshot:null,
    completeness:{kind:'direct-coordinate-read',result:'ENOENT'},
    provenance:{
      adapter:'node:fs',
      operation:'readFileSync',
      error_code:'ENOENT',
    },
  };
}

export function localFileEnoentEvidenceMatches(
  value:unknown,
  path:string,
):value is AbsenceEvidenceCertificate {
  try {
    validateAbsenceEvidenceEnvelope(value);
  } catch {
    return false;
  }
  if (value.kind!==LOCAL_FILE_ENOENT_EVIDENCE) return false;
  if (!exactKeys(value.subject,['kind','path'])) return false;
  if (!exactKeys(value.scope,['kind','coordinate'])) return false;
  if (!isData(value.scope.coordinate)) return false;
  if (!exactKeys(value.scope.coordinate,['kind','path'])) return false;
  if (!exactKeys(value.completeness,['kind','result'])) return false;
  if (!exactKeys(value.provenance,['adapter','operation','error_code'])) return false;

  return value.subject.kind==='file-path'
    && value.subject.path===path
    && value.scope.kind==='exact-coordinate'
    && value.scope.coordinate.kind==='file-path'
    && value.scope.coordinate.path===path
    && value.snapshot===null
    && value.completeness.kind==='direct-coordinate-read'
    && value.completeness.result==='ENOENT'
    && value.provenance.adapter==='node:fs'
    && value.provenance.operation==='readFileSync'
    && value.provenance.error_code==='ENOENT';
}
