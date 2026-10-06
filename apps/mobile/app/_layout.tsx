import { VoiceRingHost } from '../ui/voice.tsx';
import { setAudioModeAsync } from 'expo-audio';
import { ShareIntentProvider, useShareIntentContext } from 'expo-share-intent';
import { router, Stack, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef } from 'react';
import { StyleSheet } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { setProfileNavigator } from '../lib/profilePreload.ts';
import { IdentityTracker } from '../ui/identities.tsx';
import { ToastHost } from '../ui/toast.tsx';
import { ProfileOpeningIndicator } from '../ui/openingIndicator.tsx';
import { NotificationHandler } from '../ui/notifications.tsx';
import { SessionProvider } from '../ui/session.tsx';
import { SyncProvider } from '../ui/sync.tsx';
import { darkColors, FONTS } from '../ui/theme.ts';
import { ImageViewerProvider } from '../ui/imageViewer.tsx';

/**
 * Navigation root. expo-router's `Stack` sits on react-native-screens' native
 * stack: transitions and the back gesture are the system's, not a JS
 * reimplementation.
 *
 * No migration here: each database is migrated by whoever opens it,
 * `SyncProvider` for the session's database. Blocking the whole app on the
 * migration of a database the session may not even use would delay startup
 * for nothing, and an unrelated corrupt file would brick all of it.
 */
