import assert from 'node:assert/strict';
import test from 'node:test';

import { deleteVoicemail, fetchVoicemailAudio, markVoicemailRead, voicemailApiHeaders, voicemailApiUrl } from './voicemail.ts';
import type { SipConfig } from '../types.ts';

const config = {
  extension: '550',
  password: 'sip-secret',
  sipDomain: 'tslhg.skyetel.ai',
  sipServer: 'connect.skyetel.ai',
} as SipConfig;

test('desktop voicemail uses the NG API instead of the retired Python host', () => {
  assert.equal(
    voicemailApiUrl('/api/connect/voicemail/550'),
    'https://skyevox.skyetel.ai/api/connect/voicemail/550',
  );
});

test('voicemail HTTP authorization is bound to the registered extension and tenant', () => {
  const headers = voicemailApiHeaders(config);
  assert.match(headers.Authorization, /^Basic /);
  const encoded = headers.Authorization.slice('Basic '.length);
  assert.equal(atob(encoded), '550@tslhg.skyetel.ai:sip-secret');
});

test('voicemail playback fetches authenticated audio bytes', async () => {
  const originalFetch = globalThis.fetch;
  let requestUrl = '';
  let requestAuthorization = '';
  globalThis.fetch = (async (input, init) => {
    requestUrl = String(input);
    requestAuthorization = new Headers(init?.headers).get('Authorization') || '';
    return new Response(new Blob(['RIFF-audio'], { type: 'audio/wav' }), {
      status: 200,
      headers: { 'Content-Type': 'audio/wav' },
    });
  }) as typeof fetch;
  try {
    const audio = await fetchVoicemailAudio(config, 'message-1');
    assert.equal(requestUrl, 'https://skyevox.skyetel.ai/api/connect/voicemail/550/message-1/audio');
    assert.match(requestAuthorization, /^Basic /);
    assert.equal(audio.type, 'audio/wav');
    assert.equal(await audio.text(), 'RIFF-audio');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('voicemail deletion uses authenticated DELETE for the registered mailbox', async () => {
  const originalFetch = globalThis.fetch;
  let requestUrl = '';
  let requestMethod = '';
  let requestAuthorization = '';
  globalThis.fetch = (async (input, init) => {
    requestUrl = String(input);
    requestMethod = init?.method || '';
    requestAuthorization = new Headers(init?.headers).get('Authorization') || '';
    return new Response(JSON.stringify({ ok: true, id: 'message-1' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  try {
    await deleteVoicemail(config, 'message-1');
    assert.equal(requestUrl, 'https://skyevox.skyetel.ai/api/connect/voicemail/550/message-1');
    assert.equal(requestMethod, 'DELETE');
    assert.match(requestAuthorization, /^Basic /);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('listening marks only the selected voicemail read', async () => {
  const originalFetch = globalThis.fetch;
  let requestUrl = '';
  let requestMethod = '';
  globalThis.fetch = (async (input, init) => {
    requestUrl = String(input);
    requestMethod = init?.method || '';
    return new Response(JSON.stringify({ ok: true, id: 'message-1', read: true }), { status: 200 });
  }) as typeof fetch;
  try {
    await markVoicemailRead(config, 'message-1');
    assert.equal(requestUrl, 'https://skyevox.skyetel.ai/api/connect/voicemail/550/message-1/read');
    assert.equal(requestMethod, 'POST');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
