export const NATIVE_ENGINE = 'liblinphone';

/**
 * The native liblinphone engine is used only where the SkyeVoxNative bridge is implemented
 * (Android and iOS) and provisioning selects it. Every other platform/engine uses SIP.js.
 */
export function platformUsesNativeEngine(platform: string, engine?: string): boolean {
  return (platform === 'android' || platform === 'ios') && engine === NATIVE_ENGINE;
}

export function platformUsesLocalRingtone(platform: string, engine?: string): boolean {
  return !platformUsesNativeEngine(platform, engine);
}
