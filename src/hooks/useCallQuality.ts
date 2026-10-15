import { useState, useEffect, useRef, useCallback } from 'react';
import type { CallQualityMetrics } from '../types';

const POLL_INTERVAL = 2000;
export const MAX_QUALITY_HISTORY = 300;

export interface QualityAggregate {
  count: number;
  mosTotal: number;
  jitterTotal: number;
  packetLossTotal: number;
}

export function appendQualityHistory(
  history: CallQualityMetrics[],
  sample: CallQualityMetrics,
  limit = MAX_QUALITY_HISTORY
): CallQualityMetrics[] {
  if (limit <= 0) return [];
  if (limit === 1) return [sample];
  return [...history.slice(-(limit - 1)), sample];
}

export function accumulateQuality(
  aggregate: QualityAggregate | null,
  sample: CallQualityMetrics
): QualityAggregate {
  return {
    count: (aggregate?.count ?? 0) + 1,
    mosTotal: (aggregate?.mosTotal ?? 0) + sample.mos,
    jitterTotal: (aggregate?.jitterTotal ?? 0) + sample.jitter,
    packetLossTotal: (aggregate?.packetLossTotal ?? 0) + sample.packetLoss,
  };
}

export function qualityAverages(aggregate: QualityAggregate | null) {
  if (!aggregate || aggregate.count === 0) return undefined;
  return {
    avgMos: Math.round((aggregate.mosTotal / aggregate.count) * 100) / 100,
    avgJitter: Math.round((aggregate.jitterTotal / aggregate.count) * 100) / 100,
    avgPacketLoss: Math.round((aggregate.packetLossTotal / aggregate.count) * 100) / 100,
  };
}

export function shouldLogDiagnostics(sampleNumber: number, every = 3): boolean {
  return every > 0 && sampleNumber > 0 && sampleNumber % every === 0;
}


/**
 * Polls WebRTC getStats() during active calls to compute MOS, jitter, packet loss, RTT.
 */
