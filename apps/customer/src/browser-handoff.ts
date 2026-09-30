import { Linking } from 'react-native';
import Constants from 'expo-constants';
import { privateBrowserUrl } from '../../../packages/mobile-client/src/browser-handoff';
import { origin } from './runtime';
export async function openPrivateBrowser(path: string) {
  const url = privateBrowserUrl(origin, path, Constants.expoConfig?.extra?.localAcceptance === true);
  await Linking.openURL(url);
  // Returning/opening says nothing about payment, authentication or download.
}
