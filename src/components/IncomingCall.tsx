import { useTranslation } from 'react-i18next';
import { Haptics, ImpactStyle } from '@capacitor/haptics';
import { useSwipeHandlers } from '../hooks/useSwipeGesture';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { isNative } from '../platform';

interface Props {
  callerName: string;
  callerNumber: string;
  answering: boolean;
  onAnswer: () => void;
  onReject: () => void;
}

export function IncomingCall({ callerName, callerNumber, answering, onAnswer, onReject }: Props) {
  const { t } = useTranslation();
  const trapRef = useFocusTrap<HTMLDivElement>();

  const hapticFeedback = async () => {
    if (isNative()) {
      try { await Haptics.impact({ style: ImpactStyle.Medium }); } catch { /* noop */ }
    }
  };

  const handleAnswer = () => {
    if (answering) return;
    hapticFeedback();
    onAnswer();
  };

  const handleReject = () => {
    hapticFeedback();
    onReject();
  };

  const swipeHandlers = useSwipeHandlers({
    onSwipeRight: handleAnswer,
    onSwipeLeft: handleReject,
  });

  return (
    <div
      ref={trapRef}
      role="alertdialog"
      aria-label={t('call.incomingFrom', { name: callerName || callerNumber })}
      aria-busy={answering}
      className="flex flex-col items-center gap-4 py-6 animate-pulse no-select"
      {...swipeHandlers}
    >
      <div className="w-16 h-16 rounded-full bg-sky-100 flex items-center justify-center">
        <svg className="w-8 h-8 text-sky-600" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/>
        </svg>
      </div>
      <div className="text-center">
        <div className="text-lg font-semibold text-gray-800">{callerName || t('call.unknown')}</div>
        <div className="text-sm text-gray-500">{callerNumber}</div>
        <div className="text-sm text-sky-600 mt-1" role="status">
          {t(answering ? 'call.answering' : 'call.incoming')}
        </div>
        {answering && <div className="text-sm text-gray-500 mt-1">{t('call.microphonePrompt')}</div>}
      </div>

      {/* Swipe hints (mobile only) */}
      {isNative() && (
        <div className="flex items-center justify-between w-full px-8 mt-1">
          <span className="text-xs text-red-400 swipe-hint-left" aria-hidden="true">&larr; {t('incoming.swipeReject')}</span>
          <span className="text-xs text-green-500 swipe-hint-right" aria-hidden="true">{t('incoming.swipeAnswer')} &rarr;</span>
        </div>
      )}

      <div className="flex gap-6 mt-2">
        <button
          onClick={handleReject}
          aria-label={t('controls.reject')}
          className="w-14 h-14 rounded-full bg-red-500 hover:bg-red-600 active:scale-95 text-white flex items-center justify-center shadow-lg touch-target transition-transform"
        >
          <svg className="w-6 h-6 rotate-[135deg]" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M20.01 15.38c-1.23 0-2.42-.2-3.53-.56a.977.977 0 00-1.01.24l-1.57 1.97c-2.83-1.35-5.48-3.9-6.89-6.83l1.95-1.66c.27-.28.35-.67.24-1.02-.37-1.11-.56-2.3-.56-3.53 0-.54-.45-.99-.99-.99H4.19C3.65 3 3 3.24 3 3.99 3 13.28 10.73 21 20.01 21c.71 0 .99-.63.99-1.18v-3.45c0-.54-.45-.99-.99-.99z"/>
          </svg>
        </button>
        <button
          onClick={handleAnswer}
          aria-label={t('controls.answer')}
          disabled={answering}
          className="w-14 h-14 rounded-full bg-green-500 hover:bg-green-600 active:scale-95 disabled:opacity-50 disabled:cursor-wait text-white flex items-center justify-center shadow-lg touch-target transition-transform"
        >
          <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M20.01 15.38c-1.23 0-2.42-.2-3.53-.56a.977.977 0 00-1.01.24l-1.57 1.97c-2.83-1.35-5.48-3.9-6.89-6.83l1.95-1.66c.27-.28.35-.67.24-1.02-.37-1.11-.56-2.3-.56-3.53 0-.54-.45-.99-.99-.99H4.19C3.65 3 3 3.24 3 3.99 3 13.28 10.73 21 20.01 21c.71 0 .99-.63.99-1.18v-3.45c0-.54-.45-.99-.99-.99z"/>
          </svg>
        </button>
      </div>
    </div>
  );
}
