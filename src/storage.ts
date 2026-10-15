import { Preferences } from '@capacitor/preferences';
import { isNative } from './platform';

/**
 * Async storage abstraction.
 * Uses Capacitor Preferences on native, localStorage on web.
 */
export const Storage = {
  async get(key: string): Promise<string | null> {
    const electronStorage = window.electronAPI?.storageGet;
    if (electronStorage) {
      return electronStorage(key);
    }

    if (isNative()) {
      const { value } = await Preferences.get({ key });
      return value;
    }
    return localStorage.getItem(key);
  },

  async set(key: string, value: string): Promise<void> {
    const electronStorage = window.electronAPI?.storageSet;
    if (electronStorage) {
      await electronStorage(key, value);
      return;
    }

    if (isNative()) {
      await Preferences.set({ key, value });
    } else {
      localStorage.setItem(key, value);
    }
  },

  async remove(key: string): Promise<void> {
    const electronStorage = window.electronAPI?.storageRemove;
    if (electronStorage) {
      await electronStorage(key);
      return;
    }

    if (isNative()) {
      await Preferences.remove({ key });
    } else {
      localStorage.removeItem(key);
    }
  },
};
