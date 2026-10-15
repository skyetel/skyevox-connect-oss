import assert from 'node:assert/strict';
import test from 'node:test';

import { SipContactIdentityResolver, type SipIdentityStorage } from './contactIdentity.ts';

class MemoryStorage implements SipIdentityStorage {
  private values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

const FIRST_UUID = '11111111-1111-4111-8111-111111111111';
const SECOND_UUID = '22222222-2222-4222-8222-222222222222';

test('cold browser reload reuses the complete persisted SIP contact identity', () => {
  const storage = new MemoryStorage();
  const first = new SipContactIdentityResolver(storage, () => FIRST_UUID)
    .load('175', 'tslhg.skyetel.ai');
  const reloaded = new SipContactIdentityResolver(storage, () => SECOND_UUID)
    .load('175', 'tslhg.skyetel.ai');

  assert.deepEqual(reloaded, first);
  assert.deepEqual(first, {
    contactName: 'sv175-111111111111',
    instanceId: FIRST_UUID,
    viaHost: '11111111111141118111111111111111.invalid',
  });
});

test('separate installations retain distinct identities for the same AOR', () => {
  const installationA = new SipContactIdentityResolver(new MemoryStorage(), () => FIRST_UUID)
    .load('1000', 'tenant.skyetel.ai');
  const installationB = new SipContactIdentityResolver(new MemoryStorage(), () => SECOND_UUID)
    .load('1000', 'tenant.skyetel.ai');

  assert.notEqual(installationA.instanceId, installationB.instanceId);
  assert.notEqual(installationA.contactName, installationB.contactName);
  assert.notEqual(installationA.viaHost, installationB.viaHost);
});

test('the same extension number remains isolated by tenant domain', () => {
  const resolver = new SipContactIdentityResolver(new MemoryStorage(), (() => {
    const ids = [FIRST_UUID, SECOND_UUID];
    return () => ids.shift() ?? SECOND_UUID;
  })());
  const tenantA = resolver.load('1000', 'tenant-a.skyetel.ai');
  const tenantB = resolver.load('1000', 'tenant-b.skyetel.ai');

  assert.notEqual(tenantA.instanceId, tenantB.instanceId);
  assert.notEqual(tenantA.contactName, tenantB.contactName);
});

test('invalid persisted identity is replaced before registration', () => {
  const storage = new MemoryStorage();
  storage.setItem('skyevox_sip_identity_v1:tslhg.skyetel.ai:175', 'not-a-uuid');
  const resolver = new SipContactIdentityResolver(storage, () => FIRST_UUID);

  assert.equal(resolver.load('175', 'tslhg.skyetel.ai').instanceId, FIRST_UUID);
});

test('blocked browser storage still reuses the session identity', () => {
  const blocked: SipIdentityStorage = {
    getItem: () => { throw new Error('blocked'); },
    setItem: () => { throw new Error('blocked'); },
  };
  const resolver = new SipContactIdentityResolver(blocked, () => FIRST_UUID);
  const first = resolver.load('901', 'tenant.skyetel.ai');
  const reconnect = resolver.load('901', 'tenant.skyetel.ai');

  assert.deepEqual(reconnect, first);
});
