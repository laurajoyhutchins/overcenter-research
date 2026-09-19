export type ObservationVisibility = 'observed' | 'not-observed' | 'indeterminate';

export interface ObservationObserver {
  kind: string;
  id: string;
}

export interface ProviderObservation<
  Provider extends string,
  Request,
  Response,
  OutcomeExtra extends object = object,
> {
  contract: {
    provider: Provider;
    api_version: string;
    operation_id: string;
    schema_sha256: string;
  };
  observer: ObservationObserver;
  observed_at: string;
  request: Request;
  response: Response;
  outcome: {
    status: number;
    visibility: ObservationVisibility;
    value?: unknown;
    transport_error?: string;
  } & OutcomeExtra;
}
