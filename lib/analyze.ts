import { BUDGET } from './budget';
import { withDeadline } from './deadline';
import { isOk, runCollector, type CollectorResult, type SourceId } from './collector';
import { collectDns } from './collect/dns';
import { collectRdap } from './collect/rdap';
import { collectWhois } from './collect/whois';
import { collectMail } from './collect/mail';
import { collectSignup } from './collect/signup';
import { collectPricing } from './collect/pricing';
import { collectSite } from './collect/site';
import { collectCheckMail } from './collect/checkmail';
import { detectRegistrarDefault } from './data/registrar-defaults';
import { hasRecordingContext } from './record';
import {
  toSourceStatus,
  type CheckMailFacts,
  type DomainFacts,
  type PricingFacts,
  type RegistrationFacts,
  type SourceStatus,
} from './facts';
import { nameFacts } from './scoring/signals';
import { score, type ScoreResult } from './scoring/score';
import { DEFAULT_CONFIG } from './scoring/weights';
import type { NormalisedInput } from './domain';

/**
 * Orchestration, and the place the never-block contract is actually enforced.
 *
 * Collectors run concurrently under `Promise.allSettled` with a per-source deadline and a global
 * deadline. Whatever finished is scored; whatever did not is recorded with a status and a reason and
 * contributes no points. There is no path here that turns a source failure into a worse verdict.
 *
 * The dependency shape is why this is not simply one `Promise.all`: mail classification needs the MX
 * records, so DNS runs first and the rest fan out from it. DNS is therefore the one source whose loss
 * costs several dimensions, which is why two resolvers are tried inside that collector.
 */

export type AnalysisResult = {
  domain: string;
  submittedHost: string;
  fromEmailAddress: boolean;
  analysedAt: string;
  elapsedMs: number;
  facts: DomainFacts;
  score: ScoreResult;
};

export type AnalysisOptions = {
  /**
   * Called as each source settles, for a caller that wants to report progress before the analysis is
   * finished. Purely an observer: it cannot alter the result, and the same statuses appear in
   * `facts.sources` regardless of whether it is supplied.
   */
  onSource?: (status: SourceStatus) => void;
};

/**
 * No domain-specific result is cached anywhere: every domain is analysed from scratch on every request.
 * The only cached thing in the system is the registry bootstrap, held for the process lifetime by
 * `lib/reference-cache.ts`, which the RDAP collector reaches directly.
 */
export async function analyze(
  input: Extract<NormalisedInput, { kind: 'ok' }>,
  options: AnalysisOptions = {},
): Promise<AnalysisResult> {
  /*
   * The global budget, as a thing that actually stops work rather than only as arithmetic.
   *
   * `remaining()` below shrinks the deadline given to each collector that has not started yet, which
   * keeps the total honest but cannot touch a request already in flight. Without this, a source that
   * began just inside the budget held its socket open behind a response that had already been returned.
   *
   * The abort in `finally` covers the ordinary path rather than the timeout: by the time an analysis
   * returns, every collector it is going to report has settled, and anything still running belongs to
   * nobody. The registry bootstrap is the deliberate exception and detaches itself — see
   * `lib/reference-cache.ts`.
   */
  const deadline = new AbortController();
  const expiry = setTimeout(() => deadline.abort(), BUDGET.globalMs);

  try {
    return await withDeadline(deadline.signal, () => runAnalysis(input, options));
  } finally {
    clearTimeout(expiry);
    deadline.abort();
  }
}

