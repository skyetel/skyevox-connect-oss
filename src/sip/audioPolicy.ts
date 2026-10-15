export function canUseDirectAudioPath(desiredSinkId: string, supportsContextSink: boolean): boolean {
  return desiredSinkId === '' || supportsContextSink;
}

export interface ConferenceAudioEndpoint<T> {
  id: string;
  localTrack: T;
  remoteTracks: T[];
}

export function conferenceMixTracksFor<T>(
  endpoints: ConferenceAudioEndpoint<T>[],
  recipientId: string,
): T[] {
  if (endpoints.length < 2) {
    throw new Error('A local conference requires at least two established calls.');
  }
  const recipient = endpoints.find((endpoint) => endpoint.id === recipientId);
  if (!recipient) {
    throw new Error(`Conference recipient ${recipientId} is not established.`);
  }
  const tracks = [
    recipient.localTrack,
    ...endpoints
      .filter((endpoint) => endpoint.id !== recipientId)
      .flatMap((endpoint) => endpoint.remoteTracks),
  ];
  return Array.from(new Set(tracks));
}
