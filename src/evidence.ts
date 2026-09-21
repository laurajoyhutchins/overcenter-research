import type { AbsenceEvidenceCertificate } from './model.ts';
import {ABSENCE_EVIDENCE_KINDS,OBSERVATION_SCHEMAS} from './generated/schema-identifiers.ts';
import { hasExactKeys as exactKeys, isData } from './validation.ts';

export const ABSENCE_EVIDENCE_SCHEMA=OBSERVATION_SCHEMAS.absenceEvidence;
export const LOCAL_FILE_ENOENT_EVIDENCE=ABSENCE_EVIDENCE_KINDS.localFileEnoent;

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
