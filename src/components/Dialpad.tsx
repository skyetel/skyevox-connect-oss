import { useTranslation } from 'react-i18next';
import { useStore } from '../store/useStore';
import { Haptics, ImpactStyle } from '@capacitor/haptics';
import { isNative } from '../platform';

const KEYS = [
  ['1', '2', '3'],
  ['4', '5', '6'],
  ['7', '8', '9'],
  ['*', '0', '#'],
];

const SUB_LABELS: Record<string, string> = {
  '1': '', '2': 'ABC', '3': 'DEF',
  '4': 'GHI', '5': 'JKL', '6': 'MNO',
  '7': 'PQRS', '8': 'TUV', '9': 'WXYZ',
  '*': '', '0': '+', '#': '',
};

interface Props {
  onDial: (number: string) => void;
  onDTMF?: (digit: string) => void;
  inCall?: boolean;
}

export function Dialpad({ onDial, onDTMF, inCall }: Props) {
  const { t } = useTranslation();
  const { dialInput, setDialInput } = useStore();

  const hapticTap = async () => {
    if (isNative()) {
      try { await Haptics.impact({ style: ImpactStyle.Light }); } catch { /* noop */ }
    }
  };

  const handleKey = (key: string) => {
    hapticTap();
    if (inCall && onDTMF) {
      onDTMF(key);
    } else {
      setDialInput(dialInput + key);
    }
  };

  const handleBackspace = () => {
    setDialInput(dialInput.slice(0, -1));
  };

  const handleCall = () => {
    if (dialInput.trim()) {
      onDial(dialInput.trim());
    }
  };

  return (
    <div className="flex flex-col items-center gap-2 px-3 py-2">
      {/* Number display */}
      {!inCall && (
        <div className="flex items-center w-full bg-gray-50 rounded-lg px-3 py-2 mb-1">
          <input
            type="text"
            inputMode="tel"
            value={dialInput}
            onChange={(e) => setDialInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleCall()}
            placeholder={t('dialpad.placeholder')}
            aria-label={t('dialpad.placeholder')}
            className="flex-1 bg-transparent text-center text-xl font-mono outline-none text-gray-800"
          />
          {dialInput && (
            <button
              onClick={handleBackspace}
              className="text-gray-400 hover:text-gray-600 ml-2 text-lg touch-target"
              aria-label={t('dialpad.backspace')}
            >
              &#9003;
            </button>
          )}
        </div>
      )}

      {/* Keypad */}
      <div className="grid grid-cols-3 gap-2 w-full max-w-[240px]" role="group" aria-label={t('tab.dialpad')}>
        {KEYS.map((row) =>
          row.map((key) => (
            <button
              key={key}
              onClick={() => handleKey(key)}
              aria-label={key === '*' ? 'Star' : key === '#' ? 'Hash' : key}
              className="flex flex-col items-center justify-center w-16 h-16 mx-auto rounded-full bg-gray-100 hover:bg-gray-200 active:bg-sky-100 active:scale-95 transition-all touch-target"
            >
              <span className="text-xl font-semibold text-gray-800">{key}</span>
              <span className="text-[9px] text-gray-400 tracking-widest" aria-hidden="true">{SUB_LABELS[key]}</span>
            </button>
          ))
        )}
      </div>

      {/* Call button */}
      {!inCall && (
        <button
          onClick={handleCall}
          disabled={!dialInput.trim()}
          aria-label={t('dialpad.call')}
          className="mt-2 w-16 h-16 rounded-full bg-green-500 hover:bg-green-600 disabled:bg-gray-300 active:scale-95 text-white flex items-center justify-center transition-all shadow-lg touch-target"
        >
          <svg className="w-7 h-7" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M20.01 15.38c-1.23 0-2.42-.2-3.53-.56a.977.977 0 00-1.01.24l-1.57 1.97c-2.83-1.35-5.48-3.9-6.89-6.83l1.95-1.66c.27-.28.35-.67.24-1.02-.37-1.11-.56-2.3-.56-3.53 0-.54-.45-.99-.99-.99H4.19C3.65 3 3 3.24 3 3.99 3 13.28 10.73 21 20.01 21c.71 0 .99-.63.99-1.18v-3.45c0-.54-.45-.99-.99-.99z"/>
          </svg>
        </button>
      )}
    </div>
  );
}
