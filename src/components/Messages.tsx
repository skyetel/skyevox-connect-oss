import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchMessageThread, fetchMessageThreads, sendSmsMessage } from '../api/messages';
import { useStore } from '../store/useStore';
import type { MessageEntry, MessageThread } from '../types';

function formatMessageTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

function normalizePhoneInput(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('+')) return trimmed;
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length >= 11) return `+${digits}`;
  return digits;
}

export function Messages() {
  const { t } = useTranslation();
  const {
    sipConfig,
    messageThreads,
    setMessageThreads,
    setUnreadMessageCount,
  } = useStore();
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<MessageEntry[]>([]);
  const [recipient, setRecipient] = useState('');
  const [body, setBody] = useState('');
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedThread = useMemo(
    () => messageThreads.find((thread) => thread.id === selectedThreadId) ?? null,
    [messageThreads, selectedThreadId],
  );

  const sourceNumber = sipConfig?.smsFrom || sipConfig?.extension || '';

  const refreshThreads = useCallback(() => {
    if (!sipConfig) return;
    setLoading(true);
    fetchMessageThreads(sipConfig)
      .then((threads) => {
        setMessageThreads(threads);
        setUnreadMessageCount(threads.reduce((total, thread) => total + (thread.unreadCount || 0), 0));
        if (!selectedThreadId && threads[0]) {
          setSelectedThreadId(threads[0].id);
        }
      })
      .catch(() => setError(t('messages.loadFailed')))
      .finally(() => setLoading(false));
  }, [selectedThreadId, setMessageThreads, setUnreadMessageCount, sipConfig, t]);

  useEffect(() => {
    refreshThreads();
    const interval = setInterval(refreshThreads, 15000);
    return () => clearInterval(interval);
  }, [refreshThreads]);

  useEffect(() => {
    if (!sipConfig || !selectedThreadId) {
      setMessages([]);
      return;
    }
    fetchMessageThread(sipConfig, selectedThreadId)
      .then(setMessages)
      .catch(() => setError(t('messages.loadFailed')));
  }, [selectedThreadId, sipConfig, t]);

  const handleSend = async () => {
    if (!sipConfig) return;
    const cleanBody = body.trim();
    const to = selectedThread?.participants.find((participant) => participant !== sourceNumber)
      || normalizePhoneInput(recipient);
    if (!to || !cleanBody) return;

    setSending(true);
    setError(null);
    try {
      const sent = await sendSmsMessage(sipConfig, {
        from: sourceNumber,
        to,
        text: cleanBody,
      });
      setMessages((current) => [...current, sent]);
      setBody('');
      setRecipient('');
      refreshThreads();
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : t('messages.sendFailed'));
    } finally {
      setSending(false);
    }
  };

  if (!sipConfig) {
    return (
      <div className="flex h-[340px] items-center justify-center px-4 text-center text-sm text-gray-500">
        {t('messages.notConfigured')}
      </div>
    );
  }

  return (
    <div className="flex h-[420px] flex-col bg-white">
      <div className="border-b border-gray-100 px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-gray-800">{t('messages.title')}</h2>
          <button
            type="button"
            onClick={refreshThreads}
            className="rounded-md border border-gray-200 px-2 py-1 text-xs font-semibold text-gray-600 hover:bg-gray-50"
          >
            {t('messages.refresh')}
          </button>
        </div>
        {!selectedThread && (
          <input
            value={recipient}
            onChange={(event) => setRecipient(event.target.value)}
            className="mt-2 min-h-9 w-full rounded-lg border border-gray-200 px-3 text-sm outline-none focus:border-sky-400 focus:ring-2 focus:ring-sky-100"
            placeholder={t('messages.recipientPlaceholder')}
            inputMode="tel"
          />
        )}
      </div>

      {error && (
        <div className="mx-3 mt-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700" role="alert">
          {error}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <div className="w-[112px] shrink-0 overflow-y-auto border-r border-gray-100">
          {loading && messageThreads.length === 0 ? (
            <div className="p-3 text-xs text-gray-400">{t('messages.loading')}</div>
          ) : messageThreads.length === 0 ? (
            <div className="p-3 text-xs text-gray-400">{t('messages.noThreads')}</div>
          ) : (
            messageThreads.map((thread: MessageThread) => (
              <button
                key={thread.id}
                type="button"
                onClick={() => setSelectedThreadId(thread.id)}
                className={`w-full border-b border-gray-100 px-2 py-2 text-left transition-colors ${
                  selectedThreadId === thread.id ? 'bg-sky-50' : 'hover:bg-gray-50'
                }`}
              >
                <div className="truncate text-xs font-semibold text-gray-800">{thread.displayName}</div>
                <div className="mt-0.5 truncate text-[11px] text-gray-500">{thread.lastMessage}</div>
                {thread.unreadCount > 0 && (
                  <span className="mt-1 inline-flex min-w-4 justify-center rounded-full bg-sky-600 px-1.5 py-0.5 text-[10px] font-bold text-white">
                    {thread.unreadCount}
                  </span>
                )}
              </button>
            ))
          )}
          <button
            type="button"
            onClick={() => {
              setSelectedThreadId(null);
              setMessages([]);
              setRecipient('');
            }}
            className="w-full px-2 py-2 text-left text-xs font-semibold text-sky-700 hover:bg-sky-50"
          >
            {t('messages.newThread')}
          </button>
        </div>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-3">
            {messages.length === 0 ? (
              <div className="flex h-full items-center justify-center text-center text-xs text-gray-400">
                {selectedThread ? t('messages.noMessages') : t('messages.pickThread')}
              </div>
            ) : (
              messages.map((message) => {
                const outbound = message.direction === 'outbound';
                return (
                  <div key={message.id} className={`flex ${outbound ? 'justify-end' : 'justify-start'}`}>
                    <div className={`max-w-[86%] rounded-lg px-3 py-2 text-sm ${
                      outbound ? 'bg-sky-600 text-white' : 'bg-gray-100 text-gray-800'
                    }`}>
                      <div className="whitespace-pre-wrap break-words">{message.text}</div>
                      {(message.media || []).length > 0 && (
                        <div className="mt-2 space-y-1">
                          {(message.media || []).map((media) => (
                            <a
                              key={media.id}
                              href={media.url}
                              target="_blank"
                              rel="noreferrer"
                              className={`block truncate text-xs underline ${outbound ? 'text-sky-100' : 'text-sky-700'}`}
                            >
                              {media.fileName || media.contentType || t('messages.attachment')}
                            </a>
                          ))}
                        </div>
                      )}
                      <div className={`mt-1 text-[10px] ${outbound ? 'text-sky-100' : 'text-gray-400'}`}>
                        {formatMessageTime(message.createdAt)} · {message.status}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          <div className="border-t border-gray-100 p-2">
            <textarea
              value={body}
              onChange={(event) => setBody(event.target.value)}
              className="min-h-16 w-full resize-none rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-sky-400 focus:ring-2 focus:ring-sky-100"
              placeholder={t('messages.bodyPlaceholder')}
            />
            <button
              type="button"
              onClick={handleSend}
              disabled={sending || !body.trim() || (!selectedThread && !recipient.trim())}
              className="mt-2 min-h-10 w-full rounded-lg bg-sky-600 px-4 text-sm font-semibold text-white hover:bg-sky-700 disabled:cursor-not-allowed disabled:bg-gray-300"
            >
              {sending ? t('messages.sending') : t('messages.send')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