export default function RootLayout() {
  // Profile preloading (`lib/profilePreload.ts`, pure lib/, loadable under
  // Node) does not know expo-router: we lend it navigation from here, on the
  // model of `setProfileClient` set by `SessionProvider`.
  useEffect(() => {
    setProfileNavigator((p) => router.push({ pathname: '/profile', params: p }));
    return () => setProfileNavigator(null);
  }, []);

  // iOS mutes an app on the silent switch by default: a voice message would
  // stay silent. No effect on Android.
  useEffect(() => {
    setAudioModeAsync({ playsInSilentMode: true }).catch(() => {});
  }, []);

  return (
    // Gesture root (pinch/pan in the viewer). The Modal, a separate native
    // window, has its own; this one covers the stack.
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaProvider>
        {/* Android share target (ACTION_SEND). Must wrap the other
            providers: its native module reads the intent on the very first render.
            `resetOnBackground: false`: switching to another app to check a detail
            must not drop the file about to be shared. */}
        <ShareIntentProvider options={{ resetOnBackground: false }}>
          {/* Feeds the keyboard SharedValue of `ui/keyboard.tsx` (frame-by-frame
              tracking via WindowInsetsAnimation, native edge-to-edge). */}
          <KeyboardProvider>
            <SessionProvider>
              <SyncProvider>
                {/* The image viewer mounts ONE shared Modal above the
                    whole stack: an attachment opens full screen from
                    any screen (room, thread). */}
                <ImageViewerProvider>
                  {/* Default title: without it, the gatekeeper's early renders
                      (startup, redirect) show the raw route name. */}
                  <Stack
                    screenOptions={{
                      title: 'rocket-vibe',
                      headerStyle: { backgroundColor: darkColors.background },
                      headerTintColor: darkColors.text,
                      headerTitleStyle: { fontFamily: FONTS.title },
                      // Dark background DURING native transitions: without it, a
                      // screen not yet re-skinned flashes white on push/pop.
                      contentStyle: { backgroundColor: darkColors.background },
                    }}
                  >
                    {/* `presentation` must be known when the native screen is
                        CREATED: set by `<Stack.Screen>` from the screen itself,
                        it arrives late (setOptions) and may be ignored.
                        `fitToContents`: the sheet fits its content's height
                        instead of filling the screen (default `[1.0]`). Native grabber
                        and rounded corners, no header: it is a menu, not a page. */}
                    <Stack.Screen
                      name="message-actions"
                      options={{
                        presentation: 'formSheet',
                        headerShown: false,
                        sheetAllowedDetents: 'fitToContents',
                        sheetGrabberVisible: true,
                        sheetCornerRadius: 24,
                        sheetElevation: 24,
                        contentStyle: { backgroundColor: darkColors.deepCard },
                      }}
                    />
                    {/* "Attach" sheet: the source menu for an attachment
                        (photo, video, library, file). Same native sheet as
                        the message actions. */}
                    <Stack.Screen
                      name="attach"
                      options={{
                        presentation: 'formSheet',
                        headerShown: false,
                        sheetAllowedDetents: 'fitToContents',
                        sheetGrabberVisible: true,
                        sheetCornerRadius: 24,
                        sheetElevation: 24,
                        contentStyle: { backgroundColor: darkColors.deepCard },
                      }}
                    />
                    {/* E2EE unlock: encryption password. */}
                    <Stack.Screen
                      name="unlock-e2e"
                      options={{
                        presentation: 'formSheet',
                        headerShown: false,
                        sheetAllowedDetents: 'fitToContents',
                        sheetGrabberVisible: true,
                        sheetCornerRadius: 24,
                        sheetElevation: 24,
                        contentStyle: { backgroundColor: darkColors.deepCard },
                      }}
                    />
                    {/* New room, voice channels included (RocketVibe server). */}
                    <Stack.Screen
                      name="new-room"
                      options={{
                        presentation: 'formSheet',
                        headerShown: false,
                        sheetAllowedDetents: 'fitToContents',
                        sheetGrabberVisible: true,
                        sheetCornerRadius: 24,
                        sheetElevation: 24,
                        contentStyle: { backgroundColor: darkColors.deepCard },
                      }}
                    />
                    {/* Room info (tap on the name in the header). */}
                    <Stack.Screen
                      name="room-info"
                      options={{
                        presentation: 'formSheet',
                        headerShown: false,
                        sheetAllowedDetents: 'fitToContents',
                        sheetGrabberVisible: true,
                        sheetCornerRadius: 24,
                        sheetElevation: 24,
                        contentStyle: { backgroundColor: darkColors.deepCard },
                      }}
                    />
                    {/* User profile (author avatar/name, mention).
                        Same native sheet as the message actions. */}
                    <Stack.Screen
                      name="profile"
                      options={{
                        presentation: 'formSheet',
                        headerShown: false,
                        sheetAllowedDetents: 'fitToContents',
                        sheetGrabberVisible: true,
                        sheetCornerRadius: 24,
                        sheetElevation: 24,
                        contentStyle: { backgroundColor: darkColors.deepCard },
                      }}
                    />
                    {/* Share screen: opened by Android's system share sheet
                        (ACTION_SEND) via `ShareGuard`. Modal sliding from the bottom:
                        a one-off action on top of the app, not a page. */}
                    <Stack.Screen name="share" options={{ presentation: 'modal' }} />
                  </Stack>
                  <NotificationHandler />
                  {/* Keeps the `uid -> current username` resolution of message
                      authors up to date (renames). Sibling of the stack: renders
                      nothing, feeds a subscribable store. */}
                  <IdentityTracker />
                  {/* Visual feedback for profile preloading: above the
                      stack, only shows if opening drags on (>threshold). */}
                  <ProfileOpeningIndicator />
                  <ToastHost />
                  {/* Rings of direct calls and the end of a voice session (RocketVibe). */}
                  <VoiceRingHost />
                  {/* Redirects to the share screen as soon as an intent arrives. */}
                  <ShareGuard />
                </ImageViewerProvider>
              </SyncProvider>
            </SessionProvider>
          </KeyboardProvider>
        </ShareIntentProvider>
        {/* Forced dark theme: light icons on the indigo background. */}
        <StatusBar style="light" />
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

/**
 * Router for incoming shares. `expo-share-intent`'s native module publishes
 * the `ACTION_SEND` intent in the context; we then open the `/share` screen.
 *
 * `handled` keeps the rising edge: we push ONCE per intent, even if the
 * context re-renders. When the share screen resets the intent
 * (`resetShareIntent`), `hasShareIntent` drops back to false and the guard
 * re-arms for the next share, without depending on the pathname, so without
 * pushing `/share` again over the room we just sent to.
 */
function ShareGuard() {
  const { hasShareIntent } = useShareIntentContext();
  const appRouter = useRouter();
  const handled = useRef(false);

  useEffect(() => {
    if (hasShareIntent && !handled.current) {
      handled.current = true;
      appRouter.push('/share');
    } else if (!hasShareIntent) {
      handled.current = false;
    }
  }, [hasShareIntent, appRouter]);

  return null;
}

const styles = StyleSheet.create({
  root: { flex: 1 },
});
