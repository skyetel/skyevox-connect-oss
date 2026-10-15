import assert from 'node:assert/strict';
import test from 'node:test';

import { answerSecondCallTransaction } from './secondCallAnswer.ts';

test('waiting-call answer rolls back primary ownership when answer fails', async () => {
  const operations: string[] = [];

  await assert.rejects(answerSecondCallTransaction('call-a', 'call-b', {
    hold: async (sessionId) => { operations.push(`hold:${sessionId}`); },
    answer: async (sessionId) => {
      operations.push(`answer:${sessionId}`);
      throw new Error('answer failed');
    },
    unhold: async (sessionId) => { operations.push(`unhold:${sessionId}`); },
  }), /answer failed/);

  assert.deepEqual(operations, ['hold:call-a', 'answer:call-b', 'unhold:call-a']);
});

test('waiting-call answer commits second ownership only after answer succeeds', async () => {
  const operations: string[] = [];

  const activeSessionId = await answerSecondCallTransaction('call-a', 'call-b', {
    hold: async (sessionId) => { operations.push(`hold:${sessionId}`); },
    answer: async (sessionId) => { operations.push(`answer:${sessionId}`); },
    unhold: async (sessionId) => { operations.push(`unhold:${sessionId}`); },
  });

  assert.equal(activeSessionId, 'call-b');
  assert.deepEqual(operations, ['hold:call-a', 'answer:call-b']);
});

test('rollback failure is reported without hiding the original answer failure', async () => {
  const rollbackErrors: unknown[] = [];
  const answerError = new Error('answer failed');
  const rollbackError = new Error('unhold failed');

  await assert.rejects(answerSecondCallTransaction('call-a', 'call-b', {
    hold: async () => {},
    answer: async () => { throw answerError; },
    unhold: async () => { throw rollbackError; },
    onRollbackError: (error) => rollbackErrors.push(error),
  }), answerError);

  assert.deepEqual(rollbackErrors, [rollbackError]);
});
