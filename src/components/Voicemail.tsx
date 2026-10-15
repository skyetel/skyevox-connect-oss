import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/useStore';
import { isNative } from '../platform';
import { deleteVoicemail, fetchVoicemailAudio, markVoicemailRead, voicemailApiHeaders, voicemailApiUrl } from '../api/voicemail';
import type { VoicemailEntry } from '../types';

// Slower polling on mobile to save battery
const POLL_INTERVAL = isNative() ? 60000 : 15000;

export function Voicemail() {
  const { t } = useTranslation();
  const { voicemails, setVoicemails, removeVoicemail, setUnreadVoicemailCount, sipConfig } = useStore();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [playErrorId, setPlayErrorId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteErrorId, setDeleteErrorId] = useState<string | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [downloadErrorId, setDownloadErrorId] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioURLRef = useRef<string | null>(null);

  const extension = sipConfig?.extension;

  const fetchVoicemails = useCallback(() => {
    if (!extension || !sipConfig) return;
    const request = { headers: voicemailApiHeaders(sipConfig) };
    fetch(voicemailApiUrl(`/api/connect/voicemail/${extension}`), request)
      .then((r) => {
        if (!r.ok) throw new Error(`Voicemail request failed: ${r.status}`);
        return r.json();
      })
      .then((data) => {
        if (Array.isArray(data)) {
          setVoicemails(data);
        }
      })
      .catch(() => {});

    fetch(voicemailApiUrl(`/api/connect/voicemail/${extension}/count`), request)
      .then((r) => {
        if (!r.ok) throw new Error(`Voicemail count request failed: ${r.status}`);
        return r.json();
      })
      .then((data) => {
        if (typeof data.count === 'number') {
          setUnreadVoicemailCount(useStore.getState().activeTab === 'voicemail' ? 0 : data.count);
        }
      })
      .catch(() => {});
  }, [extension, setVoicemails, setUnreadVoicemailCount, sipConfig]);

  useEffect(() => {
    fetchVoicemails();
    const interval = setInterval(fetchVoicemails, POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [fetchVoicemails]);

  const stopPlayback = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    if (audioURLRef.current) {
      URL.revokeObjectURL(audioURLRef.current);
      audioURLRef.current = null;
    }
    setPlayingId(null);
    setLoadingId(null);
  }, []);

  const handleRead = useCallback(async (vm: VoicemailEntry) => {
    if (!sipConfig || vm.read) return;
    await markVoicemailRead(sipConfig, vm.id);
    const updated = useStore.getState().voicemails.map((entry) => (
      entry.id === vm.id ? { ...entry, read: true } : entry
    ));
    setVoicemails(updated);
    setUnreadVoicemailCount(updated.filter((entry) => !entry.read).length);
  }, [setUnreadVoicemailCount, setVoicemails, sipConfig]);

  const handlePlay = useCallback(async (vm: VoicemailEntry) => {
    if (!sipConfig) return;
    if (playingId === vm.id) {
      stopPlayback();
      return;
    }
    stopPlayback();
    setPlayErrorId(null);
    setLoadingId(vm.id);
    try {
      const blob = await fetchVoicemailAudio(sipConfig, vm.id);
      const objectURL = URL.createObjectURL(blob);
      const audio = new Audio(objectURL);
      audioRef.current = audio;
      audioURLRef.current = objectURL;
      audio.onended = stopPlayback;
      audio.onerror = () => {
        setPlayErrorId(vm.id);
        stopPlayback();
      };
      await audio.play();
      setLoadingId(null);
      setPlayingId(vm.id);
      void handleRead(vm).catch(() => {});
    } catch {
      setPlayErrorId(vm.id);
      stopPlayback();
    }
  }, [handleRead, playingId, sipConfig, stopPlayback]);

  useEffect(() => stopPlayback, [stopPlayback]);

  const handleDownload = useCallback(async (vm: VoicemailEntry) => {
    if (!sipConfig) return;
    setDownloadingId(vm.id);
    setDownloadErrorId(null);
    try {
      const blob = await fetchVoicemailAudio(sipConfig, vm.id);
      const objectURL = URL.createObjectURL(blob);
      const link = document.createElement('a');
      const caller = (vm.caller_id || 'message').replace(/[^a-zA-Z0-9_-]/g, '') || 'message';
      const createdAt = new Date(vm.created_at);
      const day = Number.isNaN(createdAt.getTime()) ? 'unknown-date' : createdAt.toISOString().slice(0, 10);
      link.href = objectURL;
      link.download = `voicemail-${day}-${caller}.wav`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectURL), 1000);
      await handleRead(vm).catch(() => {});
    } catch {
      setDownloadErrorId(vm.id);
    } finally {
      setDownloadingId(null);
    }
  }, [handleRead, sipConfig]);

  const handleDelete = useCallback(async (vm: VoicemailEntry) => {
    if (!sipConfig || !window.confirm(t('voicemail.deleteConfirm'))) return;
    if (playingId === vm.id) stopPlayback();
    setDeleteErrorId(null);
    setDeletingId(vm.id);
    try {
      await deleteVoicemail(sipConfig, vm.id);
      removeVoicemail(vm.id);
      setExpandedId(null);
      fetchVoicemails();
    } catch {
      setDeleteErrorId(vm.id);
    } finally {
      setDeletingId(null);
    }
  }, [fetchVoicemails, playingId, removeVoicemail, sipConfig, stopPlayback, t]);


  const formatDuration = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  const formatTime = (dateStr: string) => {
    const d = new Date(dateStr);
    const now = new Date();
    const isToday = d.toDateString() === now.toDateString();
    if (isToday) {
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    return (
      d.toLocaleDateString([], { month: 'short', day: 'numeric' }) +
      ' ' +
      d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    );
  };

  const truncateTranscription = (text: string, maxLen: number = 60) => {
    if (!text) return t('voicemail.noTranscription');
    if (text.length <= maxLen) return text;
    return text.slice(0, maxLen) + '...';
  };


  if (!extension) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-gray-400">
        <span className="text-sm">{t('voicemail.notConfigured')}</span>
      </div>
    );
  }

  if (voicemails.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-gray-400">
        <svg className="w-12 h-12 mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
          />
        </svg>
        <span className="text-sm">{t('voicemail.noVoicemails')}</span>
      </div>
    );
  }

  return (
    <div className="overflow-y-auto max-h-[380px]" role="list" aria-label={t('tab.voicemail')}>
      {voicemails.map((vm) => (
        <div
          key={vm.id}
          role="listitem"
          className={`voicemail-item border-b border-gray-100 ${deletingId === vm.id ? 'opacity-50' : ''}`}
        >
          <div
            className="flex items-center gap-3 px-3 py-2.5 hover:bg-gray-50 transition-colors cursor-pointer touch-target"
            onClick={() => setExpandedId(expandedId === vm.id ? null : vm.id)}
          >

            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                void handlePlay(vm);
              }}
              disabled={loadingId === vm.id}
              aria-label={playingId === vm.id ? t('voicemail.stop') : t('voicemail.play')}
              className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 transition-colors ${
                playingId === vm.id
                  ? 'bg-sky-500 text-white'
                  : 'bg-gray-100 text-gray-500 hover:bg-gray-200 disabled:opacity-50'
              }`}
            >
              {playingId === vm.id ? (
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
                </svg>
              ) : (
                <svg className="w-4 h-4 ml-0.5" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M8 5v14l11-7z" />
                </svg>
              )}
            </button>
            {/* Info */}
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-gray-800 truncate">
                {vm.caller_name || vm.caller_id || t('call.unknown')}
              </div>
              <div className="text-xs text-gray-400 truncate">
                {truncateTranscription(vm.transcription)}
              </div>
            </div>

            {/* Meta */}
            <div className="text-right shrink-0">
              <div className="text-xs text-gray-400">{formatTime(vm.created_at)}</div>
              <div className="text-xs text-gray-300">{formatDuration(vm.duration)}</div>
            </div>
          </div>

          {/* Expanded view */}
          {expandedId === vm.id && (
            <div className="px-3 pb-3 bg-gray-50">
              <div className="text-xs text-gray-500 mb-1">
                {t('voicemail.from')} {vm.caller_name ? `${vm.caller_name} (${vm.caller_id})` : vm.caller_id}
              </div>
              {vm.transcription && (
                <div className="text-xs text-gray-600 bg-white rounded p-2 mb-2 border border-gray-100">
                  {vm.transcription}
                </div>
              )}
              {playErrorId === vm.id && (
                <div className="text-xs text-red-500 mt-2">{t('voicemail.audioUnavailable')}</div>
              )}
              {deleteErrorId === vm.id && (
                <div className="text-xs text-red-500 mt-2">{t('voicemail.deleteFailed')}</div>
              )}
              {downloadErrorId === vm.id && (
                <div className="text-xs text-red-500 mt-2">{t('voicemail.downloadFailed')}</div>
              )}
              <div className="flex justify-end gap-2 mt-2">
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    void handleDownload(vm);
                  }}
                  disabled={downloadingId === vm.id}
                  aria-label={`${t('voicemail.download')} ${vm.caller_name || vm.caller_id}`}
                  className="px-3 py-1 bg-sky-50 text-sky-600 text-xs rounded-lg hover:bg-sky-100 disabled:opacity-50 transition-colors font-medium touch-target"
                >
                  {t('voicemail.download')}
                </button>
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    void handleDelete(vm);
                  }}
                  disabled={deletingId === vm.id}
                  aria-label={`${t('voicemail.delete')} ${vm.caller_name || vm.caller_id}`}
                  className="px-3 py-1 bg-red-50 text-red-500 text-xs rounded-lg hover:bg-red-100 disabled:opacity-50 transition-colors font-medium touch-target"
                >
                  {t('voicemail.delete')}
                </button>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
