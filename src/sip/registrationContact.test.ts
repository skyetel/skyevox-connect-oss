import assert from 'node:assert/strict';
import test from 'node:test';

import { Registerer, UserAgent } from 'sip.js';

const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';

test('REGISTER emits one stable SIP instance with reg-id', () => {
  const uri = UserAgent.makeURI('sip:175@tslhg.skyetel.ai');
  assert.ok(uri);
  const userAgent = new UserAgent({
    uri,
    transportOptions: { server: 'wss://connect.example.test/ws' },
    contactName: 'sv175-111111111111',
    instanceId: INSTANCE_ID,
    viaHost: '11111111111141118111111111111111.invalid',
    logBuiltinEnabled: false,
  });
  const registerer = new Registerer(userAgent, { expires: 120, regId: 1 });
  const generateContactHeader = Reflect.get(registerer, 'generateContactHeader');
  assert.equal(typeof generateContactHeader, 'function');
  const contact = Reflect.apply(generateContactHeader, registerer, [120]);

  assert.match(contact, /^<sip:sv175-111111111111@11111111111141118111111111111111\.invalid;transport=ws>/);
  assert.match(contact, /;reg-id=1/);
  assert.match(contact, /;\+sip\.instance="<urn:uuid:11111111-1111-4111-8111-111111111111>"/);
  assert.equal(contact.split('+sip.instance').length - 1, 1);
});

test('malformed REGISTER 200 without Contact clears pending transaction state', async () => {
  const uri = UserAgent.makeURI('sip:120@tslhg.skyetel.ai');
  assert.ok(uri);
  const userAgent = new UserAgent({
    uri,
    transportOptions: { server: 'wss://connect.example.test/ws' },
    contactName: 'sv120-111111111111',
    instanceId: INSTANCE_ID,
    viaHost: '11111111111141118111111111111111.invalid',
    logBuiltinEnabled: false,
  });
  const registerer = new Registerer(userAgent, { expires: 120, regId: 1 });
  const core = Reflect.get(userAgent, 'userAgentCore');
  const delegates: Array<{ onAccept: (response: unknown) => void }> = [];
  Reflect.set(core, 'register', (_request: unknown, delegate: { onAccept: (response: unknown) => void }) => {
    delegates.push(delegate);
    return { dispatched: true };
  });

  await registerer.register();
  assert.equal(delegates.length, 1);
  delegates[0].onAccept({
    message: {
      hasHeader: () => false,
      getHeaders: () => [],
    },
  });

  await assert.doesNotReject(registerer.register());
  assert.equal(delegates.length, 2);
});
