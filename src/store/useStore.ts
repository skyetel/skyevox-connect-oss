import { create } from 'zustand';
import type {
  SipConfig,
  CallState,
  CallHistoryEntry,
  Extension,
  VoicemailEntry,
  ParkSlot,
  PresenceEntry,
  SecondCallState,
  RecordingStatus,
  CallQualityMetrics,
  MessageThread,
} from '../types';

type TabId = 'dialpad' | 'recent' | 'directory' | 'voicemail' | 'messages' | 'supervisor' | 'settings';

interface AppState {
  // SIP Config
  sipConfig: SipConfig | null;
  setSipConfig: (config: SipConfig | null) => void;

  // Registration
  registered: boolean;
  setRegistered: (val: boolean) => void;

  // Call state
  call: CallState;
  setCall: (call: Partial<CallState>) => void;
  resetCall: () => void;

  // UI state
  activeTab: TabId;
  setActiveTab: (tab: TabId) => void;
  dialInput: string;
  setDialInput: (val: string) => void;

  // Call history
  callHistory: CallHistoryEntry[];
  setCallHistory: (entries: CallHistoryEntry[]) => void;
  addCallHistory: (entry: CallHistoryEntry) => void;

  // Directory
  extensions: Extension[];
  setExtensions: (exts: Extension[]) => void;
  directoryLoaded: boolean;
  setDirectoryLoaded: (loaded: boolean) => void;

  // Audio
  audioInputDevice: string;
  audioOutputDevice: string;
  ringtoneDevice: string;
  setAudioInputDevice: (id: string) => void;
  setAudioOutputDevice: (id: string) => void;
  setRingtoneDevice: (id: string) => void;
  ringtone: string;
  setRingtone: (name: string) => void;
  volume: number;
  setVolume: (vol: number) => void;

  // Phase 2: Presence
  presenceData: PresenceEntry[];
  setPresenceData: (data: PresenceEntry[]) => void;

  // Phase 2: Voicemail
  voicemails: VoicemailEntry[];
  setVoicemails: (vms: VoicemailEntry[]) => void;
  removeVoicemail: (id: string) => void;
  unreadVoicemailCount: number;
  setUnreadVoicemailCount: (count: number) => void;

  // Messages / SMS + MMS
  messageThreads: MessageThread[];
  setMessageThreads: (threads: MessageThread[]) => void;
  unreadMessageCount: number;
  setUnreadMessageCount: (count: number) => void;

  // Phase 2: Park Slots
  parkSlots: ParkSlot[];
  setParkSlots: (slots: ParkSlot[]) => void;

  // Phase 2: DND
  dndEnabled: boolean;
  setDndEnabled: (val: boolean) => void;

  // Phase 2: Recording
  recordingStatus: RecordingStatus;
  setRecordingStatus: (status: RecordingStatus) => void;

  // Phase 2: Second call / Call Waiting
  secondCall: SecondCallState | null;
  setSecondCall: (call: SecondCallState | null) => void;

  // Phase 2: Conference
  conferenceActive: boolean;
  setConferenceActive: (val: boolean) => void;

  // Phase 4: CRM Screen Pop
  screenPopEnabled: boolean;
  setScreenPopEnabled: (val: boolean) => void;
  crmWebhookUrl: string | null;
  setCrmWebhookUrl: (url: string | null) => void;

  // Phase 4: Call Quality
  lastCallQuality: CallQualityMetrics | null;
  setLastCallQuality: (metrics: CallQualityMetrics | null) => void;
}

const defaultCallState: CallState = {
  status: 'idle',
  direction: null,
  remoteNumber: '',
  remoteName: '',
  duration: 0,
  muted: false,
  held: false,
};

export const useStore = create<AppState>((set) => ({
  sipConfig: null,
  setSipConfig: (config) => set((state) => ({
    sipConfig: config,
    directoryLoaded: false,
    dndEnabled: config && state.sipConfig
      && config.extension === state.sipConfig.extension
      && (config.sipDomain || config.sipServer) === (state.sipConfig.sipDomain || state.sipConfig.sipServer)
      ? state.dndEnabled
      : false,
  })),

  registered: false,
  setRegistered: (val) => set({ registered: val }),

  call: { ...defaultCallState },
  setCall: (callUpdate) => set((state) => ({ call: { ...state.call, ...callUpdate } })),
  resetCall: () => set({ call: { ...defaultCallState } }),

  activeTab: 'dialpad',
  setActiveTab: (tab) => set({ activeTab: tab }),
  dialInput: '',
  setDialInput: (val) => set({ dialInput: val }),

  callHistory: [],
  setCallHistory: (entries) => set({ callHistory: entries.slice(0, 100) }),
  addCallHistory: (entry) => set((state) => ({
    callHistory: [entry, ...state.callHistory].slice(0, 100)
  })),

  extensions: [],
  setExtensions: (exts) => set({ extensions: exts }),
  directoryLoaded: false,
  setDirectoryLoaded: (loaded) => set({ directoryLoaded: loaded }),

  audioInputDevice: 'default',
  audioOutputDevice: 'default',
  ringtoneDevice: 'default',
  setAudioInputDevice: (id) => set({ audioInputDevice: id }),
  setAudioOutputDevice: (id) => set({ audioOutputDevice: id }),
  setRingtoneDevice: (id) => set({ ringtoneDevice: id }),
  ringtone: 'default',
  setRingtone: (name) => set({ ringtone: name }),
  volume: 80,
  setVolume: (vol) => set({ volume: vol }),

  // Phase 2: Presence
  presenceData: [],
  setPresenceData: (data) => set({ presenceData: data }),

  // Phase 2: Voicemail
  voicemails: [],
  setVoicemails: (vms) => set({ voicemails: vms }),
  removeVoicemail: (id) => set((state) => ({
    voicemails: state.voicemails.filter((vm) => vm.id !== id),
  })),
  unreadVoicemailCount: 0,
  setUnreadVoicemailCount: (count) => set({ unreadVoicemailCount: count }),

  // Messages / SMS + MMS
  messageThreads: [],
  setMessageThreads: (threads) => set({ messageThreads: threads }),
  unreadMessageCount: 0,
  setUnreadMessageCount: (count) => set({ unreadMessageCount: count }),

  // Phase 2: Park Slots
  parkSlots: [],
  setParkSlots: (slots) => set({ parkSlots: slots }),

  // Phase 2: DND
  dndEnabled: false,
  setDndEnabled: (val) => set({ dndEnabled: val }),

  // Phase 2: Recording
  recordingStatus: { recording: false, started_at: null },
  setRecordingStatus: (status) => set({ recordingStatus: status }),

  // Phase 2: Second call / Call Waiting
  secondCall: null,
  setSecondCall: (call) => set({ secondCall: call }),

  // Phase 2: Conference
  conferenceActive: false,
  setConferenceActive: (val) => set({ conferenceActive: val }),

  // Phase 4: CRM Screen Pop
  screenPopEnabled: false,
  setScreenPopEnabled: (val) => set({ screenPopEnabled: val }),
  crmWebhookUrl: null,
  setCrmWebhookUrl: (url) => set({ crmWebhookUrl: url }),

  // Phase 4: Call Quality
  lastCallQuality: null,
  setLastCallQuality: (metrics) => set({ lastCallQuality: metrics }),
}));
