import { useTranslation } from 'react-i18next';
import { useStore } from '../store/useStore';

interface Props {
  onCall: (number: string) => void;
}

export function CallHistory({ onCall }: Props) {
  const { t } = useTranslation();
  const { callHistory } = useStore();

  const formatDuration = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  const formatTime = (date: Date) => {
    const d = new Date(date);
    const now = new Date();
    const isToday = d.toDateString() === now.toDateString();
    if (isToday) {
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' +
           d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const directionIcon = (dir: string) => {
    switch (dir) {
      case 'outbound': return '\u2197';
      case 'inbound': return '\u2199';
      case 'missed': return '\u2199';
      default: return '\u2022';
    }
  };

  const directionLabel = (dir: string) => {
    switch (dir) {
      case 'outbound': return t('history.outbound');
      case 'inbound': return t('history.inbound');
      case 'missed': return t('history.missed');
      default: return '';
    }
  };

  const qualityDot = (avgMos?: number) => {
    if (avgMos == null) return null;
    const color = avgMos >= 4.0 ? 'bg-green-400' : avgMos >= 3.0 ? 'bg-yellow-400' : 'bg-red-400';
    return <span className={`w-1.5 h-1.5 rounded-full ${color} inline-block ml-1`} aria-hidden="true" />;
  };

  if (callHistory.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-gray-400">
        <svg className="w-12 h-12 mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
        </svg>
        <span className="text-sm">{t('history.noRecent')}</span>
      </div>
    );
  }

  return (
    <div className="overflow-y-auto max-h-[340px]" role="list" aria-label={t('tab.recent')}>
      {callHistory.map((entry) => (
        <button
          key={entry.id}
          role="listitem"
          onClick={() => onCall(entry.remoteNumber)}
          aria-label={`${directionLabel(entry.direction)}: ${entry.remoteName || entry.remoteNumber}, ${formatDuration(entry.duration)}`}
          className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-gray-50 transition-colors border-b border-gray-100"
        >
          <span className={`text-lg ${entry.direction === 'missed' ? 'text-red-500' : entry.direction === 'outbound' ? 'text-green-500' : 'text-sky-500'}`} aria-hidden="true">
            {directionIcon(entry.direction)}
          </span>
          <div className="flex-1 text-left">
            <div className="text-sm font-medium text-gray-800">{entry.remoteName || entry.remoteNumber}</div>
            <div className="text-xs text-gray-400">{formatTime(entry.timestamp)}</div>
          </div>
          <div className="text-xs text-gray-400 flex items-center">
            {formatDuration(entry.duration)}
            {qualityDot(entry.qualityMetrics?.avgMos)}
          </div>
        </button>
      ))}
    </div>
  );
}