async function runAnalysis(
  input: Extract<NormalisedInput, { kind: 'ok' }>,
  options: AnalysisOptions,
): Promise<AnalysisResult> {
  const startedAt = Date.now();
  const analysedAt = new Date().toISOString();

  const remaining = () => Math.max(500, BUDGET.globalMs - (Date.now() - startedAt));
  const perSource = () => Math.min(BUDGET.perSourceMs, remaining());
  const siteSource = () => Math.min(BUDGET.siteMs, remaining());

  const sources: SourceStatus[] = [];
  const record = (result: CollectorResult<unknown>) => {
    sources.push(toSourceStatus(result));
    return result;
  };

  /**
   * Per-source notification, hooked to the promise rather than to `record`.
   *
   * The second wave is only recorded once `Promise.allSettled` has resolved, so recording is the wrong
   * place to observe a source landing: all four would report together at the end of the wave, which is
   * precisely the thing a progress caller is trying to avoid showing. Attaching here reports each source
   * when it actually settles. `record` still runs afterwards and still builds `sources` in a fixed
   * order, so what the analysis returns does not depend on the order things came back in.
   */
  const notify = <T>(pending: Promise<CollectorResult<T>>): Promise<CollectorResult<T>> => {
    const { onSource } = options;
    if (!onSource) return pending;

    pending.then(
      (result) => {
        try {
          onSource(toSourceStatus(result));
        } catch {
          // A consumer that has gone away — a closed response stream is the expected case — must not be
          // able to fail an analysis that is otherwise proceeding normally.
        }
      },
      // `runCollector` converts its own failures, so this is unreachable short of a bug. It is attached
      // anyway, because an unhandled rejection here would be a crash rather than a missing status.
      () => {},
    );
    return pending;
  };

  // Registration age is meaningless for a platform-issued name, so those sources are skipped with a
  // reason rather than queried and discarded.
  const providerScoped = Boolean(input.providerSuffix);

  // First wave: the two fast sources everything else depends on. DNS gates the mail collectors, which
  // cannot classify anything without MX records.
  const [dnsResult, rdapResult] = await Promise.all([
    notify(
      runCollector('dns', 'https://dns.google/resolve', () =>
        collectDns(input.domain, perSource()),
      ),
    ),
    notify(
      providerScoped
        ? skipped<RegistrationFacts>(
            'rdap',
            `Registration belongs to ${input.providerSuffix?.provider}, not to this name`,
          )
        : runFactCollector('rdap', () => collectRdap(input.domain, input.suffix, perSource())),
    ),
  ]);
  record(dnsResult);
  record(rdapResult);
  const dns = isOk(dnsResult) ? dnsResult.data : undefined;

  /**
   * Port 43 runs where RDAP has not produced an answer: either the suffix has no RDAP service at all,
   * which `unsupported` is precisely the statement of, or the server exists and did not respond.
   *
   * The second case was previously excluded, on the reasoning that a failed request is not a missing
   * protocol and retrying it over the slowest transport in the system would re-ask a question already
   * asked of the better source. The measurement says otherwise on both halves. The question is not
   * answered — 14% of the labelled holdout got no registration record this way — and it is not a
   * transient failure either: the registries responsible rate limit by dropping the connection rather
   * than returning a status, so every domain under them stalls identically until the deadline fires, and
   * `rate_limited` never appears. Since age is the heaviest-weighted signal in the model, that is the
   * most expensive gap available to close.
   *
   * `unavailable` is deliberately not included. That is a registry that answered and said no, which is
   * an answer, and port 43 agrees with it.
   *
   * It rides in the second wave rather than after the first. Nothing downstream depends on it, so
   * serialising it behind RDAP would add its whole deadline to the critical path of every ccTLD lookup
   * for no ordering benefit. That placement is also why the retry is free: the wave is already bounded
   * by the site probe's longer deadline, so a WHOIS attempt beside it adds no wall-clock time at all.
   */
  const rdapAnswered = rdapResult.status !== 'timeout' && rdapResult.status !== 'rate_limited';
  const whoisApplies = !providerScoped && (rdapResult.status === 'unsupported' || !rdapAnswered);
  const whoisMs = Math.min(BUDGET.whoisMs, remaining());

  // Taken once so that the collector's own budget and the deadline enforcing it are the same number.
  // Given them separately, the deadline was the smaller of the two and cut the collector off mid-chain.
  const siteMs = siteSource();
  const checkmailMs = Math.min(BUDGET.checkmailMs, remaining());

  const [whoisResult, mailResult, pricingResult, siteResult, checkmailResult] = await Promise.allSettled([
    notify(
      whoisApplies
        ? runFactCollector('whois', () => collectWhois(input.domain, input.suffix, whoisMs), whoisMs)
        : skipped<RegistrationFacts>(
            'whois',
            providerScoped
              ? `Registration belongs to ${input.providerSuffix?.provider}, not to this name`
              : `The .${input.suffix} registry publishes RDAP, which was used instead`,
          ),
    ),
    notify(
      runCollector('mail', 'https://dns.google/resolve', () =>
        collectMail(input.domain, dns, perSource()),
      ),
    ),
    notify(
      providerScoped
        ? skipped<PricingFacts>(
            'pricing',
            `This name has no registry price: it was issued by ${input.providerSuffix?.provider}`,
          )
        : // A committed snapshot rather than a network call, so this needs no deadline of its own.
          runFactCollector('pricing', async () => collectPricing(input.suffix)),
    ),
    notify(
      runCollector(
        'site',
        `https://${input.domain}/`,
        () => collectSite(input.domain, dns, siteMs),
        siteMs,
      ),
    ),
    /*
     * The one metered source, and the only one excluded from a recorded or replayed analysis.
     *
     * A calibration collection probes several thousand domains, against a monthly allowance of one
     * thousand lookups. Running it there would exhaust the budget in a single pass and produce a
     * holdout whose reputation column is mostly `rate_limited` — worse than having no column, because
     * it would look measured. Gating on the recording context rather than on a flag means a
     * calibration run cannot spend the quota by forgetting to opt out.
     *
     * Unlike `rdap` and `pricing` this is *not* skipped for a platform-issued name. The vendor answers
     * about the parent, which for a free-subdomain provider is frequently the most informative thing
     * available; the scorer names the parent in its evidence so the reader is not misled.
     */
    notify(
      hasRecordingContext()
        ? skipped<CheckMailFacts>(
            'checkmail',
            'Metered source, not queried during a recorded or replayed run',
          )
        : runFactCollector(
            'checkmail',
            () => collectCheckMail(input.domain, checkmailMs),
            checkmailMs,
          ),
    ),
  ]);

  const whois = settled(whoisResult, record);
  const mail = settled(mailResult, record);
  const pricing = settled(pricingResult, record);
  const site = settled(siteResult, record);
  const checkmail = settled(checkmailResult, record);

  // One field regardless of protocol, so every registration signal reads the same shape.
  const registration = (isOk(rdapResult) ? rdapResult.data : undefined) ?? whois;

  // Mail classification depends on both DNS and the parsed SPF record, so it runs last and cheaply.
  const signupResult = await notify(
    runCollector('signup', undefined, () =>
      collectSignup(input.domain, dns, mail?.spf, Math.min(BUDGET.signupMs, remaining())),
    ),
  );
  record(signupResult);
  const signup = isOk(signupResult) ? signupResult.data : undefined;

  const facts: DomainFacts = {
    meta: {
      domain: input.domain,
      suffix: input.suffix,
      label: input.label,
      submittedHost: input.submittedHost,
      fromEmailAddress: input.fromEmailAddress,
      providerSuffix: input.providerSuffix,
      relayDomain: input.relayDomain,
      vettedSuffix: input.vettedSuffix,
      analysedAt,
    },
    registration,
    dns,
    mail,
    signup,
    registrarDefault: detectRegistrarDefault(registration, dns, signup),
    pricing,
    site,
    checkmail,
    name: nameFacts(input.label),
    sources,
  };

  return {
    domain: input.domain,
    submittedHost: input.submittedHost,
    fromEmailAddress: input.fromEmailAddress,
    analysedAt,
    elapsedMs: Date.now() - startedAt,
    facts,
    score: score(facts, DEFAULT_CONFIG),
  };
}

