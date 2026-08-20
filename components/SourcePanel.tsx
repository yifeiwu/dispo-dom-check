import { SOURCE_LABELS, SOURCE_ORDER, STATUS_LABELS } from '@/lib/api-types';
import type { SourceId } from '@/lib/collector';
import type { SourceStatus } from '@/lib/facts';

/**
 * What the score was and was not based on.
 *
 * This panel is the visible half of the never-block contract. A source that timed out or is rate limited
 * lowers confidence and contributes no points, and showing that plainly is what lets a reader trust a
 * mid-range score instead of assuming the tool found something.
 *
 * The same rows render while the analysis is still running, from the events the endpoint streams as each
 * source settles. One vocabulary for both: a source that timed out should not be described one way at
 * three seconds and another way at eight.
 */
const STATUS_TONE: Record<string, string> = {
  ok: 'text-accent',
  timeout: 'text-warn',
  rate_limited: 'text-warn',
  unavailable: 'text-danger',
  unsupported: 'text-ink-faint',
  skipped: 'text-ink-faint',
};

const DOT_TONE: Record<string, string> = {
  ok: 'bg-accent',
  timeout: 'bg-warn',
  rate_limited: 'bg-warn',
  unavailable: 'bg-danger',
  unsupported: 'bg-ink-faint',
  skipped: 'bg-ink-faint',
};

const ROW = 'grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 py-2 sm:grid-cols-[13rem_7rem_minmax(0,1fr)]';
const DETAIL = 'col-span-2 min-w-0 text-xs text-ink-faint sm:col-span-1';

const isRegistration = (source: SourceId): boolean => source === 'rdap' || source === 'whois';

/**
 * RDAP and WHOIS are two transports for the same record. Listing both makes a `.com` whose RDAP
 * answered look as though the registration record was also skipped. Show the one that actually spoke,
 * and wait until that is known rather than drawing a second row that will vanish.
 */
function pickRegistration(rdap?: SourceStatus, whois?: SourceStatus): SourceStatus | undefined {
  if (rdap?.status === 'ok') return rdap;
  if (whois?.status === 'ok') return whois;
  if (rdap && whois) return rdap.status !== 'skipped' ? rdap : whois.status !== 'skipped' ? whois : rdap;
  return undefined;
}

function collapseRegistration(sources: SourceStatus[]): SourceStatus[] {
  const registration = sources.filter((source) => isRegistration(source.source));
  if (registration.length <= 1) return sources;
  const shown =
    pickRegistration(
      registration.find((source) => source.source === 'rdap'),
      registration.find((source) => source.source === 'whois'),
    ) ?? registration[0];
  return sources.filter((source) => !isRegistration(source.source) || source === shown);
}

/**
 * Source order with the two registration protocols collapsed to one slot, derived from `SOURCE_ORDER`
 * so a new collector cannot land between them in the orchestrator and then appear twice here.
 */
const SOURCE_DISPLAY_ORDER: Array<SourceId | 'registration'> = SOURCE_ORDER.reduce<
  Array<SourceId | 'registration'>
>((order, source) => {
  if (isRegistration(source)) {
    if (!order.includes('registration')) order.push('registration');
  } else {
    order.push(source);
  }
  return order;
}, []);

function sourceDetail(status?: SourceStatus): string {
  if (!status) return '';
  if (status.reason) return status.reason;
  if (status.status === 'ok') return '';
  return `${status.elapsedMs} ms`;
}

function SourceRow({
  label,
  status,
  showDot,
}: {
  label: string;
  status?: SourceStatus;
  showDot?: boolean;
}) {
  return (
    <li className={ROW}>
      <span className="flex min-w-0 items-baseline gap-2 text-ink-muted">
        {showDot ? (
          <span
            aria-hidden
            className={`h-1.5 w-1.5 shrink-0 translate-y-[-1px] rounded-full ${
              status ? DOT_TONE[status.status] ?? 'bg-ink-faint' : 'animate-pulse bg-ink-faint'
            }`}
          />
        ) : null}
        {/* Wraps rather than truncates. "Registration record (RDAP/WHOIS)" does not fit the column, and
            a source panel whose whole purpose is saying what answered cannot elide which source. */}
        <span>{label}</span>
      </span>
      <span className={`text-right sm:text-left ${status ? STATUS_TONE[status.status] ?? '' : 'text-ink-faint'}`}>
        {status ? STATUS_LABELS[status.status] ?? status.status : 'Waiting'}
      </span>
      <span className={DETAIL}>{sourceDetail(status)}</span>
    </li>
  );
}

export function SourcePanel({ sources }: { sources: SourceStatus[] }) {
  return (
    <ul className="divide-y divide-edge text-sm">
      {collapseRegistration(sources).map((source) => (
        <SourceRow
          key={source.source}
          label={SOURCE_LABELS[source.source] ?? source.source}
          status={source}
        />
      ))}
    </ul>
  );
}

/**
 * The same list, drawn while the analysis is in flight.
 *
 * Every source is listed from the start, in the order they are run, so the list does not grow and shove
 * itself around under the reader. A source that has not settled is a pulsing dot; one that has is
 * exactly the row it will keep in the finished panel. The point is that a slow analysis is legible
 * rather than merely long: the reader can see which source is holding it up.
 */
export function SourceProgress({ settled }: { settled: SourceStatus[] }) {
  const byId = new Map(settled.map((status) => [status.source, status]));

  return (
    <ul className="divide-y divide-edge text-sm">
      {SOURCE_DISPLAY_ORDER.map((source) => {
        if (source === 'registration') {
          const status = pickRegistration(byId.get('rdap'), byId.get('whois'));
          return (
            <SourceRow
              key="registration"
              label={status ? (SOURCE_LABELS[status.source] ?? status.source) : 'Registration record'}
              status={status}
              showDot
            />
          );
        }

        return (
          <SourceRow
            key={source}
            label={SOURCE_LABELS[source] ?? source}
            status={byId.get(source)}
            showDot
          />
        );
      })}
    </ul>
  );
}
