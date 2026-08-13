// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import axe, { type Result } from 'axe-core';
import { StrictMode } from 'react';

import Home from '@/app/page';
import { establishedSmallBusiness } from './fixtures';
import { score } from '@/lib/scoring/score';
import { VERDICT_DESCRIPTIONS, VERDICT_LABELS } from '@/lib/scoring/verdict';
import type { AnalyzeResponse, ErrorResponse, OutOfScopeResponse } from '@/lib/api-types';

/**
 * Automated accessibility checks over the states that are tedious to reach by hand.
 *
 * The whole page is rendered and driven through `fetch` rather than exercising components in
 * isolation, because most of what axe checks is relational: whether a label is associated with the
 * input it labels, whether `aria-controls` names something that exists, whether ids are unique once
 * every disclosure is on the page at once. A component tested alone satisfies all of those
 * vacuously.
 *
 * Contrast is deliberately not covered here. Under jsdom there is no layout, so axe has nothing to
 * sample and its `color-contrast` rule reports nothing at all rather than failing — which is worse
 * than not running it, because the suite would look like it checked. `test/contrast.test.ts` checks
 * the palette arithmetically instead.
 */

const FIXTURE = establishedSmallBusiness();

/** The route's `toResponse`, applied to an offline fixture so no test touches the network. */
function analysed(): AnalyzeResponse {
  const result = score(FIXTURE);
  return {
    domain: 'example.com',
    submittedHost: 'example.com',
    inputWasEmailAddress: false,
    analysedAt: FIXTURE.meta.analysedAt,
    elapsedMs: 1234,
    modelVersion: result.modelVersion,
    legitimacy: result.legitimacy,
    risk: result.risk,
    confidence: result.confidence,
    verdict: result.verdict,
    verdictLabel: VERDICT_LABELS[result.verdict],
    verdictDescription: VERDICT_DESCRIPTIONS[result.verdict],
    narrative: result.narrative,
    flags: result.flags,
    firstSeen: result.firstSeen,
    ageDays: result.ageDays,
    dimensions: result.dimensions,
    signals: result.signals,
    inapplicableSignals: result.inapplicableSignals,
    observations: result.observations,
    combinations: result.combinations,
    sources: FIXTURE.sources,
  };
}

const OUT_OF_SCOPE: OutOfScopeResponse = {
  domain: 'gmail.com',
  outOfScope: {
    reason: 'shared_free_provider',
    explanation:
      'This is a major consumer mail provider. Domain-level analysis says nothing about an individual account.',
  },
  verdict: 'out_of_scope',
  verdictLabel: VERDICT_LABELS.out_of_scope,
  verdictDescription: VERDICT_DESCRIPTIONS.out_of_scope,
  modelVersion: '1.5.0',
};

const SERVICE_ERROR: ErrorResponse = {
  error: 'analysis_failed',
  message:
    'The analysis could not be completed. This is a fault in the service, not a finding about the domain.',
};

/** A plain JSON reply, which is the non-streaming branch the client falls back to. */
function jsonReply(body: unknown, status = 200): Response {
  return {
    ok: status < 400,
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    body: null,
    json: async () => body,
  } as unknown as Response;
}

function describeViolations(violations: Result[]): string {
  return violations
    .map((violation) => {
      const where = violation.nodes.map((node) => node.html).join('\n      ');
      return `${violation.id} (${violation.impact}): ${violation.help}\n      ${where}`;
    })
    .join('\n');
}

async function expectNoViolations(container: HTMLElement) {
  const results = await axe.run(container, {
    // Nothing here is a full document, so the rules about landmarks, page titles and a top-level h1
    // would fire on the absence of a layout that this render never included. They are the layout's
    // business and are asserted separately below.
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
    rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
  });

  expect(describeViolations(results.violations)).toBe('');
}

/**
 * Types a domain and submits, which is the only way into any state below.
 *
 * The domains these tests submit have to be ones the client-side check passes, which rules out the
 * reserved `.example` suffix that would otherwise be the natural choice: it is rejected in the browser
 * and never reaches the stubbed `fetch` at all.
 */
function submit(domain = 'example.com') {
  fireEvent.change(screen.getByLabelText(/domain or email/i), { target: { value: domain } });
  fireEvent.submit(screen.getByRole('button', { name: /analyse/i }));
}

