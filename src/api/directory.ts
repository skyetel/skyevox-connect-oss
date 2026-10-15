import { voicemailApiHeaders, voicemailApiUrl } from './voicemail.ts';
import type { Extension, SipConfig } from '../types.ts';

export interface DirectoryEntry {
  id: string;
  kind: 'extension' | 'contact';
  extension: string;
  number: string;
  name: string;
  email: string;
  status: NonNullable<Extension['status']>;
}

export async function fetchDirectory(config: SipConfig, signal?: AbortSignal): Promise<DirectoryEntry[]> {
  const response = await fetch(
    voicemailApiUrl(`/api/connect/directory/${encodeURIComponent(config.extension)}`),
    { headers: voicemailApiHeaders(config), signal },
  );
  if (!response.ok) throw new Error(`Directory request failed (${response.status}).`);
  const entries: unknown = await response.json();
  if (!Array.isArray(entries)) throw new Error('Directory returned an invalid response.');
  return entries as DirectoryEntry[];
}

export function directoryExtensions(entries: DirectoryEntry[]): Extension[] {
  return entries.filter((entry) => entry.kind === 'extension').map((entry) => ({
    id: Number(entry.id.slice('ext-'.length)),
    extension: entry.extension,
    name: entry.name,
    status: entry.status,
  }));
}
