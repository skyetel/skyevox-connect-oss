import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.skyetel.skyevoxconnect',
  appName: 'SkyeVox Connect',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
    allowNavigation: ['connect.skyetel.money'],
  },
  android: {
    allowMixedContent: false,
  },
  ios: {
    scheme: 'SkyeVox Connect',
  },
  plugins: {
    App: {
      launchUrl: 'skyevox://provision',
    },
  },
};

export default config;
