import test from 'node:test';
import assert from 'node:assert/strict';
import { Invitation, SessionState } from 'sip.js';
import type { Session } from 'sip.js';
import { answerSession, completeBlindTransfer, setSessionHeld } from './sessionControl.ts';

type RequestDelegate = {
  onAccept: (response: { message: { statusCode: number; reasonPhrase?: string } }) => void;
  onRedirect: (response: { message: { statusCode: number; reasonPhrase?: string } }) => void;
  onReject: (response: { message: { statusCode: number; reasonPhrase?: string } }) => void;
};

function incomingAnswerFixture() {
  const logger = { log() {}, error() {}, warn() {}, debug() {} };
  const invitation = new Invitation({
    getLogger: () => logger,
    configuration: {},
    contact: { toString: () => 'sip:callee@fixture.invalid' },
    _sessions: {},
  } as unknown as ConstructorParameters<typeof Invitation>[0], {
    message: {
      getHeader: () => undefined,
      hasHeader: () => false,
      parseHeader: () => undefined,
      callId: 'isolated-incoming',
      fromTag: 'caller',
    },
    toTag: 'callee',
    reject: () => {},
  } as unknown as ConstructorParameters<typeof Invitation>[1]);
  let complete!: () => void;
  let fail!: (error: Error) => void;
  const response = new Promise<{ message: object; session: object }>((resolve, reject) => {
    complete = () => resolve({ message: {}, session: {} });
    fail = reject;
  });
  // Keep SIP.js's real accept/state machine; control only its media/response boundary.
  const boundary = invitation as unknown as {
    userNoAnswerTimer: ReturnType<typeof setTimeout>;
    sendAccept: () => typeof response;
  };
  clearTimeout(boundary.userNoAnswerTimer);
  boundary.sendAccept = () => response;
  return { invitation, complete, fail };
}

test('repeated answers wait for the same incoming call to establish', async () => {
  const { invitation, complete } = incomingAnswerFixture();
  let answered = false;
  const first = answerSession(invitation).then(() => { answered = true; });
  await Promise.resolve();
  const second = answerSession(invitation);
  assert.equal(invitation.state, SessionState.Establishing);
  assert.equal(answered, false);
  complete();
  await Promise.all([first, second]);
  await answerSession(invitation);
  assert.equal(answered, true);
  assert.equal(invitation.state, SessionState.Established);
});

test('media failure rejects all pending answers with the original cause', async () => {
  const { invitation, fail } = incomingAnswerFixture();
  const first = answerSession(invitation);
  const second = answerSession(invitation);
  const error = new Error('Microphone access denied');
  const outcomes = Promise.allSettled([first, second]);
  await Promise.resolve();
  fail(error);
  assert.deepEqual(await outcomes, [
    { status: 'rejected', reason: error },
    { status: 'rejected', reason: error },
  ]);
  assert.equal(invitation.state, SessionState.Terminated);
});

test('remote cancellation while answering never reports a connected call', async () => {
  const { invitation, fail } = incomingAnswerFixture();
  const outcome = Promise.allSettled([answerSession(invitation)]);
  await Promise.resolve();
  invitation._onCancel({} as Parameters<Invitation['_onCancel']>[0]);
  fail(new Error('Media setup interrupted'));
  assert.equal((await outcome)[0].status, 'rejected');
  assert.equal(invitation.state, SessionState.Terminated);
});

async function establishedMediaFixture() {
  const { invitation, complete } = incomingAnswerFixture();
  const answering = answerSession(invitation);
  complete();
  await answering;
  let received!: (delegate: { onAccept: (response: unknown) => void }) => void;
  const sent = new Promise<{ onAccept: (response: unknown) => void }>((resolve) => { received = resolve; });
  let acceptMedia!: () => void;
  let rejectMedia!: (error: Error) => void;
  const media = new Promise<void>((resolve, reject) => {
    acceptMedia = resolve;
    rejectMedia = reject;
  });
  let acknowledged = false;
  let endedByMedia = false;
  const dialog = {
    invite(delegate: { onAccept: (response: unknown) => void }) { received(delegate); return {}; },
    bye() { endedByMedia = true; return {}; },
  };
  // Exercise SIP.js's real re-INVITE state machine, replacing only transport/media.
  Object.assign(invitation, {
    _dialog: dialog,
    _sessionDescriptionHandler: {
      getDescription: async () => ({ body: 'v=0\r\na=sendrecv\r\n', contentType: 'application/sdp' }),
      hasDescription: () => true,
      setDescription: () => media,
      close() {},
    },
  });
  return {
    session: invitation,
    acceptMedia,
    rejectMedia,
    get acknowledged() { return acknowledged; },
    get endedByMedia() { return endedByMedia; },
    async accept(withSDP = true) {
      const delegate = await sent;
      delegate.onAccept({
        message: withSDP
          ? { statusCode: 200, content: 'v=0\r\na=sendrecv\r\n', contentType: 'application/sdp', contentDisposition: 'session' }
          : { statusCode: 200 },
        ack() { acknowledged = true; },
        session: dialog,
      });
    },
  };
}

