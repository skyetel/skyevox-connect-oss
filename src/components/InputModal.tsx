import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useFocusTrap } from '../hooks/useFocusTrap';

interface Props {
  title: string;
  placeholder?: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

/**
 * Native-friendly modal to replace browser prompt() dialogs.
 * Capacitor WebView doesn't support window.prompt().
 */
export function InputModal({ title, placeholder, onSubmit, onCancel }: Props) {
  const { t } = useTranslation();
  const trapRef = useFocusTrap<HTMLDivElement>();
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Auto-focus with a small delay for mobile keyboards
    const timer = setTimeout(() => inputRef.current?.focus(), 100);
    return () => clearTimeout(timer);
  }, []);

  const handleSubmit = () => {
    const trimmed = value.trim();
    if (trimmed) {
      onSubmit(trimmed);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label={title}>
      <div ref={trapRef} className="bg-white rounded-xl shadow-2xl w-full max-w-[280px] overflow-hidden">
        <div className="px-4 pt-4 pb-2">
          <h3 className="text-sm font-semibold text-gray-800">{title}</h3>
        </div>
        <div className="px-4 pb-3">
          <input
            ref={inputRef}
            type="text"
            inputMode="tel"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
            placeholder={placeholder || t('modal.defaultPlaceholder')}
            aria-label={placeholder || t('modal.defaultPlaceholder')}
            className="w-full px-3 py-2.5 bg-gray-50 rounded-lg text-sm outline-none focus:ring-2 focus:ring-sky-300 border border-gray-200"
          />
        </div>
        <div className="flex border-t border-gray-200">
          <button
            onClick={onCancel}
            className="flex-1 py-3 text-sm text-gray-500 hover:bg-gray-50 transition-colors font-medium"
          >
            {t('modal.cancel')}
          </button>
          <button
            onClick={handleSubmit}
            className="flex-1 py-3 text-sm text-sky-600 hover:bg-sky-50 transition-colors font-medium border-l border-gray-200"
          >
            {t('modal.ok')}
          </button>
        </div>
      </div>
    </div>
  );
}
