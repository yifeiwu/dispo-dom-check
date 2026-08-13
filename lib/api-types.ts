import type { SourceId } from './collector';
import type { CombinationResult } from './scoring/combinations';
import type { DimensionSubtotal, ReasonFlag } from './scoring/score';
import type { SignalResult } from './scoring/signals';
import type { SourceStatus } from './facts';
import type { ProviderSuffix } from './data/provider-suffixes';
import type { Verdict } from './scoring/weights';

/** The response contract, shared by the route and the client so the two cannot drift apart. */
export type AnalyzeResponse = {
  domain: string;
  submittedHost: string;
  inputWasEmailAddress: boolean;
  analysedAt: string;
  elapsedMs: number;
  modelVersion: string;
  legitimacy: number;
  risk: number;
  confidence: number;
  verdict: Verdict;
  verdictLabel: string;
  verdictDescription: string;
  narrative: string;
  flags: ReasonFlag[];
  firstSeen?: { date: string; source: string };
  ageDays?: number;
  dimensions: DimensionSubtotal[];
  signals: SignalResult[];
  inapplicableSignals: { id: string; label: string; rationale: string }[];
  combinations: CombinationResult[];
  sources: SourceStatus[];
  providerSuffix?: ProviderSuffix;
};

export type OutOfScopeResponse = {
  domain: string;
  outOfScope: { reason: string; explanation: string };
  verdict: 'out_of_scope';
  verdictLabel: string;
  verdictDescription: string;
  modelVersion: string;
};

export type ErrorResponse = {
  error: string;
  message: string;
  /** The underlying fault, when there is one worth naming. Present only on a service error. */
  detail?: string;
};

export type ApiResult = AnalyzeResponse | OutOfScopeResponse | ErrorResponse;

export function isError(result: ApiResult): result is ErrorResponse {
  return 'error' in result;
}

export function isOutOfScope(result: ApiResult): result is OutOfScopeResponse {
  return 'outOfScope' in result;
}

/**
 * The media type that opts a caller into progress. Requested rather than default, because the plain
 * JSON body is the endpoint's published contract and a caller that never asked for a stream must not be
 * handed one.
 */
export const NDJSON_MEDIA_TYPE = 'application/x-ndjson';

/**
 * What the streaming form of the endpoint emits, one JSON object per line.
 *
 * A `source` carries exactly the `SourceStatus` that will appear in the final result, so a progress view
 * and the finished `Sources` panel cannot describe the same source differently. Exactly one terminal
 * event arrives last: `result` or `error`, never both and never neither.
 */
export type AnalyzeStreamEvent =
  | ({ type: 'source' } & SourceStatus)
  | ({ type: 'result' } & AnalyzeResponse)
  | ({ type: 'error' } & ErrorResponse);

export const FLAG_LABELS: Record<ReasonFlag, string> = {
  disposable: 'Disposable mail',
  forwarder: 'Alias forwarder',
  catch_all_capable: 'Catch-all capable',
  no_mx: 'No inbound mail',
  too_new: 'Very new',
  provider_subdomain: 'Platform subdomain',
  free_subdomain: 'Free subdomain',
  parked: 'Parked',
  farm_profile: 'Farm profile',
  registrar_default: 'Registrar-default profile',
  registry_hold: 'Registry hold',
};

export const DIMENSION_LABELS: Record<string, string> = {
  signup: 'Signup capability',
  economics: 'Registration economics',
  age: 'Age and registration',
  mail: 'Mail posture',
  configuration: 'Configuration effort',
  footprint: 'Organisational footprint',
  site: 'Site existence',
  name: 'Name pattern',
};

/**
 * Keyed on `SourceId` so a new source cannot be added without being given a heading here. The
 * components keep a fallback anyway, since they render whatever a JSON response actually carried.
 */
export const SOURCE_LABELS: Record<SourceId, string> = {
  rdap: 'Registration record (RDAP)',
  whois: 'Registration record (WHOIS)',
  dns: 'DNS',
  mail: 'Mail configuration',
  signup: 'Mail provider class',
  pricing: 'Suffix pricing',
  site: 'Site probe',
  checkmail: 'Reputation (Check-Mail)',
};

/**
 * The order the orchestrator runs its sources in, which is the order the progress view lists them so a
 * reader watching one land after another is not also watching the list reorder itself. The finished
 * panel renders whatever order the response carried, which is this one.
 */
export const SOURCE_ORDER: SourceId[] = [
  'dns',
  'rdap',
  'whois',
  'mail',
  'pricing',
  'site',
  'checkmail',
  'signup',
];

export const STATUS_LABELS: Record<string, string> = {
  ok: 'Answered',
  timeout: 'Timed out',
  rate_limited: 'Rate limited',
  unavailable: 'Unavailable',
  unsupported: 'Not applicable',
  skipped: 'Skipped',
};