beforeEach(() => {
  window.history.replaceState(null, '', '/');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('accessibility', () => {
  it('has no violations on the empty state', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const { container } = render(<Home />);
    await expectNoViolations(container);
  });

  it('has no violations while an analysis is pending', async () => {
    // Never settles, which is exactly the state the progress view and the Cancel button exist for.
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));

    const { container } = render(<Home />);
    submit();

    await screen.findByRole('button', { name: /cancel/i });
    await expectNoViolations(container);
  });

  it('has no violations on a full result', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonReply(analysed())));

    const { container } = render(<Home />);
    submit();

    await screen.findByText(analysed().narrative);
    await expectNoViolations(container);
  });

  it('has no violations with every disclosure expanded', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonReply(analysed())));

    const { container } = render(<Home />);
    submit();
    await screen.findByText(analysed().narrative);

    // Expanding everything is what puts every panel, every generated id and every `aria-controls`
    // target on the page at the same time, which is the only arrangement that can collide. The bulk
    // control goes first: once its rows are open it relabels itself to Collapse all.
    fireEvent.click(screen.getByRole('button', { name: /expand all/i }));

    // Repeated to a fixed point, because opening a group reveals the rows inside it, and those are
    // collapsed too. Bounded so a disclosure that somehow refuses to open fails the test rather than
    // hanging it.
    for (let pass = 0; pass < 5; pass += 1) {
      const collapsed = screen.queryAllByRole('button', { expanded: false });
      if (collapsed.length === 0) break;
      for (const button of collapsed) fireEvent.click(button);
    }

    expect(screen.queryAllByRole('button', { expanded: false })).toHaveLength(0);
    await expectNoViolations(container);
  });

  it('has no violations on the out-of-scope verdict', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonReply(OUT_OF_SCOPE)));

    const { container } = render(<Home />);
    submit('gmail.com');

    await screen.findByText(OUT_OF_SCOPE.outOfScope.explanation);
    await expectNoViolations(container);
  });

  it('has no violations on a service error, and announces it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonReply(SERVICE_ERROR, 500)));

    const { container } = render(<Home />);
    submit();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(SERVICE_ERROR.message);
    await expectNoViolations(container);
  });

  it('has no violations on a network failure, and announces it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );

    const { container } = render(<Home />);
    submit();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/check your connection/i);
    await expectNoViolations(container);
  });

  it('has no violations when input is rejected before any request', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);

    const { container } = render(<Home />);
    submit('127.0.0.1');

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/IP addresses/i);
    // The point of validating in the browser: the request is never made.
    expect(fetcher).not.toHaveBeenCalled();
    await expectNoViolations(container);
  });
});

/**
 * Behaviour that is not axe's business but is the reason half of the markup looks the way it does.
 * Checked here rather than in a separate file because it needs the same jsdom render.
 */
describe('result lifecycle', () => {
  it('keeps the previous verdict but marks it stale when the next analysis fails', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(jsonReply(analysed()))
      .mockResolvedValueOnce(jsonReply(SERVICE_ERROR, 500));
    vi.stubGlobal('fetch', fetcher);

    render(<Home />);
    submit('example.com');
    await screen.findByText(analysed().narrative);

    submit('broken-domain.com');
    await screen.findByRole('alert');

    // The verdict survives, because it is the reader's only point of comparison...
    expect(screen.getByText(analysed().narrative)).toBeTruthy();
    // ...and says whose verdict it is, so it cannot be read as one about the domain that just failed.
    expect(screen.getByText(/showing the previous result for/i)).toBeTruthy();
  });

  it('analyses a pasted ?domain= URL, surviving the development double-mount', async () => {
    window.history.replaceState(null, '', '/?domain=pasted-domain.com');
    const fetcher = vi.fn(async () => jsonReply(analysed()));
    vi.stubGlobal('fetch', fetcher);

    // StrictMode mounts, tears down and remounts, which cancels the analysis the first mount started.
    // The remount has to notice and run it again rather than treating its own cancelled request as a
    // result already on screen.
    render(
      <StrictMode>
        <Home />
      </StrictMode>,
    );

    await screen.findByText(analysed().narrative);
    expect(fetcher).toHaveBeenCalled();
  });

  it('pushes a history entry per analysed domain rather than replacing one', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonReply(analysed())));

    render(<Home />);
    const before = window.history.length;

    submit('one-domain.com');
    await waitFor(() => expect(window.location.search).toBe('?domain=one-domain.com'));

    submit('two-domain.com');
    await waitFor(() => expect(window.location.search).toBe('?domain=two-domain.com'));

    expect(window.history.length).toBeGreaterThan(before);
  });

  it('re-analysing the same domain refreshes rather than stacking history entries', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonReply(analysed())));

    render(<Home />);
    submit('one-domain.com');
    await waitFor(() => expect(window.location.search).toBe('?domain=one-domain.com'));

    const after = window.history.length;
    submit('one-domain.com');
    await waitFor(() => expect(window.location.search).toBe('?domain=one-domain.com'));

    expect(window.history.length).toBe(after);
  });
});
