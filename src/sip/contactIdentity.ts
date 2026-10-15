export interface SipIdentityStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface SipContactIdentity {
  contactName: string;
  instanceId: string;
  viaHost: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function identityKey(username: string, sipDomain: string): string {
  return `skyevox_sip_identity_v1:${sipDomain.toLowerCase()}:${username.toLowerCase()}`;
}

function browserStorage(): SipIdentityStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function createUuid(): string {
  if (!globalThis.crypto?.randomUUID) {
    throw new Error('Secure browser UUID generation is unavailable.');
  }
  return globalThis.crypto.randomUUID();
}

export class SipContactIdentityResolver {
  private volatileIdentities = new Map<string, string>();
  private storage: SipIdentityStorage | null;
  private generateUuid: () => string;

  constructor(
    storage: SipIdentityStorage | null = browserStorage(),
    generateUuid: () => string = createUuid,
  ) {
    this.storage = storage;
    this.generateUuid = generateUuid;
  }

  load(username: string, sipDomain: string): SipContactIdentity {
    const key = identityKey(username, sipDomain);
    let instanceId = this.volatileIdentities.get(key) ?? '';

    if (this.storage) {
      try {
        instanceId = this.storage.getItem(key) ?? instanceId;
      } catch {
        // The in-memory identity still keeps reconnects stable when storage is unavailable.
      }
    }

    if (!UUID_PATTERN.test(instanceId)) {
      instanceId = this.generateUuid();
      if (!UUID_PATTERN.test(instanceId)) {
        throw new Error('SIP contact identity generator returned an invalid UUID.');
      }
      if (this.storage) {
        try {
          this.storage.setItem(key, instanceId);
        } catch {
          // Continue with the session-stable identity when browser storage is blocked.
        }
      }
    }
    this.volatileIdentities.set(key, instanceId);

    const contactUser = username.replace(/[^A-Za-z0-9_.!~*'()-]/g, '') || 'user';
    const token = instanceId.replace(/-/g, '');
    return {
      contactName: `sv${contactUser}-${token.slice(0, 12)}`,
      instanceId,
      viaHost: `${token}.invalid`,
    };
  }
}

const browserIdentityResolver = new SipContactIdentityResolver();

export function loadSipContactIdentity(username: string, sipDomain: string): SipContactIdentity {
  return browserIdentityResolver.load(username, sipDomain);
}