export function useCallQuality(
  peerConnection: RTCPeerConnection | null,
  isActive: boolean,
  sessionId?: string
) {
  const [metrics, setMetrics] = useState<CallQualityMetrics | null>(null);
  const [metricsHistory, setMetricsHistory] = useState<CallQualityMetrics[]>([]);
  const prevStatsRef = useRef<{
    packetsReceived: number;
    packetsLost: number;
    timestamp: number;
    bytesReceived: number;
  } | null>(null);
  const qualityAggregateRef = useRef<QualityAggregate | null>(null);
  const diagnosticSampleRef = useRef(0);

  const pollStats = useCallback(async () => {
    if (!peerConnection) return;

    try {
      const stats = await peerConnection.getStats();
      let jitter = 0;
      let packetsLost = 0;
      let packetsReceived = 0;
      let roundTripTime = 0;
      let bytesReceived = 0;
      let codecName = '';
      let timestamp = 0;
      let inboundAudioLevel: number | undefined;
      let candidateState: string | undefined;
      let localCandidateType: string | undefined;
      let remoteCandidateType: string | undefined;
      let selectedPair: (RTCStats & Record<string, unknown>) | undefined;
      const candidates = new Map<string, RTCStats & Record<string, unknown>>();

      stats.forEach((report) => {
        const item = report as RTCStats & Record<string, unknown>;
        candidates.set(report.id, item);
        if (report.type === 'inbound-rtp' && report.kind === 'audio') {
          jitter = (report.jitter ?? 0) * 1000; // convert to ms
          packetsLost = report.packetsLost ?? 0;
          packetsReceived = report.packetsReceived ?? 0;
          bytesReceived = report.bytesReceived ?? 0;
          timestamp = report.timestamp;
        }
        if (report.type === 'remote-inbound-rtp' && report.kind === 'audio') {
          roundTripTime = (report.roundTripTime ?? 0) * 1000; // convert to ms
        }
        if (report.type === 'candidate-pair' && item.state === 'succeeded' && item.nominated) {
          selectedPair = item;
          candidateState = String(item.state);
          if (!roundTripTime && typeof item.currentRoundTripTime === 'number') {
            roundTripTime = item.currentRoundTripTime * 1000;
          }
        }
        if (report.type === 'codec' && report.mimeType?.startsWith('audio/')) {
          codecName = report.mimeType.replace('audio/', '');
        }
        if (report.type === 'inbound-rtp' && report.kind === 'audio' && typeof item.audioLevel === 'number') {
          inboundAudioLevel = item.audioLevel;
        }
      });
      if (selectedPair) {
        const local = candidates.get(String(selectedPair.localCandidateId));
        const remote = candidates.get(String(selectedPair.remoteCandidateId));
        if (local?.candidateType) localCandidateType = String(local.candidateType);
        if (remote?.candidateType) remoteCandidateType = String(remote.candidateType);
      }

      // Calculate packet loss rate from deltas
      let packetLossRate = 0;
      let bitrate = 0;
      const prev = prevStatsRef.current;
      if (prev && timestamp > prev.timestamp) {
        const deltaReceived = packetsReceived - prev.packetsReceived;
        const deltaLost = packetsLost - prev.packetsLost;
        const total = deltaReceived + deltaLost;
        packetLossRate = total > 0 ? (deltaLost / total) * 100 : 0;

        const deltaBytes = bytesReceived - prev.bytesReceived;
        const deltaTime = (timestamp - prev.timestamp) / 1000; // seconds
        bitrate = deltaTime > 0 ? (deltaBytes * 8) / deltaTime / 1000 : 0; // kbps
      }

      prevStatsRef.current = { packetsReceived, packetsLost, timestamp, bytesReceived };

      // Compute MOS via simplified E-model
      const effectiveLatency = roundTripTime / 2 + jitter + 20;
      let R = 93.2 - effectiveLatency * 0.024 - packetLossRate * 2.5;
      R = Math.max(0, Math.min(100, R));
      let mos = 1 + 0.035 * R + 7e-6 * R * (R - 60) * (100 - R);
      mos = Math.max(1, Math.min(5, mos));

      const quality: 'good' | 'fair' | 'poor' =
        mos >= 4.0 ? 'good' : mos >= 3.0 ? 'fair' : 'poor';

      const m: CallQualityMetrics = {
        mos: Math.round(mos * 100) / 100,
        jitter: Math.round(jitter * 100) / 100,
        packetLoss: Math.round(packetLossRate * 100) / 100,
        rtt: Math.round(roundTripTime * 100) / 100,
        bitrate: Math.round(bitrate * 10) / 10,
        codec: codecName || 'unknown',
        quality,
      };

      qualityAggregateRef.current = accumulateQuality(qualityAggregateRef.current, m);
      setMetrics(m);
      setMetricsHistory((history) => appendQualityHistory(history, m));
      diagnosticSampleRef.current += 1;
      if (window.electronAPI?.isElectron && shouldLogDiagnostics(diagnosticSampleRef.current)) {
        void window.electronAPI.logRenderer?.('info', 'Desktop call audio diagnostics.', {
          sessionId: sessionId || 'active',
          inboundPackets: packetsReceived,
          inboundBytes: bytesReceived,
          inboundAudioLevel,
          inboundJitter: jitter / 1000,
          candidateState,
          localCandidateType,
          remoteCandidateType,
          remoteTrackCount: peerConnection.getReceivers().filter((receiver) => receiver.track?.kind === 'audio').length,
        }).catch(() => {});
      }
    } catch {
      // Stats unavailable
    }
  }, [peerConnection, sessionId]);

  useEffect(() => {
    if (!isActive || !peerConnection) {
      qualityAggregateRef.current = null;
      const reset = setTimeout(() => setMetrics(null), 0);
      return () => clearTimeout(reset);
    }

    prevStatsRef.current = null;
    qualityAggregateRef.current = null;
    diagnosticSampleRef.current = 0;
    const resetHistory = setTimeout(() => setMetricsHistory([]), 0);
    const interval = setInterval(pollStats, POLL_INTERVAL);
    // Initial poll after a short delay
    const timer = setTimeout(pollStats, 500);

    return () => {
      clearTimeout(resetHistory);
      clearInterval(interval);
      clearTimeout(timer);
    };
  }, [isActive, peerConnection, pollStats]);

  return { metrics, metricsHistory, qualityAggregateRef };
}
