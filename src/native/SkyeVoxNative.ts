import { registerPlugin } from '@capacitor/core';
import type { PluginListenerHandle } from '@capacitor/core';
import type { SipConfig } from '../types';

export type NativeRegistrationState = 'idle' | 'registering' | 'registered' | 'unregistered' | 'failed';
export type NativeCallState = 'idle' | 'incoming' | 'dialing' | 'ringing' | 'active' | 'held' | 'ended' | 'failed';

export interface NativeCallEvent {
  callId: string;
  state: NativeCallState;
  direction: 'inbound' | 'outbound';
  remoteNumber: string;
  remoteName?: string;
  error?: string;
}

export interface NativeRegistrationEvent {
  state: NativeRegistrationState;
  accountId?: string;
  error?: string;
}

export interface NativePushTokenEvent {
  platform: 'ios' | 'android';
  token: string;
  bundleId?: string;
}

export interface NativeDefaultCallingStatus {
  supported: boolean;
  eligible: boolean;
  enabled: boolean;
  reason?: string;
}

export interface SkyeVoxNativePlugin {
  configure(options: { config: SipConfig }): Promise<void>;
  register(): Promise<void>;
  unregister(): Promise<void>;
  call(options: { destination: string; displayName?: string }): Promise<{ callId: string }>;
  answer(options: { callId: string }): Promise<void>;
  reject(options: { callId: string }): Promise<void>;
  hangup(options: { callId: string }): Promise<void>;
  hold(options: { callId: string }): Promise<void>;
  unhold(options: { callId: string }): Promise<void>;
  mute(options: { callId: string; muted: boolean }): Promise<void>;
  sendDtmf(options: { callId: string; digit: string }): Promise<void>;
  transfer(options: { callId: string; destination: string; attended?: boolean }): Promise<void>;
  getDefaultCallingStatus(): Promise<NativeDefaultCallingStatus>;
  openDefaultCallingSettings(): Promise<void>;
  addListener(eventName: 'registrationChanged', listenerFunc: (event: NativeRegistrationEvent) => void): Promise<PluginListenerHandle>;
  addListener(eventName: 'callChanged', listenerFunc: (event: NativeCallEvent) => void): Promise<PluginListenerHandle>;
  addListener(eventName: 'pushTokenChanged', listenerFunc: (event: NativePushTokenEvent) => void): Promise<PluginListenerHandle>;
  removeAllListeners(): Promise<void>;
}

export const SkyeVoxNative = registerPlugin<SkyeVoxNativePlugin>('SkyeVoxNative');
