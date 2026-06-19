export type GatewayErrorCategory =
  | 'validation_error'
  | 'missing_dataset'
  | 'unsupported_data_needs'
  | 'sandbox_module_error'
  | 'runner_failure'
  | 'internal_gateway_error';

export interface GatewayError {
  readonly category: GatewayErrorCategory;
  readonly code: string;
  readonly message: string;
}

export type ValidationStatus = 'accepted' | 'accepted_with_warnings' | 'rejected';

export interface ValidationIssue {
  readonly code: string;
  readonly severity: 'error' | 'warning';
  readonly path?: string;
  readonly message: string;
}

export interface ValidationReport {
  readonly status: ValidationStatus;
  readonly issues: readonly ValidationIssue[];
  readonly executed: false;
}
