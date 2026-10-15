import { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/useStore';
import { Haptics, ImpactStyle } from '@capacitor/haptics';
import { apiUrlForConfig, isNative } from '../platform';
import { CallQualityIndicator } from './CallQualityIndicator';
import type { CallQualityMetrics } from '../types';
import { parkActiveCall } from '../callPark';

interface Props {
  muted: boolean;
  held: boolean;
  onMute: () => void;
  onHold: () => void;
  onHangup: () => void;
  onTransfer: () => void;
  onPark: (destination?: string) => Promise<void>;
  onConference: () => void;
  onMerge: () => void;
  duration: string;
  remoteName: string;
  remoteNumber: string;
  conferenceActive: boolean;
  canMerge: boolean;
  conferencePending?: boolean;
  conferenceParticipants: Array<{ id: string; name: string; number: string }>;
  onDropParticipant: (sessionId: string) => void;
  qualityMetrics?: CallQualityMetrics | null;
}

export function CallControls({
  muted,
  held,
  onMute,
  onHold,
  onHangup,
  onTransfer,
  onPark,
  onConference,
  onMerge,
  duration,
  remoteName,
  remoteNumber,
  conferenceActive,
  canMerge,
  conferencePending = false,
  conferenceParticipants,
  onDropParticipant,
  qualityMetrics,
}: Props) {
  const { t } = useTranslation();
  const { recordingStatus, setRecordingStatus, sipConfig } = useStore();
  const recordingIntervalRef = useRef<number | undefined>(undefined);
  const parkNoticeTimerRef = useRef<number | undefined>(undefined);
  const [parkSlotNumber, setParkSlotNumber] = useState<number | null>(null);
  const [parkError, setParkError] = useState<string | null>(null);
  const [parking, setParking] = useState(false);

  const extension = sipConfig?.extension;

  const hapticFeedback = async () => {
    if (isNative()) {
      try { await Haptics.impact({ style: ImpactStyle.Heavy }); } catch { /* noop */ }
    }
  };

  // Check recording status periodically
  const checkRecording = useCallback(() => {
    if (!extension) return;
    const path = sipConfig?.embedded
      ? `/api/connect/web/recording/${encodeURIComponent(extension)}?tenant=${encodeURIComponent(sipConfig.sipDomain || sipConfig.sipServer)}`
      : `/api/connect/recording/${extension}`;
    fetch(apiUrlForConfig(path, sipConfig))
      .then((r) => r.json())
      .then((data) => {
        setRecordingStatus({
          recording: data.recording ?? false,
          started_at: data.started_at ?? null,
        });
      })
      .catch(() => {});
  }, [extension, setRecordingStatus, sipConfig]);

  useEffect(() => {
    checkRecording();
    recordingIntervalRef.current = window.setInterval(checkRecording, 10000);
    return () => {
      clearInterval(recordingIntervalRef.current);
      clearTimeout(parkNoticeTimerRef.current);
    };
  }, [checkRecording]);

  const handlePark = async () => {
    if (!extension || !sipConfig || parking) return;
    setParking(true);
    setParkError(null);
    try {
      const result = await parkActiveCall(sipConfig, onPark);
      setParkSlotNumber(result.slot);
      clearTimeout(parkNoticeTimerRef.current);
      parkNoticeTimerRef.current = window.setTimeout(() => setParkSlotNumber(null), 10000);
    } catch (error) {
      setParkError(error instanceof Error ? error.message : 'Call park failed.');
    } finally {
      setParking(false);
    }
  };

  const handleHangup = () => {
    hapticFeedback();
    onHangup();
  };

  return (
    <div className="flex flex-col items-center gap-3 py-4">
      {/* Recording indicator */}
      {recordingStatus.recording && (
        <div className="flex items-center gap-1.5 bg-red-50 text-red-600 px-3 py-1 rounded-full text-xs font-medium" role="status" aria-live="polite">
          <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse-rec" aria-hidden="true" />
          {t('controls.rec')}
        </div>
      )}

      {/* Call info */}
      <div className="text-center">
        {conferenceActive ? (
          <>
            <div className="text-lg font-semibold text-gray-800">{t('call.conferenceCall')}</div>
            <div className="flex items-center justify-center gap-1">
              <div className="text-2xl font-mono text-sky-600 mt-1" aria-live="polite" aria-label={`Duration ${duration}`}>{duration}</div>
              <CallQualityIndicator metrics={qualityMetrics ?? null} />
            </div>
          </>
        ) : (
          <>
            <div className="text-lg font-semibold text-gray-800">{remoteName || remoteNumber}</div>
            {remoteName && remoteNumber && (
              <div className="text-sm text-gray-500">{remoteNumber}</div>
            )}
            <div className="flex items-center justify-center gap-1">
              <div className="text-2xl font-mono text-sky-600 mt-1" aria-live="polite" aria-label={`Duration ${duration}`}>{duration}</div>
              <CallQualityIndicator metrics={qualityMetrics ?? null} />
            </div>
            {held && <div className="text-sm text-amber-500 font-medium mt-1">{t('call.onHold')}</div>}
          </>
        )}
      </div>
      {parkSlotNumber !== null && (
        <div className="rounded-full bg-amber-50 px-3 py-1 text-sm font-medium text-amber-700" role="status" aria-live="polite">
          {t('controls.parkedInSlot', { slot: parkSlotNumber })}
        </div>
      )}
      {parkError && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
          {parkError}
        </div>
      )}
      {/* Conference participants */}
      {conferenceActive && conferenceParticipants.length > 0 && (
        <div className="w-full px-4">
          <div className="text-xs font-semibold text-gray-500 uppercase mb-1">{t('controls.participants')}</div>
          <div role="list">
            {conferenceParticipants.map((p) => (
              <div
                key={p.id}
                role="listitem"
                className="flex items-center justify-between py-1.5 px-2 bg-gray-50 rounded-lg mb-1"
              >
                <div className="text-sm text-gray-700">{p.name || p.number}</div>
                <button
                  onClick={() => onDropParticipant(p.id)}
                  className="text-xs text-red-500 hover:text-red-700 font-medium touch-target"
                  aria-label={`${t('controls.drop')} ${p.name || p.number}`}
                >
                  {t('controls.drop')}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Control buttons - Row 1 */}
      <div className="grid grid-cols-3 gap-4 mt-2">
        <button
          onClick={onMute}
          aria-pressed={muted}
          aria-label={muted ? t('controls.unmute') : t('controls.mute')}
          className={`flex flex-col items-center gap-1 p-3 rounded-xl transition-colors touch-target ${
            muted ? 'bg-red-100 text-red-600' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
          }`}
        >
          <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            {muted ? (
              <path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z" />
            ) : (
              <path d="M12 14c1.66 0 2.99-1.34 2.99-3L15 5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z" />
            )}
          </svg>
          <span className="text-xs">{muted ? t('controls.unmute') : t('controls.mute')}</span>
        </button>

        <button
          onClick={onHold}
          aria-pressed={held}
          aria-label={held ? t('controls.resume') : t('controls.hold')}
          className={`flex flex-col items-center gap-1 p-3 rounded-xl transition-colors touch-target ${
            held ? 'bg-amber-100 text-amber-600' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
          }`}
        >
          <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
          </svg>
          <span className="text-xs">{held ? t('controls.resume') : t('controls.hold')}</span>
        </button>

        <button
          onClick={onTransfer}
          aria-label={t('controls.transfer')}
          className="flex flex-col items-center gap-1 p-3 rounded-xl bg-gray-100 text-gray-600 hover:bg-gray-200 transition-colors touch-target"
        >
          <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.61 1.31 2.92 2.92 2.92 1.61 0 2.92-1.31 2.92-2.92s-1.31-2.92-2.92-2.92z" />
          </svg>
          <span className="text-xs">{t('controls.transfer')}</span>
        </button>
      </div>

      {/* Control buttons - Row 2 */}
      <div className="grid grid-cols-3 gap-4">
        <button
          onClick={() => void handlePark()}
          disabled={parking}
          aria-busy={parking}
          aria-label={t('controls.park')}
          className="flex flex-col items-center gap-1 p-3 rounded-xl bg-gray-100 text-gray-600 hover:bg-gray-200 transition-colors touch-target disabled:cursor-wait disabled:opacity-60"
        >
          <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M13 3H6v18h4v-6h3c3.31 0 6-2.69 6-6s-2.69-6-6-6zm.2 8H10V7h3.2c1.1 0 2 .9 2 2s-.9 2-2 2z" />
          </svg>
          <span className="text-xs">{parking ? `${t('controls.park')}…` : t('controls.park')}</span>
        </button>

        {conferenceActive ? (
          <button
            onClick={onConference}
            disabled={conferencePending}
            aria-label={t('controls.split')}
            className="flex flex-col items-center gap-1 p-3 rounded-xl bg-purple-100 text-purple-600 hover:bg-purple-200 transition-colors touch-target"
          >
            <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M9 13.75c-2.34 0-7 1.17-7 3.5V19h14v-1.75c0-2.33-4.66-3.5-7-3.5zM4.34 17c.84-.58 2.87-1.25 4.66-1.25s3.82.67 4.66 1.25H4.34zM9 12c1.93 0 3.5-1.57 3.5-3.5S10.93 5 9 5 5.5 6.57 5.5 8.5 7.07 12 9 12zm0-5c.83 0 1.5.67 1.5 1.5S9.83 10 9 10s-1.5-.67-1.5-1.5S8.17 7 9 7zm7.04 6.81c1.16.84 1.96 1.96 1.96 3.44V19h4v-1.75c0-2.02-3.5-3.17-5.96-3.44zM15 12c1.93 0 3.5-1.57 3.5-3.5S16.93 5 15 5c-.54 0-1.04.13-1.5.35.63.89 1 1.98 1 3.15s-.37 2.26-1 3.15c.46.22.96.35 1.5.35z" />
            </svg>
            <span className="text-xs">{t('controls.split')}</span>
          </button>
        ) : (
          <button
            onClick={onConference}
            disabled={conferencePending || canMerge}
            aria-label={t('controls.conference')}
            className="flex flex-col items-center gap-1 p-3 rounded-xl bg-gray-100 text-gray-600 hover:bg-gray-200 transition-colors touch-target"
          >
            <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M9 13.75c-2.34 0-7 1.17-7 3.5V19h14v-1.75c0-2.33-4.66-3.5-7-3.5zM4.34 17c.84-.58 2.87-1.25 4.66-1.25s3.82.67 4.66 1.25H4.34zM9 12c1.93 0 3.5-1.57 3.5-3.5S10.93 5 9 5 5.5 6.57 5.5 8.5 7.07 12 9 12zm0-5c.83 0 1.5.67 1.5 1.5S9.83 10 9 10s-1.5-.67-1.5-1.5S8.17 7 9 7zm7.04 6.81c1.16.84 1.96 1.96 1.96 3.44V19h4v-1.75c0-2.02-3.5-3.17-5.96-3.44zM15 12c1.93 0 3.5-1.57 3.5-3.5S16.93 5 15 5c-.54 0-1.04.13-1.5.35.63.89 1 1.98 1 3.15s-.37 2.26-1 3.15c.46.22.96.35 1.5.35z" />
            </svg>
            <span className="text-xs">{t('controls.conference')}</span>
          </button>
        )}

        {!conferenceActive && canMerge ? (
          <button
            onClick={onMerge}
            disabled={conferencePending}
            aria-label={t('controls.merge')}
            className="flex flex-col items-center gap-1 p-3 rounded-xl bg-green-100 text-green-600 hover:bg-green-200 transition-colors touch-target"
          >
            <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M17 20.41L18.41 19 15 15.59 13.59 17 17 20.41zM7.5 8H11v5.59L5.59 19 7 20.41l6-6V8h3.5L12 3.5 7.5 8z" />
            </svg>
            <span className="text-xs">{t('controls.merge')}</span>
          </button>
        ) : (
          <div />
        )}
      </div>

      {/* Hangup */}
      <button
        onClick={handleHangup}
        aria-label={t('controls.hangup')}
        className="mt-3 w-16 h-16 rounded-full bg-red-500 hover:bg-red-600 active:scale-95 text-white flex items-center justify-center shadow-lg transition-all touch-target"
      >
        <svg className="w-7 h-7 rotate-[135deg]" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M20.01 15.38c-1.23 0-2.42-.2-3.53-.56a.977.977 0 00-1.01.24l-1.57 1.97c-2.83-1.35-5.48-3.9-6.89-6.83l1.95-1.66c.27-.28.35-.67.24-1.02-.37-1.11-.56-2.3-.56-3.53 0-.54-.45-.99-.99-.99H4.19C3.65 3 3 3.24 3 3.99 3 13.28 10.73 21 20.01 21c.71 0 .99-.63.99-1.18v-3.45c0-.54-.45-.99-.99-.99z" />
        </svg>
      </button>
    </div>
  );
}
