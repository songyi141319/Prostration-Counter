import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.songyi.kowtowcounter',
  appName: '大拜计数器',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
  },
};

export default config;
