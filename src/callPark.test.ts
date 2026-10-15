import assert from 'node:assert/strict';
import test from 'node:test';

import { fetchCallParkSlots, parkActiveCall, requestCallPark, pickupParkedCall } from './callPark.ts';
import type { SipConfig } from './types.ts';

const config = {
  extension: '799',
  password: 'sip-secret',
  sipDomain: 'tslhg.skyetel.ai',
  sipServer: 'connect.skyetel.ai',
} as SipConfig;

test('call park reserves a real valet slot through the tenant-aware NG API', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), init });
    return new Response(JSON.stringify({ slot: 6001, feature_code: '*68*6001' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const result = await requestCallPark(config, fetcher);

  assert.deepEqual(result, { slot: 6001, featureCode: '*68*6001' });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://skyevox.skyetel.ai/api/connect/park/799');
  assert.equal(requests[0].init?.method, 'POST');
  assert.equal(requests[0].init?.body, undefined);
  const authorization = new Headers(requests[0].init?.headers).get('Authorization') || '';
  assert.equal(atob(authorization.slice('Basic '.length)), '799@tslhg.skyetel.ai:sip-secret');
});
test('parking transfers the active SIP dialog to the allocated valet destination', async () => {
  const transfers: string[] = [];
  const fetcher = async () => new Response(
    JSON.stringify({ slot: 6007, feature_code: '*68*6007' }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );

  const result = await parkActiveCall(
    config,
    async (destination) => { transfers.push(destination); },
    fetcher,
  );

  assert.deepEqual(result, { slot: 6007, featureCode: '*68*6007' });
  assert.deepEqual(transfers, ['*68*6007']);
});

test('parking never transfers the SIP dialog when allocation fails', async () => {
  let transfers = 0;
  const fetcher = async () => new Response(
    JSON.stringify({ error: 'no active call found for this extension' }),
    { status: 409, headers: { 'Content-Type': 'application/json' } },
  );

  await assert.rejects(
    parkActiveCall(
      config,
      async () => { transfers += 1; },
      fetcher,
    ),
    /no active call found/,
  );
  assert.equal(transfers, 0);
});


test('call park slot listing is scoped by the same extension credentials', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), init });
    return new Response(JSON.stringify([
      { slot: 6001, uuid: 'abc-123', node: 'secondary', caller_id: 'caller-1', caller_name: 'Caller One', pickup_code: '*69*6001' },
    ]), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const slots = await fetchCallParkSlots(config, fetcher);

  assert.deepEqual(slots, [{ slot: 6001, uuid: 'abc-123', node: 'secondary', caller_id: 'caller-1', caller_name: 'Caller One', pickup_code: '*69*6001' }]);
  assert.equal(requests[0].url, 'https://skyevox.skyetel.ai/api/connect/park/799/slots');
  const authorization = new Headers(requests[0].init?.headers).get('Authorization') || '';
  assert.equal(atob(authorization.slice('Basic '.length)), '799@tslhg.skyetel.ai:sip-secret');
});

test('call park preserves the active call when slot allocation fails', async () => {
  const fetcher = async () => new Response(
    JSON.stringify({ error: 'no parking slots available' }),
    { status: 409, headers: { 'Content-Type': 'application/json' } },
  );

  await assert.rejects(
    requestCallPark(config, fetcher),
    /no parking slots available/,
  );
});

test('call park rejects a successful response without a retrievable valet destination', async () => {
  const fetcher = async () => new Response(
    JSON.stringify({ slot: 0, feature_code: '' }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );

  await assert.rejects(
    requestCallPark(config, fetcher),
    /invalid parking slot/,
  );
});

test('call park rejects the legacy raw-slot transfer contract', async () => {
  const fetcher = async () => new Response(
    JSON.stringify({ slot: 6001, feature_code: '6001' }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );

  await assert.rejects(
    requestCallPark(config, fetcher),
    /invalid parking slot/,
  );
});

test('call park listing drops slots without a tenant-safe pickup destination', async () => {
  const fetcher = async () => new Response(JSON.stringify([
    { slot: 6001, caller_id: 'caller-1', caller_name: 'Caller One', pickup_code: '6001' },
  ]), { status: 200, headers: { 'Content-Type': 'application/json' } });

  assert.deepEqual(await fetchCallParkSlots(config, fetcher), []);
});

test('pickup surfaces switch failure even when HTTP transport succeeds', async () => {
  await assert.rejects(
    pickupParkedCall(config, 'abc-123', async () => new Response(
      JSON.stringify({ ok: false, error: 'USER_NOT_REGISTERED' }), { status: 200 },
    )),
    /USER_NOT_REGISTERED/,
  );
});

test('slots on different nodes remain individually retrievable', async () => {
  const slots = await fetchCallParkSlots(config, async () => new Response(JSON.stringify([
    { slot: 6001, uuid: 'abc-123', node: 'primary', caller_id: 'one', caller_name: '', pickup_code: '*69*6001' },
    { slot: 6001, uuid: 'abc-456', node: 'secondary', caller_id: 'two', caller_name: '', pickup_code: '*69*6001' },
  ])));
  assert.deepEqual(slots.map((slot) => [slot.uuid, slot.node]), [['abc-123', 'primary'], ['abc-456', 'secondary']]);
});
