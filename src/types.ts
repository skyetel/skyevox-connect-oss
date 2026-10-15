export interface SipConfig {
  sipDomain?: string;
  sipServer: string;
  wssUrl: string;
  username: string;
  password: string;
  displayName: string;
  extension: string;
  smsFrom?: string;
  /** HTTPS API origin from provisioning (api_base); SIP hosts have no web service. */
  apiBase?: string;
  turnServer: string;
  turnCredentials: { username: string; credential: string };
  srtp: string;
  registerInterval: number;
  iceServers?: RTCIceServer[];
  mobile?: MobileProvisioningConfig;
  embedded?: boolean;
  extensionId?: number;
  parkCode?: string;
  /** Platform push token handed to the native engine for RFC 8599 Contact params (Android FCM). */
  pushToken?: string;
  pushProvider?: 'fcm' | 'apns-voip';
}

export interface MobileProvisioningConfig {
  engine: 'sipjs' | 'liblinphone';
  transport?: 'tcp' | 'udp' | 'tls';
  srtp?: 'mandatory' | 'opportunistic';
  pushEnabled: boolean;
  pushProvider?: { ios: 'apns-voip'; android: 'fcm' };
  pushTeamId?: string;
  pushBundleId?: string;
  /** Optional override for the FCM pn-param (Firebase sender id); defaults to google-services. */
  pushParam?: string;
  /**
   * REGISTER Expires for push-capable contacts (default 86400). Flexisip never pushes for an
   * expired binding, so the native engine uses this instead of registerInterval whenever push
   * is enabled and a token is present; a dead connection, not expiry, triggers the push.
   */
  pushRegisterExpiresSeconds?: number;
  defaultCallingEligible: boolean;
  smsEnabled: boolean;
  mmsEnabled: boolean;
  e911Enabled: boolean;
  provisioningRevision?: string;
  deviceId?: string;
  caBundleSha256?: string;
}

export interface CallState {
  status: 'idle' | 'dialing' | 'ringing' | 'active' | 'held' | 'transferring';
  direction: 'inbound' | 'outbound' | null;
  remoteNumber: string;
  remoteName: string;
  duration: number;
  muted: boolean;
  held: boolean;
}

export interface CallHistoryEntry {
  id: string;
  direction: 'inbound' | 'outbound' | 'missed';
  remoteNumber: string;
  remoteName: string;
  timestamp: Date;
  duration: number;
  qualityMetrics?: { avgMos: number; avgJitter: number; avgPacketLoss: number };
}

export interface Extension {
  id: number;
  extension: string;
  name: string;
  domain_name?: string;
  status?: 'available' | 'busy' | 'ringing' | 'offline';
}

// Phase 2 types

export interface PresenceEntry {
  id?: number;
  extension: string;
  name: string;
  domain_name?: string;
  status: 'available' | 'busy' | 'ringing' | 'offline';
}

export interface VoicemailEntry {
  id: string;
  caller_id: string;
  caller_name: string;
  duration: number;
  file_path: string;
  created_at: string;
  transcription: string;
  read?: boolean;
}

export interface ParkSlot {
  slot: number;
  uuid: string;
  node: string;
  caller_id: string;
  caller_name: string;
  pickup_code: string;
  parked_at: string;
  extension: string;
}

export interface RecordingStatus {
  recording: boolean;
  started_at: string | null;
}

export interface SupervisorCapabilities {
  enabled: boolean;
  full_control: boolean;
  can_spy: boolean;
  can_whisper: boolean;
  can_barge: boolean;
}

export interface SupervisorCall {
  uuid: string;
  direction: string;
  caller_name: string;
  caller_id: string;
  extension: string;
  destination: string;
  state: string;
  held: boolean;
  parked: boolean;
  recording: boolean;
  peer_number: string;
  created_at: string;
}

export interface SupervisorAgent {
  extension: string;
  display_name: string;
  status: 'available' | 'busy' | 'ringing' | 'offline';
}

export interface SupervisorLiveState {
  calls: SupervisorCall[];
  agents: SupervisorAgent[];
}

export interface ConferenceParticipant {
  id: string;
  name: string;
  number: string;
  muted: boolean;
  sessionId: string;
}

export interface SecondCallState {
  status: 'dialing' | 'ringing' | 'held';
  direction: 'inbound' | 'outbound';
  remoteNumber: string;
  remoteName: string;
}

// Phase 4 types

export interface CallQualityMetrics {
  mos: number;
  jitter: number;
  packetLoss: number;
  rtt: number;
  bitrate: number;
  codec: string;
  quality: 'good' | 'fair' | 'poor';
}

export interface ScreenPopData {
  found?: boolean;
  name?: string;
  company?: string;
  email?: string;
  notes?: string;
  vip?: boolean;
  tags?: string[];
  recentCallCount?: number;
}

export interface VersionInfo {
  version: string;
  release_notes?: string;
  download_url?: string;
  web_url?: string;
  mandatory?: boolean;
  published_at?: string;
}

export type MessageDirection = 'inbound' | 'outbound';
export type MessageStatus = 'queued' | 'sending' | 'sent' | 'delivered' | 'failed';

export interface MessageAttachment {
  id: string;
  url: string;
  contentType?: string;
  fileName?: string;
  sizeBytes?: number;
}

export interface MessageEntry {
  id: string;
  threadId: string;
  direction: MessageDirection;
  from: string;
  to: string;
  text: string;
  media: MessageAttachment[];
  status: MessageStatus;
  createdAt: string;
  error?: string;
}

export interface MessageThread {
  id: string;
  participants: string[];
  displayName: string;
  lastMessage: string;
  lastMessageAt: string;
  unreadCount: number;
  messages?: MessageEntry[];
}