test('hold waits for accepted media before reporting success', async () => {
  const fixture = await establishedMediaFixture();
  let completed = false;
  const operation = setSessionHeld(fixture.session, true).then(() => { completed = true; });
  await fixture.accept();
  assert.equal(completed, false);
  fixture.acceptMedia();
  await operation;
  assert.equal(fixture.acknowledged, true);
  assert.equal(fixture.session.state, SessionState.Established);
});

test('resume rejects when a successful SIP response contains unusable media', async () => {
  const fixture = await establishedMediaFixture();
  const outcome = Promise.allSettled([setSessionHeld(fixture.session, false)]);
  await fixture.accept();
  fixture.rejectMedia(new Error('Remote media answer rejected'));
  assert.equal((await outcome)[0].status, 'rejected');
  assert.equal(fixture.endedByMedia, true);
  assert.equal(fixture.session.state, SessionState.Terminated);
});

test('resume rejects rather than hanging when the accepted response has no SDP', async () => {
  const fixture = await establishedMediaFixture();
  const outcome = Promise.allSettled([setSessionHeld(fixture.session, false)]);
  await fixture.accept(false);
  assert.equal((await outcome)[0].status, 'rejected');
  assert.equal(fixture.session.state, SessionState.Terminated);
});

test('REFER acceptance and provisional NOTIFY do not end the original call', async () => {
  let options: Parameters<Session['refer']>[1];
  let byeCalls = 0;
  let completed = false;
  const session = {
    state: SessionState.Established,
    refer: async (_target: unknown, value: typeof options) => { options = value; return {}; },
    bye: async () => { byeCalls++; return {}; },
  } as unknown as Session;
  const operation = completeBlindTransfer(session, {} as Parameters<Session['refer']>[0])
    .then(() => { completed = true; });
  options?.requestDelegate?.onAccept?.({ message: { statusCode: 202 } } as never);
  options?.onNotify?.({ request: { body: 'SIP/2.0 100 Trying\r\n' }, accept: async () => {} } as never);
  await Promise.resolve();
  assert.equal(byeCalls, 0);
  assert.equal(completed, false);
  options?.onNotify?.({ request: { body: 'SIP/2.0 200 OK\r\n' }, accept: async () => {} } as never);
  await operation;
  assert.equal(byeCalls, 1);
});

test('failed transferred INVITE keeps original call established after REFER acceptance', async () => {
  let options: Parameters<Session['refer']>[1];
  let byeCalls = 0;
  const session = {
    state: SessionState.Established,
    refer: async (_target: unknown, value: typeof options) => { options = value; return {}; },
    bye: async () => { byeCalls++; return {}; },
  } as unknown as Session;
  const operation = completeBlindTransfer(session, {} as Parameters<Session['refer']>[0]);
  options?.requestDelegate?.onAccept?.({ message: { statusCode: 202 } } as never);
  options?.onNotify?.({ request: { body: 'SIP/2.0 486 Busy Here\r\n' }, accept: async () => {} } as never);
  await assert.rejects(operation, /486/);
  assert.equal(byeCalls, 0);
});

test('rejected blind transfer preserves the established local dialog', async () => {
  let byeCalls = 0;
  const session = {
    state: SessionState.Established,
    refer: async (_target: unknown, options: { requestDelegate: RequestDelegate }) => {
      options.requestDelegate.onReject({ message: { statusCode: 403, reasonPhrase: 'Forbidden' } });
      return {};
    },
    bye: async () => {
      byeCalls += 1;
      return {};
    },
  } as unknown as Session;

  await assert.rejects(
    completeBlindTransfer(session, {} as Parameters<Session['refer']>[0]),
    /Transfer rejected with 403 Forbidden/,
  );
  assert.equal(byeCalls, 0);
});
