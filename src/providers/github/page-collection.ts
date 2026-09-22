import {
  materializeGithubOperationRequest,
  type GithubObservationOperation,
  type MaterializedGithubOperationRequest,
} from './openapi.ts';

export interface GithubPageRead<T,E extends object> {
  members:readonly T[];
  evidence:E;
}

export type GithubPageEvidence<E extends object> = E & {
  page:number;
  member_count:number;
};

export type GithubPageScanResult<T,E extends object> =
  | {
      state:'matched';
      match:T;
      pages:Array<GithubPageEvidence<E>>;
    }
  | {
      state:'collection-end-observed';
      pages:Array<GithubPageEvidence<E>>;
    }
  | {
      state:'limit-reached';
      pages:Array<GithubPageEvidence<E>>;
    };

export function scanGithubPageCollection<T,E extends object>({
  operation,
  parameters,
  readPage,
  matches,
  maxPages=1000,
}:{
  operation:GithubObservationOperation;
  parameters:Record<string,string|number|boolean>;
  readPage:(input:{
    page:number;
    request:MaterializedGithubOperationRequest;
  })=>GithubPageRead<T,E>;
  matches:(member:T)=>boolean;
  maxPages?:number;
}):GithubPageScanResult<T,E> {
  const pagination=operation.pagination;
  if (!pagination || pagination.kind!=='page-number') {
    throw new Error(`GITHUB_OPERATION_PAGE_PAGINATION_UNAVAILABLE:${operation.operation_id}`);
  }
  if (
    !Number.isSafeInteger(pagination.first_page)
    || pagination.first_page<1
    || !Number.isSafeInteger(pagination.default_page_size)
    || pagination.default_page_size<1
  ) {
    throw new Error('GITHUB_PAGE_SCAN_METADATA_INVALID');
  }
  if (!Number.isSafeInteger(maxPages) || maxPages<1) {
    throw new Error('GITHUB_PAGE_SCAN_LIMIT_INVALID');
  }
  if (
    Object.hasOwn(parameters,pagination.page_parameter)
    || Object.hasOwn(parameters,pagination.page_size_parameter)
  ) {
    throw new Error('GITHUB_PAGE_SCAN_PAGINATION_PARAMETER_RESERVED');
  }

  const pages:Array<GithubPageEvidence<E>>=[];
  for (let offset=0;offset<maxPages;offset+=1) {
    const page=pagination.first_page+offset;
    const request=materializeGithubOperationRequest(operation,{
      ...parameters,
      [pagination.page_parameter]:page,
      [pagination.page_size_parameter]:pagination.default_page_size,
    });
    const observed=readPage({page,request});
    if (!Array.isArray(observed.members)) {
      throw new Error('GITHUB_PAGE_SCAN_MEMBERS_REQUIRED');
    }
    if (observed.members.length>pagination.default_page_size) {
      throw new Error('GITHUB_PAGE_SCAN_PAGE_OVERSIZED');
    }

    pages.push({
      ...observed.evidence,
      page,
      member_count:observed.members.length,
    });

    const match=observed.members.find(matches);
    if (match!==undefined) return {state:'matched',match,pages};
    if (observed.members.length<pagination.default_page_size) {
      return {state:'collection-end-observed',pages};
    }
  }

  return {state:'limit-reached',pages};
}
