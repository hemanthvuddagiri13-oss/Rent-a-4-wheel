import Constants from 'expo-constants';
import { createAcceptanceTrace } from '../../../packages/mobile-client/src/acceptance-trace';
export const { trace, traceOperation } = createAcceptanceTrace(Constants.expoConfig?.extra?.localAcceptance === true && Constants.expoConfig?.extra?.apiOrigin === 'http://localhost:3000', (...args) => fetch(...args));
