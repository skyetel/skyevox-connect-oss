import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { Invitation } from 'sip.js';
import { SipClient } from './SipClient.ts';
import { answerSession } from './sessionControl.ts';

const SDP = 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 RTP/AVP 0\r\na=sendrecv\r\n';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function track() {
  return { kind: 'audio', enabled: true, readyState: 'live', stop() { this.readyState = 'ended'; } };
}

// Real SIP.js Invitation and re-INVITE state machines; only transport and media
// devices are replaced. In particular, getDescription applies the real modifiers.
async function dialogFixture(id: string) {
  const logger = { log() {}, error() {}, warn() {}, debug() {} };
  const invitation = new Invitation({
    getLogger: () => logger, configuration: {},
    contact: { toString: () => 'sip:callee@fixture.invalid' }, _sessions: {},
  } as never, {
    message: { getHeader() {}, hasHeader: () => false, parseHeader() {}, callId: id, fromTag: 'caller' },
    toTag: 'callee', reject() {},
  } as never);
  const boundary = invitation as unknown as { userNoAnswerTimer: ReturnType<typeof setTimeout>; sendAccept: () => Promise<unknown> };
  clearTimeout(boundary.userNoAnswerTimer);
  boundary.sendAccept = async () => ({ message: {}, session: {} });
  await answerSession(invitation);
  const microphone = track();
  const sender = { track: microphone, async replaceTrack(value: typeof microphone) { this.track = value; } };
  type Request = {
    sdp: string;
    media: ReturnType<typeof deferred>;
    accept: () => void;
    reject: () => void;
  };
  const requests: Request[] = [];
  let pending: Request;
  let automatic = true;
  let acceptedDirection = 'sendrecv';
  const dialog = {
    callId: id,
    invite(delegate: { onAccept: (response: unknown) => void; onReject: (response: unknown) => void }, options: { body: { content: string } }) {
      const request: Request = {
        sdp: options.body.content,
        media: deferred(),
        accept() {
          delegate.onAccept({
            message: { statusCode: 200, content: SDP, contentType: 'application/sdp', contentDisposition: 'session' },
            ack() {}, session: dialog,
          });
        },
        reject() { delegate.onReject({ message: { statusCode: 488, reasonPhrase: 'Not Acceptable Here' } }); },
      };
      pending = request;
      requests.push(request);
      if (automatic) queueMicrotask(() => { request.accept(); request.media.resolve(); });
      return {};
    },
    bye() { return {}; },
  };
  Object.assign(invitation, {
    _dialog: dialog,
    _sessionDescriptionHandler: {
      peerConnection: { getSenders: () => [sender], getReceivers: () => [{ track: track() }] },
      async getDescription(_options: unknown, modifiers: Array<(description: RTCSessionDescriptionInit) => Promise<RTCSessionDescriptionInit>>) {
        let description: RTCSessionDescriptionInit = { type: 'offer', sdp: SDP };
        for (const modifier of modifiers) description = await modifier(description);
        return { body: description.sdp, contentType: 'application/sdp' };
      },
      hasDescription: () => true,
      async setDescription() {
        const request = pending;
        await request.media.promise;
        acceptedDirection = request.sdp.includes('a=sendonly') ? 'sendonly' : 'sendrecv';
      },
      async rollbackDescription() {},
      close() {},
    },
  });
  return {
    invitation, microphone, sender, requests,
    get direction() { return acceptedDirection; },
    manual() { automatic = false; requests.length = 0; },
    async request(index = 0) {
      const deadline = Date.now() + 1000;
      while (!requests[index] && Date.now() < deadline) await setImmediate();
      assert.ok(requests[index], `${id}: missing re-INVITE ${index + 1}`);
      return requests[index];
    },
  };
}

