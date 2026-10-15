import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CallQualityMetrics } from '../types';

interface Props {
  metrics: CallQualityMetrics | null;
}

export function CallQualityIndicator({ metrics }: Props) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  if (!metrics) return null;

  const dotColor =
    metrics.quality === 'good'
      ? 'bg-green-400'
      : metrics.quality === 'fair'
      ? 'bg-yellow-400'
      : 'bg-red-400';

  const qualityLabel = t(`quality.${metrics.quality}`);

  return (
    <div className="relative inline-flex items-center">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1 px-1.5 py-0.5 rounded-full hover:bg-gray-100 transition-colors"
        aria-label={t('quality.callQuality') + ': ' + qualityLabel}
        aria-expanded={expanded}
      >
        <span className={`w-2 h-2 rounded-full ${dotColor}`} aria-hidden="true" />
      </button>

      {expanded && (
        <div
          className="absolute top-full left-1/2 -translate-x-1/2 mt-2 bg-white rounded-lg shadow-xl border border-gray-200 p-3 w-48 z-20"
          role="tooltip"
        >
          <div className="text-xs font-semibold text-gray-500 uppercase mb-2">
            {t('quality.callQuality')}
          </div>
          <div className="space-y-1.5">
            <div className="flex justify-between text-xs">
              <span className="text-gray-500">{t('quality.mos')}</span>
              <span className={`font-medium ${
                metrics.quality === 'good' ? 'text-green-600' :
                metrics.quality === 'fair' ? 'text-yellow-600' : 'text-red-600'
              }`}>
                {metrics.mos.toFixed(1)} ({qualityLabel})
              </span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-gray-500">{t('quality.jitter')}</span>
              <span className="text-gray-700">{metrics.jitter.toFixed(0)}ms</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-gray-500">{t('quality.packetLoss')}</span>
              <span className="text-gray-700">{metrics.packetLoss.toFixed(1)}%</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-gray-500">{t('quality.rtt')}</span>
              <span className="text-gray-700">{metrics.rtt.toFixed(0)}ms</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-gray-500">{t('quality.bitrate')}</span>
              <span className="text-gray-700">{metrics.bitrate.toFixed(0)}kbps</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-gray-500">{t('quality.codec')}</span>
              <span className="text-gray-700">{metrics.codec}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
