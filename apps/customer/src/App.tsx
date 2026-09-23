import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { AppState, View, Text } from 'react-native';
import { NavigationContainer, DarkTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query';
import { session, friendly } from './runtime';
import { colors, Page, Hint, Busy, ErrorText } from './ui';
import type { Routes } from './navigation';
import { Home, Vehicle } from './screens/discovery';
import { SignIn, EmailSignIn, Account } from './screens/account';
import { LoginMethods } from './screens/login-methods';
import { Reservation, Reservations } from './screens/reservations';
import { Checkout } from './screens/checkout';
import { Inspection } from './screens/inspection';
import { Inbox, Messages, Notices, Cases, Case, Review } from './screens/community';
const Stack = createNativeStackNavigator<Routes>();
const queries = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: 0, refetchOnWindowFocus: true }, mutations: { retry: false } } });
const subscribeAppState = (changed: () => void) => { const subscription = AppState.addEventListener('change', changed); return () => subscription.remove(); };
export default function App() {
  const [signedIn, setSignedIn] = useState(false), [ready, setReady] = useState(false);
  const [authRevision, setAuthRevision] = useState(0), [startupError, setStartupError] = useState('');
  const appState = useSyncExternalStore(subscribeAppState, () => AppState.currentState);
  const privateScreen = appState !== 'active';
  useEffect(() => {
    session.onChange = value => { void queries.cancelQueries(); queries.clear(); setSignedIn(value); setAuthRevision(revision => revision + 1); };
    void session.restore().catch(error => setStartupError(friendly(error))).finally(() => setReady(true));
    const listener = AppState.addEventListener('change', state => { focusManager.setFocused(state === 'active'); });
    return () => { listener.remove(); session.onChange = () => {}; };
  }, []);
  return <SafeAreaProvider><QueryClientProvider client={queries}>{startupError ? <Page title="Secure storage needs attention"><ErrorText message={startupError} /><Hint>Unlock your device and reopen the app. Credentials will not be stored outside secure device storage.</Hint></Page> : !ready ? <Page title="Opening securely"><Busy /><Hint>Checking this device’s secure session.</Hint></Page> : <NavigationContainer key={`${signedIn}:${authRevision}`} theme={{ ...DarkTheme, colors: { ...DarkTheme.colors, primary: colors.gold, background: colors.bg, card: colors.card, text: colors.text, border: colors.border } }}><Stack.Navigator screenOptions={{ headerBackTitle: 'Back', headerTintColor: colors.gold, contentStyle: { backgroundColor: colors.bg } }}>
    <Stack.Screen name="Home" component={Home} options={{ title: 'Rent A 4Wheel' }} /><Stack.Screen name="Vehicle" component={Vehicle} options={{ title: 'Explore a vehicle' }} /><Stack.Screen name="SignIn" component={SignIn} options={{ title: 'Sign in' }} />
    <Stack.Screen name="EmailSignIn" component={EmailSignIn} options={{ title: 'Email fallback' }} /><Stack.Screen name="LoginMethods" component={signedIn ? LoginMethods : SignIn} options={{ title: 'Login & recovery' }} />
    <Stack.Screen name="Reservations" component={signedIn ? Reservations : SignIn} options={{ title: 'Your trips' }} />
    <Stack.Screen name="Reservation" component={signedIn ? Reservation : SignIn} options={{ title: 'Trip details' }} />
    <Stack.Screen name="Checkout" component={signedIn ? Checkout : SignIn} options={{ title: 'Checkout preparation' }} />
    <Stack.Screen name="Inspection" component={signedIn ? Inspection : SignIn} options={{ title: 'Condition report' }} />
    <Stack.Screen name="Inbox" component={signedIn ? Inbox : SignIn} options={{ title: 'Messages' }} /><Stack.Screen name="Messages" component={signedIn ? Messages : SignIn} options={{ title: 'Conversation' }} />
    <Stack.Screen name="Notices" component={signedIn ? Notices : SignIn} options={{ title: 'Notices' }} /><Stack.Screen name="Cases" component={signedIn ? Cases : SignIn} options={{ title: 'Support' }} /><Stack.Screen name="Case" component={signedIn ? Case : SignIn} options={{ title: 'Case' }} /><Stack.Screen name="Review" component={signedIn ? Review : SignIn} options={{ title: 'Review' }} /><Stack.Screen name="Account" component={signedIn ? Account : SignIn} options={{ title: 'Account' }} />
  </Stack.Navigator></NavigationContainer>}{privateScreen && <View accessibilityViewIsModal style={{ position: 'absolute', inset: 0, backgroundColor: colors.bg, justifyContent: 'center', alignItems: 'center' }}><Text style={{ color: colors.gold, fontSize: 24 }}>Rent A 4Wheel</Text></View>}</QueryClientProvider></SafeAreaProvider>;
}
