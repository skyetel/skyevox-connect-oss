import { apiUrlForConfig } from '../platform';
import type { MessageEntry, MessageThread, SipConfig } from '../types';

export interface SendMessageRequest {
  from: string;
  to: string;
  text: string;
  media?: string[];
}

async function parseJson<T>(response: Response, fallback: T): Promise<T> {
  if (!response.ok) return fallback;
  try {
    return await response.json() as T;
  } catch {
    return fallback;
  }
}

export async function fetchMessageThreads(config: SipConfig): Promise<MessageThread[]> {
  const extension = encodeURIComponent(config.extension);
  const domain = encodeURIComponent(config.sipDomain || config.sipServer);
  const response = await fetch(apiUrlForConfig(`/api/connect/messages/${extension}/threads?domain=${domain}&tenant=${domain}`, config));
  const data = await parseJson<MessageThread[]>(response, []);
  return Array.isArray(data) ? data : [];
}

export async function fetchMessageThread(config: SipConfig, threadId: string): Promise<MessageEntry[]> {
  const extension = encodeURIComponent(config.extension);
  const domain = encodeURIComponent(config.sipDomain || config.sipServer);
  const encodedThread = encodeURIComponent(threadId);
  const response = await fetch(apiUrlForConfig(`/api/connect/messages/${extension}/threads/${encodedThread}?domain=${domain}&tenant=${domain}`, config));
  const data = await parseJson<MessageEntry[]>(response, []);
  return Array.isArray(data) ? data : [];
}

export async function sendSmsMessage(config: SipConfig, request: SendMessageRequest): Promise<MessageEntry> {
  const extension = encodeURIComponent(config.extension);
  const domain = encodeURIComponent(config.sipDomain || config.sipServer);
  const response = await fetch(apiUrlForConfig(`/api/connect/messages/${extension}/send?domain=${domain}&tenant=${domain}`, config), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(body || `Message send failed with HTTP ${response.status}`);
  }

  return response.json() as Promise<MessageEntry>;
}
