import type { CollectorStatus, SourceId } from './collector';
import type { CombinationResult } from './scoring/combinations';
import type { DimensionSubtotal, InapplicableSignal, ReasonFlag } from './scoring/score';
import type { ObservationResult } from './scoring/observations';
import type { SignalResult } from './scoring/signals';
import type { SourceStatus } from './facts';
import type { ProviderSuffix } from './data/provider-suffixes';
import type { Dimension, Verdict } from './scoring/weights';

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
  inapplicableSignals: InapplicableSignal[];
  observations: ObservationResult[];
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

/*
 * There is no `FLAG_LABELS` here any more.
 *
 * It supplied the headings for the pills that used to run under the verdict, and the pills went when
 * the result card was reduced to the gauge and the narrative. `flags` itself stays on the response
 * and is still derived and still tested, because it is the machine-readable half of the contract and
 * a caller filtering on `disposable` needs it whether or not this UI draws it. What went is one
 * presentation of it that nothing presents.
 */

/**
 * Keyed on `Dimension` for the reason `SOURCE_LABELS` is keyed on `SourceId`: a dimension added
 * without a heading should be a type error rather than a raw identifier rendered to a reader. The
 * components still fall back, since they render whatever a JSON response actually carried.
 */
export const DIMENSION_LABELS: Record<Dimension, string> = {
  signup: 'Signup capability',
  economics: 'Registration economics',
  age: 'Age and registration',
  mail: 'Mail posture',
  configuration: 'Configuration effort',
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

export const STATUS_LABELS: Record<CollectorStatus, string> = {
  ok: 'Answered',
  timeout: 'Timed out',
  rate_limited: 'Rate limited',
  unavailable: 'Unavailable',
  unsupported: 'Not applicable',
  skipped: 'Skipped',
};

/**
 * Looking a heading up, for a key that came off a JSON response rather than out of the registry.
 *
 * The tables above are keyed on their union types so that adding a dimension, source or status
 * without a heading fails to compile. The components cannot promise the same, because they render
 * whatever a payload actually carried — an older or newer service answering this page is a thing that
 * happens. Falling back to the raw identifier is right for that, and writing the fallback at each of
 * the eleven call sites was the version that let three of them quietly disagree about whether there
 * was one at all.
 */
const labelled =
  <K extends string>(table: Record<K, string>) =>
  (key: string): string =>
    (table as Record<string, string | undefined>)[key] ?? key;

export const dimensionLabel = labelled(DIMENSION_LABELS);
export const sourceLabel = labelled(SOURCE_LABELS);
export const statusLabel = labelled(STATUS_LABELS);