async function conferenceFixture(t: TestContext) {
  class Stream {
    tracks: MediaStreamTrack[];
    constructor(tracks: MediaStreamTrack[]) { this.tracks = tracks; }
    getTracks() { return this.tracks; }
    getAudioTracks() { return this.tracks; }
  }
  class Context {
    state = 'running';
    createMediaStreamDestination() { return { stream: new Stream([track()]) }; }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    async close() {}
  }
  const globals = { window: { AudioContext: Context }, MediaStream: Stream };
  for (const [name, value] of Object.entries(globals)) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    t.after(() => {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({ ok: true }) }));
  const a = await dialogFixture('a');
  const b = await dialogFixture('b');
  const client = new SipClient({ extension: 'fixture', username: 'fixture', password: 'fixture', sipServer: 'fixture.invalid', sipDomain: 'fixture.invalid' } as never);
  const internals = client as unknown as {
    sessions: Map<string, Invitation>;
    activeSessionId: string;
    setupRemoteAudio: () => void;
    setupSessionListeners: (session: Invitation, id: string) => void;
  };
  internals.sessions = new Map([['a', a.invitation], ['b', b.invitation]]);
  internals.activeSessionId = 'a';
  // DOM playback is not part of the outbound hold contract.
  internals.setupRemoteAudio = () => {};
  internals.setupSessionListeners(a.invitation, 'a');
  internals.setupSessionListeners(b.invitation, 'b');
  await client.mergeCall();
  a.manual();
  b.manual();
  return { client, a, b, internals };
}

async function acceptBoth(fixture: Awaited<ReturnType<typeof conferenceFixture>>, index = 0) {
  const requests = await Promise.all([fixture.a.request(index), fixture.b.request(index)]);
  for (const request of requests) { request.accept(); request.media.resolve(); }
}

test('merged default Hold and Resume negotiate both dialogs and gate audio until both media answers finish', async (t) => {
  const fixture = await conferenceFixture(t);
  const { client, a, b } = fixture;
  assert.equal(client.toggleMute(), true);
  let completed = false;
  const hold = client.hold().then(() => { completed = true; });
  assert.equal(a.sender.track.enabled, false);
  assert.equal(b.sender.track.enabled, false);
  const requests = await Promise.all([a.request(), b.request()]);
  for (const request of requests) { assert.match(request.sdp, /a=sendonly/); request.accept(); }
  requests[0].media.resolve();
  await setImmediate();
  assert.equal(completed, false);
  requests[1].media.resolve();
  await hold;
  assert.equal(a.sender.track.enabled, false);
  assert.equal(b.sender.track.enabled, false);
  completed = false;
  const resume = client.unhold().then(() => { completed = true; });
  const resumes = await Promise.all([a.request(1), b.request(1)]);
  for (const request of resumes) { assert.match(request.sdp, /a=sendrecv/); request.accept(); }
  resumes[0].media.resolve();
  await setImmediate();
  assert.equal(completed, false);
  assert.equal(a.sender.track.enabled, false);
  assert.equal(b.sender.track.enabled, false);
  resumes[1].media.resolve();
  await resume;
  assert.equal(a.sender.track.enabled, true);
  assert.equal(b.sender.track.enabled, true);
  assert.equal(a.microphone.enabled, false);
  assert.equal(b.microphone.enabled, false);
});

test('splitting a held conference preserves privacy until the active call is explicitly resumed', async (t) => {
  const fixture = await conferenceFixture(t);
  const { client, a, b } = fixture;
  const hold = client.hold();
  await acceptBoth(fixture);
  await hold;

  const split = client.splitConference();
  await setImmediate();
  for (const request of a.requests) assert.match(request.sdp, /a=sendonly/);
  const secondaryHold = await b.request(1);
  secondaryHold.accept(); secondaryHold.media.resolve();
  await split;
  assert.equal(client.conferenceActive, false);
  assert.equal(a.microphone.enabled, false);
  assert.equal(b.microphone.enabled, false);

  const resume = client.unhold();
  const activeResume = await a.request(1);
  assert.match(activeResume.sdp, /a=sendrecv/);
  activeResume.accept(); activeResume.media.resolve();
  await resume;
  assert.equal(a.microphone.enabled, true);
  assert.equal(b.microphone.enabled, false);
  assert.equal(b.direction, 'sendonly');
});