/**
 * Runs a collector that returns an envelope around its facts, and flattens it into the result.
 *
 * The collectors come in two shapes. Most return their facts alone, because the orchestrator already
 * knows where they went; the registration and reputation sources cannot, because they resolve their
 * own endpoint — RDAP per suffix, WHOIS per registry — or have something to say about an answer they
 * did give. Both extras belong on the `CollectorResult` rather than inside the facts, so they are
 * lifted here.
 *
 * `notice` becoming `reason` is the part worth naming. A registry can answer in full and publish no
 * registration date, and without the note the source panel would read "answered" beside an empty age
 * dimension, leaving the reader to work out which of the two was at fault. The metered reputation
 * source reports how much of its monthly allowance is left, which is only useful while there is some.
 *
 * With the envelope gone, every source in this function yields its facts directly, and the reader no
 * longer has to remember which half of them needed a `.facts` on the end.
 */
async function runFactCollector<T>(
  source: SourceId,
  fn: () => Promise<{ facts: T; sourceUrl?: string; notice?: string }>,
  timeoutMs?: number,
): Promise<CollectorResult<T>> {
  const { data, ...rest } = await runCollector(source, undefined, fn, timeoutMs);
  if (!data) return rest;
  return {
    ...rest,
    data: data.facts,
    sourceUrl: data.sourceUrl ?? rest.sourceUrl,
    reason: data.notice ?? rest.reason,
  };
}

/**
 * `runCollector` already converts every failure into a result, so a rejected promise here would mean a
 * bug rather than a source problem. It is still handled, because a crash in the orchestrator must not be
 * able to fail the whole request.
 */
function settled<T>(
  outcome: PromiseSettledResult<CollectorResult<T>>,
  record: (result: CollectorResult<T>) => unknown,
): T | undefined {
  if (outcome.status === 'rejected') return undefined;
  record(outcome.value);
  return outcome.value.status === 'ok' ? outcome.value.data : undefined;
}

async function skipped<T>(
  source: CollectorResult<T>['source'],
  reason: string,
): Promise<CollectorResult<T>> {
  return { source, status: 'skipped', reason, elapsedMs: 0 };
}
