/*
 * Copyright The OpenTelemetry Authors
 * SPDX-License-Identifier: Apache-2.0
 */

import * as assert from 'assert';

import type { SpanContext } from '@opentelemetry/api';
import {
  context,
  ROOT_CONTEXT,
  SpanKind,
  TraceFlags,
  trace,
} from '@opentelemetry/api';
import { SamplingDecision } from '@opentelemetry/sdk-trace';

import {
  createCompositeSampler,
  createComposableAlwaysOffSampler,
  createComposableAlwaysOnSampler,
  createComposableAnnotatingSampler,
  createComposableParentThresholdSampler,
  createComposableProbabilitySampler,
} from '../src';
import { INVALID_RANDOM_VALUE, INVALID_THRESHOLD } from '../src/util';
import {
  INVALID_TRACE_STATE,
  parseOtelTraceState,
  serializeTraceState,
} from '../src/tracestate';
import { TraceState } from '@opentelemetry/core';

describe('ConsistentSampler', () => {
  const traceId = '00112233445566778800000000000000';
  const spanId = '0123456789abcdef';

  it('should omit sampler attributes when the span is not recorded', () => {
    const sampler = createCompositeSampler(
      createComposableAnnotatingSampler(createComposableAlwaysOffSampler(), {
        foo: 'bar',
      })
    );
    const result = sampler.shouldSample(
      context.active(),
      traceId,
      'name',
      SpanKind.INTERNAL,
      {},
      []
    );

    assert.strictEqual(result.decision, SamplingDecision.NOT_RECORD);
    assert.ok(!('attributes' in result));
  });

  it('should preserve sampler attributes when the span is sampled', () => {
    const sampler = createCompositeSampler(
      createComposableAnnotatingSampler(createComposableAlwaysOnSampler(), {
        foo: 'bar',
      })
    );
    const result = sampler.shouldSample(
      context.active(),
      traceId,
      'name',
      SpanKind.INTERNAL,
      {},
      []
    );

    assert.strictEqual(result.decision, SamplingDecision.RECORD_AND_SAMPLED);
    assert.deepStrictEqual(result.attributes, { foo: 'bar' });
  });

  for (const expected of [
    SamplingDecision.RECORD_AND_SAMPLED,
    SamplingDecision.NOT_RECORD,
  ]) {
    it(`should update root span tracestate for decision ${expected}`, () => {
      let calls = 0;
      const sampler = createCompositeSampler({
        getSamplingIntent: () => ({
          threshold:
            expected === SamplingDecision.RECORD_AND_SAMPLED
              ? 0n
              : INVALID_THRESHOLD,
          thresholdReliable: true,
          updateTraceState: (state, decision) => {
            calls++;
            assert.ok(state);
            assert.strictEqual(decision, expected);
            return state.set('vendor', 'value');
          },
        }),
        toString: () => 'TestSampler',
      });
      const result = sampler.shouldSample(
        ROOT_CONTEXT,
        traceId,
        'name',
        SpanKind.INTERNAL,
        {},
        []
      );

      assert.strictEqual(calls, 1);
      assert.strictEqual(result.decision, expected);
      assert.strictEqual(result.traceState?.get('vendor'), 'value');
    });
  }

  it('should pass parent tracestate to the update callback', () => {
    const parentState = new TraceState().set('vendor', 'parent');
    const parentContext = trace.setSpanContext(ROOT_CONTEXT, {
      traceId,
      spanId,
      traceFlags: TraceFlags.SAMPLED,
      traceState: parentState,
    });
    const sampler = createCompositeSampler({
      getSamplingIntent: () => ({
        threshold: 0n,
        thresholdReliable: true,
        updateTraceState: (state, decision) => {
          assert.strictEqual(state, parentState);
          assert.strictEqual(decision, SamplingDecision.RECORD_AND_SAMPLED);
          return state?.set('other', 'child');
        },
      }),
      toString: () => 'TestSampler',
    });
    const result = sampler.shouldSample(
      parentContext,
      traceId,
      'name',
      SpanKind.INTERNAL,
      {},
      []
    );

    assert.strictEqual(result.traceState?.get('vendor'), 'parent');
    assert.strictEqual(result.traceState?.get('other'), 'child');
    assert.strictEqual(result.traceState?.get('ot'), 'th:0');
  });

  [
    {
      sampler: createComposableAlwaysOnSampler(),
      parentSampled: true,
      parentThreshold: undefined,
      parentRandomValue: undefined,
      sampled: true,
      threshold: 0n,
      randomValue: INVALID_RANDOM_VALUE,
      testId: 'min threshold no parent random value',
    },
    {
      sampler: createComposableAlwaysOnSampler(),
      parentSampled: true,
      parentThreshold: undefined,
      parentRandomValue: 0x7f99aa40c02744n,
      sampled: true,
      threshold: 0n,
      randomValue: 0x7f99aa40c02744n,
      testId: 'min threshold with parent random value',
    },
    {
      sampler: createComposableAlwaysOffSampler(),
      parentSampled: true,
      parentThreshold: undefined,
      parentRandomValue: undefined,
      sampled: false,
      threshold: INVALID_THRESHOLD,
      randomValue: INVALID_RANDOM_VALUE,
      testId: 'max threshold',
    },
    {
      sampler: createComposableParentThresholdSampler(
        createComposableAlwaysOnSampler()
      ),
      parentSampled: false,
      parentThreshold: 0x7f99aa40c02744n,
      parentRandomValue: 0x7f99aa40c02744n,
      sampled: true,
      threshold: 0x7f99aa40c02744n,
      randomValue: 0x7f99aa40c02744n,
      testId: 'parent based in consistent mode',
    },
    {
      sampler: createComposableParentThresholdSampler(
        createComposableAlwaysOnSampler()
      ),
      parentSampled: true,
      parentThreshold: undefined,
      parentRandomValue: undefined,
      sampled: true,
      threshold: INVALID_THRESHOLD,
      randomValue: INVALID_RANDOM_VALUE,
      testId: 'parent based in legacy mode',
    },
    {
      sampler: createComposableProbabilitySampler(0.5),
      parentSampled: true,
      parentThreshold: undefined,
      parentRandomValue: 0x7fffffffffffffn,
      sampled: false,
      threshold: INVALID_THRESHOLD,
      randomValue: 0x7fffffffffffffn,
      testId: 'half threshold not sampled',
    },
    {
      sampler: createComposableProbabilitySampler(0.5),
      parentSampled: false,
      parentThreshold: undefined,
      parentRandomValue: 0x80000000000000n,
      sampled: true,
      threshold: 0x80000000000000n,
      randomValue: 0x80000000000000n,
      testId: 'half threshold sampled',
    },
    {
      sampler: createComposableProbabilitySampler(1.0),
      parentSampled: false,
      parentThreshold: 0x80000000000000n,
      parentRandomValue: 0x80000000000000n,
      sampled: true,
      threshold: 0n,
      randomValue: 0x80000000000000n,
      testId: 'parent inviolating invariant',
    },
  ].forEach(
    ({
      sampler,
      parentSampled,
      parentThreshold,
      parentRandomValue,
      sampled,
      threshold,
      randomValue,
      testId,
    }) => {
      it(`should sample with ${testId}`, () => {
        let parentOtTraceState = INVALID_TRACE_STATE;
        if (parentThreshold !== undefined) {
          parentOtTraceState = {
            ...parentOtTraceState,
            threshold: parentThreshold,
          };
        }
        if (parentRandomValue !== undefined) {
          parentOtTraceState = {
            ...parentOtTraceState,
            randomValue: parentRandomValue,
          };
        }
        const parentOt = serializeTraceState(parentOtTraceState);
        const parentTraceState = parentOt
          ? new TraceState().set('ot', parentOt)
          : undefined;
        const traceFlags = parentSampled ? TraceFlags.SAMPLED : TraceFlags.NONE;
        const parentSpanContext: SpanContext = {
          traceId,
          spanId,
          traceFlags,
          traceState: parentTraceState,
        };
        const parentContext = trace.setSpanContext(
          context.active(),
          parentSpanContext
        );

        const result = createCompositeSampler(sampler).shouldSample(
          parentContext,
          traceId,
          'name',
          SpanKind.INTERNAL,
          {},
          []
        );
        const expectedDecision = sampled
          ? SamplingDecision.RECORD_AND_SAMPLED
          : SamplingDecision.NOT_RECORD;
        const state = parseOtelTraceState(result.traceState);

        assert.strictEqual(result.decision, expectedDecision);
        assert.strictEqual(state.threshold, threshold);
        assert.strictEqual(state.randomValue, randomValue);
      });
    }
  );
});
