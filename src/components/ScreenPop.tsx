import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { ScreenPopData } from '../types';

interface Props {
  data: ScreenPopData;
  onDismiss: () => void;
}

export function ScreenPop({ data, onDismiss }: Props) {
  const { t } = useTranslation();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Auto-dismiss after 30 seconds
  useEffect(() => {
    timerRef.current = setTimeout(onDismiss, 30000);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [onDismiss]);

  return (
    <div
      className="absolute inset-x-0 top-0 z-20 animate-slide-down"
      role="complementary"
      aria-label={t('screenpop.close')}
    >
      <div className="bg-white border-b-2 border-sky-400 shadow-lg rounded-b-xl p-3 mx-1 mt-1">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-full bg-sky-100 flex items-center justify-center shrink-0">
              <svg className="w-4 h-4 text-sky-600" fill="currentColor" viewBox="0 0 24 24">
                <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" />
              </svg>
            </div>
            <div>
              <div className="flex items-center gap-1.5">
                <span className="text-sm font-semibold text-gray-800">{data.name || 'Unknown'}</span>
                {data.vip && (
                  <span className="bg-amber-100 text-amber-700 text-[9px] font-bold px-1.5 py-0.5 rounded-full">
                    {t('screenpop.vip')}
                  </span>
                )}
              </div>
              {data.company && (
                <div className="text-xs text-gray-500">{data.company}</div>
              )}
              {data.email && (
                <div className="text-xs text-gray-400">{data.email}</div>
              )}
            </div>
          </div>
          <button
            onClick={onDismiss}
            className="text-gray-400 hover:text-gray-600 text-lg leading-none p-1"
            aria-label={t('screenpop.close')}
          >
            &times;
          </button>
        </div>

        {data.notes && (
          <div className="mt-2 text-xs text-gray-600 bg-gray-50 rounded p-1.5">
            <span className="font-medium text-gray-500">{t('screenpop.notes')}:</span> {data.notes}
          </div>
        )}

        {data.tags && data.tags.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {data.tags.map((tag) => (
              <span
                key={tag}
                className="text-[10px] bg-sky-50 text-sky-600 px-1.5 py-0.5 rounded-full"
              >
                {tag}
              </span>
            ))}
          </div>
        )}

        {typeof data.recentCallCount === 'number' && data.recentCallCount > 0 && (
          <div className="mt-1.5 text-[10px] text-gray-400">
            {t('screenpop.recentCalls')}: {data.recentCallCount}
          </div>
        )}
      </div>
    </div>
  );
}
