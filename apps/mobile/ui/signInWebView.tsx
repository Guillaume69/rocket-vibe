/**
 * A provider's sign-in page in a full-screen web view of the app, the
 * desktops' sign-in window: it shows only the pages `isPage` accepts (other
 * links open in the browser), and hands `onDone` the first address `isDone`
 * recognises, which never loads. Back or Close cancels. No camera, no
 * microphone, no new windows. The bounded exception of ROADMAP §4.2.
 */

import { useRef, useState } from 'react';
import { ActivityIndicator, Linking, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import type { WebViewMessageEvent } from 'react-native-webview';

import { useT } from './i18n.ts';
import { FONTS, useColors } from './theme.ts';

export type SignInWebViewProps = {
  title: string;
  start: string;
  /** Sent instead of the phone's, for a provider that answers a phone with its app's store page. */
  userAgent?: string;
  isPage: (url: string) => boolean;
  isDone: (url: string) => boolean;
  /** Run in the page once done is reached, when it must say something; its `postMessage` answer comes back in `onDone`. */
  doneScript?: (url: string) => string | null;
  onDone: (url: string, message: string | null) => void;
  onCancel: () => void;
};

export function SignInWebView({ title, start, userAgent, isPage, isDone, doneScript, onDone, onCancel }: SignInWebViewProps) {
  const c = useColors();
  const t = useT();
  const insets = useSafeAreaInsets();
  const web = useRef<WebView>(null);
  const reached = useRef<string | null>(null);
  const [loading, setLoading] = useState(true);

  const finish = (url: string, message: string | null) => {
    if (reached.current === null) return;
    reached.current = null;
    onDone(url, message);
  };

  const onMessage = (event: WebViewMessageEvent) => {
    if (reached.current !== null) finish(reached.current, event.nativeEvent.data);
  };

  return (
    <Modal visible animationType="slide" onRequestClose={onCancel} statusBarTranslucent>
      <View style={[styles.screen, { backgroundColor: c.background, paddingTop: insets.top, paddingBottom: insets.bottom }]}>
        <View style={[styles.bar, { borderColor: c.border }]}>
          <Text style={[styles.title, { color: c.text }]} numberOfLines={1}>{title}</Text>
          <Pressable onPress={onCancel} accessibilityRole="button" accessibilityLabel={t('common.cancel')} hitSlop={12}>
            <Text style={[styles.close, { color: c.accent }]}>{t('common.cancel')}</Text>
          </Pressable>
        </View>
        <WebView
          ref={web}
          source={{ uri: start }}
          style={styles.web}
          userAgent={userAgent}
          originWhitelist={EVERY_ADDRESS}
          domStorageEnabled
          setSupportMultipleWindows={false}
          mediaPlaybackRequiresUserAction
          onLoadEnd={() => setLoading(false)}
          onMessage={onMessage}
          onShouldStartLoadWithRequest={(request) => {
            if (isDone(request.url)) {
              if (reached.current === null) {
                reached.current = request.url;
                const script = doneScript?.(request.url) ?? null;
                if (script === null) finish(request.url, null);
                else web.current?.injectJavaScript(script);
              }
              return false;
            }
            if (request.isTopFrame === false || request.url === 'about:blank' || isPage(request.url)) return true;
            if (request.url.startsWith('https://') || request.url.startsWith('http://')) void Linking.openURL(request.url);
            return false;
          }}
        />
        {loading && (
          <View style={styles.veil} pointerEvents="none">
            <ActivityIndicator color={c.accent} size="large" />
          </View>
        )}
      </View>
    </Modal>
  );
}

/** Every address reaches `onShouldStartLoadWithRequest`: the default list hands any other scheme, the provider's redirect to the app included, to the system first. */
const EVERY_ADDRESS = ['*'];

const styles = StyleSheet.create({
  screen: { flex: 1 },
  bar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  title: { flex: 1, fontFamily: FONTS.title, fontSize: 18, marginRight: 12 },
  close: { fontFamily: FONTS.bodySemi, fontSize: 15 },
  web: { flex: 1 },
  veil: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, alignItems: 'center', justifyContent: 'center' },
});
