import { useTranslation } from 'react-i18next';
import { isElectron, isNative } from '../platform';
import type { VersionInfo } from '../types';

interface Props {
  versionInfo: VersionInfo;
  mandatory: boolean;
  onDismiss: () => void;
}

export function UpdateBanner({ versionInfo, mandatory, onDismiss }: Props) {
  const { t } = useTranslation();
  const installerUpdate = (isNative() || isElectron()) && !!versionInfo.download_url;

  const handleUpdate = () => {
    if (installerUpdate && versionInfo.download_url) {
      window.open(versionInfo.download_url, '_system');
    } else if (versionInfo.web_url) {
      window.location.reload();
    }
  };

  return (
    <div
      className="update-banner text-white px-3 py-2 flex items-center justify-between text-xs"
      role="alert"
    >
      <span className="font-medium">
        {t('update.available', { version: versionInfo.version })}
      </span>
      <div className="flex items-center gap-2">
        <button
          onClick={handleUpdate}
          className="bg-white/20 hover:bg-white/30 px-2.5 py-1 rounded-md font-medium transition-colors"
        >
          {installerUpdate ? t('update.updateNow') : t('update.refreshBrowser')}
        </button>
        {!mandatory && (
          <button
            onClick={onDismiss}
            className="opacity-70 hover:opacity-100 transition-opacity px-1"
            aria-label={t('update.dismiss')}
          >
            &times;
          </button>
        )}
      </div>
    </div>
  );
}