test('explicit IDs remain individual and a consultation outside merged membership is untouched', async (t) => {
  const { client, a, b, internals } = await conferenceFixture(t);
  const consultation = await dialogFixture('consultation');
  consultation.manual();
  internals.sessions.set('consultation', consultation.invitation);
  internals.activeSessionId = 'consultation';
  const individualHold = client.hold('a');
  const hold = await a.request();
  hold.accept(); hold.media.resolve();
  await individualHold;
  assert.equal(b.requests.length, 0);
  const individualResume = client.unhold('a');
  const resume = await a.request(1);
  resume.accept(); resume.media.resolve();
  await individualResume;
  assert.equal(b.requests.length, 0);
  const mergedHold = client.hold();
  const requests = await Promise.all([a.request(2), b.request()]);
  for (const request of requests) { request.accept(); request.media.resolve(); }
  await mergedHold;
  assert.equal(consultation.requests.length, 0);
});

test('partial Hold rejection waits for compensation before restoring live conference audio', async (t) => {
  const { client, a, b } = await conferenceFixture(t);
  const outcome = assert.rejects(client.hold(), AggregateError);
  const first = await a.request();
  first.accept(); first.media.resolve();
  (await b.request()).reject();
  const rollback = await a.request(1);
  assert.match(rollback.sdp, /a=sendrecv/);
  assert.equal(a.sender.track.enabled, false);
  assert.equal(b.sender.track.enabled, false);
  rollback.accept(); rollback.media.resolve();
  await outcome;
  assert.equal(a.direction, 'sendrecv');
  assert.equal(b.direction, 'sendrecv');
  assert.equal(a.sender.track.enabled, true);
  assert.equal(b.sender.track.enabled, true);
});

test('failed Resume compensation stays isolated, rejects overlapping control, and permits a full retry', async (t) => {
  const fixture = await conferenceFixture(t);
  const { client, a, b } = fixture;
  const hold = client.hold();
  await acceptBoth(fixture);
  await hold;
  const outcome = assert.rejects(client.unhold(), AggregateError);
  await assert.rejects(client.hold('a'), Error);
  await assert.rejects(client.splitConference(), Error);
  const first = await a.request(1);
  first.accept(); first.media.resolve();
  (await b.request(1)).reject();
  const rollback = await a.request(2);
  assert.match(rollback.sdp, /a=sendonly/);
  rollback.reject();
  await outcome;
  assert.equal(a.sender.track.enabled, false);
  assert.equal(b.sender.track.enabled, false);
  const retry = client.unhold();
  const requests = await Promise.all([a.request(3), b.request(2)]);
  for (const request of requests) { request.accept(); request.media.resolve(); }
  await retry;
  assert.equal(a.sender.track.enabled, true);
  assert.equal(b.sender.track.enabled, true);
});

test('participant media failure during Resume cannot reopen the surviving microphone on teardown', async (t) => {
  const fixture = await conferenceFixture(t);
  const { client, a, b } = fixture;
  const hold = client.hold();
  await acceptBoth(fixture);
  await hold;
  const outcome = assert.rejects(client.unhold(), AggregateError);
  const first = await a.request(1);
  const second = await b.request(1);
  first.accept(); first.media.resolve();
  second.accept(); second.media.reject(new Error('Unusable remote media'));
  const rollback = await a.request(2);
  rollback.accept(); rollback.media.resolve();
  await outcome;
  assert.equal(a.sender.track, a.microphone);
  assert.equal(a.microphone.enabled, false);
  const resume = client.unhold('a');
  const request = await a.request(3);
  request.accept(); request.media.resolve();
  await resume;
  assert.equal(a.microphone.enabled, true);
});

test('without a merged conference default Hold and Resume affect only the active consultation', async () => {
  const a = await dialogFixture('primary');
  const b = await dialogFixture('consultation');
  a.manual();
  b.manual();
  const client = new SipClient({ sipServer: 'fixture.invalid' } as never);
  Object.assign(client, {
    sessions: new Map([['primary', a.invitation], ['consultation', b.invitation]]),
    activeSessionId: 'consultation',
  });
  const hold = client.hold();
  const request = await b.request();
  request.accept(); request.media.resolve();
  await hold;
  assert.equal(a.requests.length, 0);
  const resume = client.unhold();
  const resumed = await b.request(1);
  resumed.accept(); resumed.media.resolve();
  await resume;
  assert.equal(a.requests.length, 0);
  assert.equal(b.direction, 'sendrecv');
});
