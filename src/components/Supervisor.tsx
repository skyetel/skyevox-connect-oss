import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { fetchSupervisorLive, runSupervisorAction, type SupervisorAction } from '../api/supervisor';
import type { SipConfig, SupervisorCapabilities, SupervisorLiveState } from '../types';

interface SupervisorProps {
  config: SipConfig;
  capabilities: SupervisorCapabilities;
}

const EMPTY_LIVE: SupervisorLiveState = { calls: [], agents: [] };

export function Supervisor({ config, capabilities }: SupervisorProps) {
  const { t } = useTranslation();
  const [live, setLive] = useState<SupervisorLiveState>(EMPTY_LIVE);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionUUID, setActionUUID] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [transferTargets, setTransferTargets] = useState<Record<string, string>>({});

  const refresh = useCallback(() => {
    fetchSupervisorLive(config)
      .then((state) => {
        setLive({ calls: Array.isArray(state.calls) ? state.calls : [], agents: Array.isArray(state.agents) ? state.agents : [] });
        setError(null);
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : t('supervisor.loadFailed')))
      .finally(() => setLoading(false));
  }, [config, t]);

  useEffect(() => {
    refresh();
    const interval = window.setInterval(refresh, 5000);
    return () => window.clearInterval(interval);
  }, [refresh]);

  const agentCounts = useMemo(() => ({
    available: live.agents.filter((agent) => agent.status === 'available').length,
    busy: live.agents.filter((agent) => agent.status === 'busy' || agent.status === 'ringing').length,
    offline: live.agents.filter((agent) => agent.status === 'offline').length,
  }), [live.agents]);

  const act = async (uuid: string, action: SupervisorAction, destination = '') => {
    if (action === 'hangup' && !window.confirm(t('supervisor.endConfirm'))) return;
    setActionUUID(uuid);
    setError(null);
    setMessage(null);
    try {
      const result = await runSupervisorAction(config, uuid, action, destination);
      setMessage(result.message || t('supervisor.actionComplete'));
      refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('supervisor.actionFailed'));
    } finally {
      setActionUUID(null);
    }
  };

  const statusColor = (status: string) => {
    if (status === 'available') return 'bg-green-400';
    if (status === 'busy') return 'bg-red-400';
    if (status === 'ringing') return 'bg-amber-400';
    return 'bg-gray-300';
  };

  return (
    <div className="max-h-[520px] overflow-y-auto bg-white p-3">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-gray-800">{t('supervisor.title')}</h2>
          <p className="text-xs text-gray-400">{t('supervisor.tenantScope')}</p>
        </div>
        <button type="button" onClick={refresh} className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-semibold text-gray-600 hover:bg-gray-50">
          {t('supervisor.refresh')}
        </button>
      </div>

      <div className="mb-3 grid grid-cols-3 gap-2" aria-label={t('supervisor.agentStatus')}>
        <div className="rounded-lg bg-green-50 p-2 text-center"><div className="text-lg font-bold text-green-700">{agentCounts.available}</div><div className="text-[10px] uppercase text-green-600">{t('supervisor.available')}</div></div>
        <div className="rounded-lg bg-red-50 p-2 text-center"><div className="text-lg font-bold text-red-700">{agentCounts.busy}</div><div className="text-[10px] uppercase text-red-600">{t('supervisor.busy')}</div></div>
        <div className="rounded-lg bg-gray-50 p-2 text-center"><div className="text-lg font-bold text-gray-700">{agentCounts.offline}</div><div className="text-[10px] uppercase text-gray-500">{t('supervisor.offline')}</div></div>
      </div>

      {error && <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700" role="alert">{error}</div>}
      {message && <div className="mb-3 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-700" role="status">{message}</div>}

      {loading ? (
        <div className="py-8 text-center text-sm text-gray-400">{t('supervisor.loading')}</div>
      ) : live.calls.length === 0 ? (
        <div className="py-8 text-center text-sm text-gray-400">{t('supervisor.noCalls')}</div>
      ) : (
        <div className="space-y-3">
          {live.calls.map((call) => {
            const busy = actionUUID === call.uuid;
            const transferTarget = transferTargets[call.uuid] || '';
            return (
              <section key={call.uuid} className="rounded-xl border border-gray-200 bg-gray-50 p-3" aria-label={`${t('supervisor.call')} ${call.extension || call.destination}`}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold text-gray-800">{call.caller_name || call.caller_id || t('call.unknown')}</div>
                    <div className="text-xs text-gray-500">{call.caller_id || '—'} → {call.extension || call.destination || '—'}</div>
                  </div>
                  <span className={`rounded-full px-2 py-1 text-[10px] font-bold ${call.held ? 'bg-indigo-100 text-indigo-700' : 'bg-green-100 text-green-700'}`}>
                    {call.held ? t('supervisor.held') : call.state || t('supervisor.active')}
                  </span>
                </div>

                <div className="mt-3 flex flex-wrap gap-2">
                  {capabilities.can_spy && <button disabled={busy} onClick={() => void act(call.uuid, 'spy')} className="rounded-lg bg-sky-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">{t('supervisor.monitor')}</button>}
                  {capabilities.can_whisper && <button disabled={busy} onClick={() => void act(call.uuid, 'whisper')} className="rounded-lg bg-blue-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">{t('supervisor.whisper')}</button>}
                  {capabilities.can_barge && <button disabled={busy} onClick={() => void act(call.uuid, 'barge')} className="rounded-lg bg-violet-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">{t('supervisor.barge')}</button>}
                  {capabilities.full_control && (
                    <>
                      <button disabled={busy} onClick={() => void act(call.uuid, call.held ? 'unhold' : 'hold')} className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-xs font-semibold text-gray-700 disabled:opacity-50">{call.held ? t('supervisor.resume') : t('supervisor.hold')}</button>
                      <button disabled={busy} onClick={() => void act(call.uuid, call.recording ? 'record_stop' : 'record_start')} className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700 disabled:opacity-50">{call.recording ? t('supervisor.stopRecording') : t('supervisor.record')}</button>
                      <button disabled={busy} onClick={() => void act(call.uuid, 'hangup')} className="rounded-lg border border-red-300 bg-white px-3 py-2 text-xs font-semibold text-red-700 disabled:opacity-50">{t('supervisor.endCall')}</button>
                    </>
                  )}
                </div>

                {capabilities.full_control && (
                  <div className="mt-3 flex gap-2">
                    <input
                      value={transferTarget}
                      onChange={(event) => setTransferTargets((current) => ({ ...current, [call.uuid]: event.target.value }))}
                      placeholder={t('supervisor.transferPlaceholder')}
                      inputMode="tel"
                      className="min-w-0 flex-1 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:border-sky-400"
                    />
                    <button disabled={busy || !transferTarget.trim()} onClick={() => void act(call.uuid, 'transfer', transferTarget.trim())} className="rounded-lg bg-gray-800 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">{t('supervisor.transfer')}</button>
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}

      <div className="mt-4 border-t border-gray-100 pt-3">
        <h3 className="mb-2 text-xs font-semibold uppercase text-gray-500">{t('supervisor.agents')}</h3>
        <div className="grid grid-cols-2 gap-1">
          {live.agents.map((agent) => (
            <div key={agent.extension} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-gray-600">
              <span className={`h-2 w-2 rounded-full ${statusColor(agent.status)}`} aria-hidden="true" />
              <span className="font-semibold">{agent.extension}</span>
              <span className="truncate text-gray-400">{agent.display_name}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
