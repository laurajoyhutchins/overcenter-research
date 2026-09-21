import { githubStatusContextKey } from '../../src/providers/github-rest.ts';

type Expected={
  repositoryId:number;
  repositoryFullName:string;
  commitSha:string;
  context:string;
  state:'error'|'failure'|'pending'|'success';
};

const data=(value:unknown):value is Record<string,unknown> =>
  !!value && typeof value==='object' && !Array.isArray(value);

export function assertCombinedStatus(value:unknown,expected:Expected):void {
  if (!data(value)) throw new Error('COMBINED_STATUS_INVALID');
  if (value.sha!==expected.commitSha) throw new Error('COMBINED_STATUS_SHA_MISMATCH');

  const repository=value.repository;
  if (!data(repository)) throw new Error('COMBINED_STATUS_REPOSITORY_INVALID');
  if (repository.id!==expected.repositoryId) throw new Error('COMBINED_STATUS_REPOSITORY_ID_MISMATCH');
  if (typeof repository.full_name!=='string') throw new Error('COMBINED_STATUS_REPOSITORY_NAME_INVALID');
  if (repository.full_name.toLowerCase()!==expected.repositoryFullName.toLowerCase()) {
    throw new Error('COMBINED_STATUS_REPOSITORY_NAME_MISMATCH');
  }
  if (typeof repository.name!=='string' || !data(repository.owner) || typeof repository.owner.login!=='string') {
    throw new Error('COMBINED_STATUS_REPOSITORY_COORDINATE_INVALID');
  }
  if (`${repository.owner.login}/${repository.name}`.toLowerCase()!==repository.full_name.toLowerCase()) {
    throw new Error('COMBINED_STATUS_REPOSITORY_COORDINATE_MISMATCH');
  }

  if (!Array.isArray(value.statuses)) throw new Error('COMBINED_STATUS_STATUSES_INVALID');
  const target=githubStatusContextKey(expected.context);
  const match=value.statuses.find(member=>
    data(member)
    && typeof member.context==='string'
    && githubStatusContextKey(member.context)===target
  );
  if (!data(match)) throw new Error('COMBINED_STATUS_TARGET_MISSING');
  if (
    typeof match.id!=='number'
    || match.id<=0
    || typeof match.node_id!=='string'
    || match.node_id.length===0
  ) throw new Error('COMBINED_STATUS_IDENTITY_INVALID');
  if (match.state!==expected.state) throw new Error('COMBINED_STATUS_STATE_MISMATCH');
}
