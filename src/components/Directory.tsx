import { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/useStore';
import { isNative } from '../platform';
import { directoryExtensions, fetchDirectory } from '../api/directory';
import { fetchCallParkSlots as fetchAuthenticatedParkSlots, pickupParkedCall } from '../callPark';

interface Props {
  onCall: (number: string) => void;
}

// Slower polling on mobile to save battery
const POLL_INTERVAL = isNative() ? 15000 : 5000;

export function Directory({ onCall }: Props) {
  const { t } = useTranslation();
  const { extensions, setExtensions, directoryLoaded, setDirectoryLoaded, setPresenceData, parkSlots, setParkSlots, sipConfig } = useStore();
  const [search, setSearch] = useState('');
  const [hoveredExt, setHoveredExt] = useState<string | null>(null);
  const [parkError, setParkError] = useState<string | null>(null);
  const [directoryError, setDirectoryError] = useState<string | null>(null);
  const [pickupError, setPickupError] = useState<string | null>(null);
  const [pickingUp, setPickingUp] = useState<string | null>(null);
  const [pickupNotice, setPickupNotice] = useState<string | null>(null);
  const pickupBusy = useStore((state) => state.call.status !== 'idle' || state.secondCall !== null);
  const presenceIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const parkIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Directory and presence share the authenticated, tenant-scoped snapshot.
  const fetchPresence = useCallback(() => {
    if (!sipConfig) return;
    void fetchDirectory(sipConfig)
      .then((entries) => {
        if (useStore.getState().sipConfig !== sipConfig) return;
        const next = directoryExtensions(entries);
        setExtensions(next);
        setPresenceData(next.map((entry) => ({ ...entry, status: entry.status || 'offline' })));
        setDirectoryLoaded(true);
        setDirectoryError(null);
      })
      .catch((error: unknown) => {
        if (useStore.getState().sipConfig !== sipConfig) return;
        setDirectoryError(error instanceof Error ? error.message : 'Directory unavailable.');
      });
  }, [setExtensions, setDirectoryLoaded, setPresenceData, sipConfig]);

  // Poll park slots
  const fetchParkSlots = useCallback(() => {
    if (!sipConfig) {
      setParkSlots([]);
      return;
    }
    void fetchAuthenticatedParkSlots(sipConfig)
      .then((slots) => {
        if (useStore.getState().sipConfig !== sipConfig) return;
        setParkSlots(slots);
        setParkError(null);
      })
      .catch((error: unknown) => {
        if (useStore.getState().sipConfig !== sipConfig) return;
        setParkSlots([]);
        setParkError(error instanceof Error ? error.message : 'Parked calls unavailable.');
      });
  }, [setParkSlots, sipConfig]);

  useEffect(() => {
    setParkSlots([]);
    setParkError(null);
    setDirectoryError(null);
    setPickupError(null);
    setPickingUp(null);
    setPickupNotice(null);
    if (!sipConfig) return;
    fetchPresence();
    fetchParkSlots();
    presenceIntervalRef.current = setInterval(fetchPresence, POLL_INTERVAL);
    parkIntervalRef.current = setInterval(fetchParkSlots, POLL_INTERVAL);
    return () => {
      if (presenceIntervalRef.current) clearInterval(presenceIntervalRef.current);
      if (parkIntervalRef.current) clearInterval(parkIntervalRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sipConfig]);

  const handlePickup = async (uuid: string) => {
    if (!sipConfig || pickingUp || pickupBusy) return;
    setPickingUp(uuid);
    setPickupError(null);
    setPickupNotice('Retrieve to this extension — answer the incoming call.');
    try {
      await pickupParkedCall(sipConfig, uuid);
      if (useStore.getState().sipConfig !== sipConfig) return;
      setPickupNotice('Parked call retrieved.');
      fetchParkSlots();
    } catch (error) {
      if (useStore.getState().sipConfig !== sipConfig) return;
      setPickupNotice(null);
      setPickupError(error instanceof Error ? error.message : 'Call pickup failed.');
    } finally {
      if (useStore.getState().sipConfig === sipConfig) setPickingUp(null);
    }
  };

  const filtered = extensions.filter(
    (ext) =>
      ext.name?.toLowerCase().includes(search.toLowerCase()) ||
      ext.extension.includes(search)
  );

  const statusColor = (status?: string) => {
    switch (status) {
      case 'available':
        return 'bg-green-400';
      case 'busy':
        return 'bg-red-400';
      case 'ringing':
        return 'bg-amber-400 animate-pulse-ring';
      default:
        return 'bg-gray-300';
    }
  };

  const statusText = (status?: string) => {
    switch (status) {
      case 'available':
        return t('directory.available');
      case 'busy':
        return t('directory.onACall');
      case 'ringing':
        return t('directory.ringing');
      default:
        return t('directory.offline');
    }
  };

  return (
    <div className="flex flex-col gap-2 p-2">
      <input
        type="text"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder={t('directory.searchPlaceholder')}
        aria-label={t('directory.searchPlaceholder')}
        className="w-full px-3 py-2 bg-gray-50 rounded-lg text-sm outline-none focus:ring-2 focus:ring-sky-300"
      />

      {directoryError && <div role="alert" className="text-sm text-red-600">{directoryError}</div>}
      {parkError && <div role="alert" className="text-sm text-red-600">{parkError}</div>}
      {pickupError && <div role="alert" className="text-sm text-red-600">{pickupError}</div>}
      {pickupNotice && <div role="status" className="text-sm text-sky-700">{pickupNotice}</div>}
      {/* Parked Calls Section */}
      {parkSlots.length > 0 && (
        <div className="mb-1">
          <div className="text-xs font-semibold text-gray-500 uppercase px-1 mb-1">{t('directory.parkedCalls')}</div>
          <div role="list">
            {parkSlots.map((slot) => (
              <div
                key={`${slot.node}:${slot.uuid}`}
                role="listitem"
                className="flex items-center gap-3 px-3 py-2 bg-amber-50 rounded-lg mb-1 border border-amber-200"
              >
                <span className="w-6 h-6 rounded-full bg-amber-400 text-white text-xs flex items-center justify-center font-bold" aria-hidden="true">
                  {slot.slot}
                </span>
                <div className="flex-1 text-left">
                  <div className="text-sm font-medium text-gray-800">
                    {slot.caller_name || slot.caller_id}
                  </div>
                  <div className="text-xs text-gray-400">
                    {t('directory.slot', { slot: slot.slot })} - {slot.caller_id}
                  </div>
                </div>
                <button
                  onClick={() => void handlePickup(slot.uuid)}
                  disabled={pickingUp !== null || pickupBusy}
                  title="Retrieve to this extension — answer the incoming call"
                  aria-label={`${t('directory.pickup')} ${t('directory.slot', { slot: slot.slot })}`}
                  className="px-2.5 py-1 bg-green-500 hover:bg-green-600 text-white text-xs rounded-lg font-medium transition-colors touch-target"
                >
                  {t('directory.pickup')}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Extension Directory */}
      <div className="overflow-y-auto max-h-[300px]" role="list" aria-label={t('tab.directory')}>
        {filtered.length === 0 ? (
          <div className="text-center py-8 text-gray-400 text-sm">
            {!directoryLoaded ? t('directory.loading') : t('directory.noMatches')}
          </div>
        ) : (
          filtered.map((ext) => (
            <button
              key={ext.id}
              role="listitem"
              onClick={() => onCall(ext.extension)}
              onMouseEnter={() => setHoveredExt(ext.extension)}
              onMouseLeave={() => setHoveredExt(null)}
              aria-label={`${ext.name || t('directory.ext', { ext: ext.extension })} - ${statusText(ext.status)}`}
              className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-gray-50 transition-colors border-b border-gray-100 relative touch-target"
            >
              <span className={`w-2.5 h-2.5 rounded-full ${statusColor(ext.status)}`} aria-hidden="true" />
              <div className="flex-1 text-left">
                <div className="text-sm font-medium text-gray-800">
                  {ext.name || t('directory.ext', { ext: ext.extension })}
                </div>
                <div className="text-xs text-gray-400">{ext.extension}</div>
              </div>
              {/* Status tooltip on hover */}
              {hoveredExt === ext.extension && (
                <span className="text-xs text-gray-500 bg-gray-100 px-2 py-0.5 rounded" role="tooltip">
                  {statusText(ext.status)}
                </span>
              )}
              <svg className="w-5 h-5 text-gray-300" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M20.01 15.38c-1.23 0-2.42-.2-3.53-.56a.977.977 0 00-1.01.24l-1.57 1.97c-2.83-1.35-5.48-3.9-6.89-6.83l1.95-1.66c.27-.28.35-.67.24-1.02-.37-1.11-.56-2.3-.56-3.53 0-.54-.45-.99-.99-.99H4.19C3.65 3 3 3.24 3 3.99 3 13.28 10.73 21 20.01 21c.71 0 .99-.63.99-1.18v-3.45c0-.54-.45-.99-.99-.99z" />
              </svg>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
