import { useTranslation } from 'react-i18next';

interface Props {
  callerName: string;
  callerNumber: string;
  onAnswerHoldCurrent: () => void;
  onReject: () => void;
  onMerge: () => void;
}

export function CallWaiting({ callerName, callerNumber, onAnswerHoldCurrent, onReject, onMerge }: Props) {
  const { t } = useTranslation();

  return (
    <div className="absolute inset-x-0 bottom-0 bg-white border-t-2 border-amber-400 shadow-lg rounded-t-xl p-4 z-10" role="alertdialog" aria-label={t('callWaiting.title')}>
      <div className="flex items-center gap-3 mb-3">
        <div className="w-10 h-10 rounded-full bg-amber-100 flex items-center justify-center">
          <svg className="w-5 h-5 text-amber-600" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M20.01 15.38c-1.23 0-2.42-.2-3.53-.56a.977.977 0 00-1.01.24l-1.57 1.97c-2.83-1.35-5.48-3.9-6.89-6.83l1.95-1.66c.27-.28.35-.67.24-1.02-.37-1.11-.56-2.3-.56-3.53 0-.54-.45-.99-.99-.99H4.19C3.65 3 3 3.24 3 3.99 3 13.28 10.73 21 20.01 21c.71 0 .99-.63.99-1.18v-3.45c0-.54-.45-.99-.99-.99z" />
          </svg>
        </div>
        <div className="flex-1">
          <div className="text-sm font-semibold text-gray-800">{callerName || t('call.unknown')}</div>
          <div className="text-xs text-gray-500">{callerNumber}</div>
          <div className="text-xs text-amber-600 font-medium">{t('callWaiting.title')}</div>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2">
        {/* Answer (hold current) */}
        <button
          onClick={onAnswerHoldCurrent}
          aria-label={t('callWaiting.holdAndAnswer')}
          className="flex flex-col items-center gap-1 py-2 px-1 bg-green-50 text-green-600 rounded-lg hover:bg-green-100 transition-colors"
        >
          <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M20.01 15.38c-1.23 0-2.42-.2-3.53-.56a.977.977 0 00-1.01.24l-1.57 1.97c-2.83-1.35-5.48-3.9-6.89-6.83l1.95-1.66c.27-.28.35-.67.24-1.02-.37-1.11-.56-2.3-.56-3.53 0-.54-.45-.99-.99-.99H4.19C3.65 3 3 3.24 3 3.99 3 13.28 10.73 21 20.01 21c.71 0 .99-.63.99-1.18v-3.45c0-.54-.45-.99-.99-.99z" />
          </svg>
          <span className="text-[10px] font-medium leading-tight text-center">{t('callWaiting.holdAndAnswer')}</span>
        </button>

        {/* Reject */}
        <button
          onClick={onReject}
          aria-label={t('callWaiting.reject')}
          className="flex flex-col items-center gap-1 py-2 px-1 bg-red-50 text-red-500 rounded-lg hover:bg-red-100 transition-colors"
        >
          <svg className="w-5 h-5 rotate-[135deg]" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M20.01 15.38c-1.23 0-2.42-.2-3.53-.56a.977.977 0 00-1.01.24l-1.57 1.97c-2.83-1.35-5.48-3.9-6.89-6.83l1.95-1.66c.27-.28.35-.67.24-1.02-.37-1.11-.56-2.3-.56-3.53 0-.54-.45-.99-.99-.99H4.19C3.65 3 3 3.24 3 3.99 3 13.28 10.73 21 20.01 21c.71 0 .99-.63.99-1.18v-3.45c0-.54-.45-.99-.99-.99z" />
          </svg>
          <span className="text-[10px] font-medium leading-tight text-center">{t('callWaiting.reject')}</span>
        </button>

        {/* Merge (conference) */}
        <button
          onClick={onMerge}
          aria-label={t('callWaiting.merge')}
          className="flex flex-col items-center gap-1 py-2 px-1 bg-purple-50 text-purple-600 rounded-lg hover:bg-purple-100 transition-colors"
        >
          <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M9 13.75c-2.34 0-7 1.17-7 3.5V19h14v-1.75c0-2.33-4.66-3.5-7-3.5zM4.34 17c.84-.58 2.87-1.25 4.66-1.25s3.82.67 4.66 1.25H4.34zM9 12c1.93 0 3.5-1.57 3.5-3.5S10.93 5 9 5 5.5 6.57 5.5 8.5 7.07 12 9 12zm0-5c.83 0 1.5.67 1.5 1.5S9.83 10 9 10s-1.5-.67-1.5-1.5S8.17 7 9 7zm7.04 6.81c1.16.84 1.96 1.96 1.96 3.44V19h4v-1.75c0-2.02-3.5-3.17-5.96-3.44zM15 12c1.93 0 3.5-1.57 3.5-3.5S16.93 5 15 5c-.54 0-1.04.13-1.5.35.63.89 1 1.98 1 3.15s-.37 2.26-1 3.15c.46.22.96.35 1.5.35z" />
          </svg>
          <span className="text-[10px] font-medium leading-tight text-center">{t('callWaiting.merge')}</span>
        </button>
      </div>
    </div>
  );
}
