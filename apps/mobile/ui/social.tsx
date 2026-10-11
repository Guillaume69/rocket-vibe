import { useEffect, useRef, useState } from 'react';
import { Animated, Image, Pressable, Text, View, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import * as Crypto from 'expo-crypto';
import { File, Directory, Paths } from 'expo-file-system';
import type { SocialCard, Sticker } from '../providers/rocketvibe/protocol.generated.ts';
import { decodeNative } from '../providers/rocketvibe/validation.ts';
import { imageLink } from '../lib/giphy.ts';
import { useLanguage } from './i18n.ts';
import {translate} from './messages.ts';
import { useSession } from './session.tsx';
import { useSync } from './sync.tsx';
import { useVoice } from './voice.tsx';
import { useColors, FONTS, type Colors } from './theme.ts';
import { notify } from './toast.tsx';
import { currentReminderAccount, setReminder } from './reminders.ts';
import { Icon } from './icon.tsx';
export function socialValue(value: unknown): SocialCard | null {
  try {
    if (!value || typeof value !== 'object' || !('native_social' in value)) return null;
    return decodeNative('SocialCard', (value as Record<string, unknown>).native_social);
  } catch {
    return null;
  }
}
export function SocialButton({ room, thread }: { room: string; thread?: string | null }) {
  const router = useRouter(),
    c = useColors(),
    language = useLanguage();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={
        language === 'fr' ? 'Sondage, soirée, stickers et GIF' : 'Polls, game nights, stickers and GIFs'
      }
      onPress={() => router.push({ pathname: '/social', params: { rid: room, ...(thread ? { root: thread } : {}) } })}
      style={{ padding: 8 }}
    >
      <Icon name="face-smile" color={c.dimmed} />
    </Pressable>
  );
}
export async function readLocalStickers(account: string): Promise<Sticker[]> {
  const digest = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, account),
    file = new File(Paths.document, 'sticker-shelf', digest + '.json');
  if (!file.exists) return [];
  const raw: unknown = JSON.parse(await file.text());
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 200).flatMap((v: unknown) => {
    if (!v || typeof v !== 'object') return [];
    const s = v as Record<string, unknown>;
    return typeof s.id === 'string' && typeof s.name === 'string' && typeof s.url === 'string' && imageLink(s.url)
      ? [{ id: s.id, name: s.name, url: s.url }]
      : [];
  });
}
export async function writeLocalStickers(account: string, items: Sticker[]): Promise<void> {
  const digest = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, account),
    dir = new Directory(Paths.document, 'sticker-shelf');
  if (!dir.exists) dir.create({ intermediates: true });
  new File(dir, digest + '.json').write(JSON.stringify(items.slice(0, 200)));
}
export function SocialMessage({
  value,
  id,
  room,
  author,
  c,
}: {
  value: SocialCard;
  id: string;
  room: string;
  author: string;
  c: Colors;
}) {
  const sync = useSync(),
    { state } = useSession(),
    language = useLanguage(),
    chat = sync.phase === 'ready' ? sync.provider.native?.chat : null,
    me = state.phase === 'connected' ? state.session.userId : '';
  const incoming =
    value.kind === 'poll'
      ? value.options.flatMap((o, i) => (o.voters.includes(me) ? [i] : []))
      : value.kind === 'game_night'
        ? [value.going.includes(me) ? 0 : value.maybe.includes(me) ? 1 : value.declined.includes(me) ? 2 : -1].filter(
            (n) => n >= 0,
          )
        : [];
  const [choices, setChoices] = useState(incoming),
    [busy, setBusy] = useState(false),
    [clock, setClock] = useState(Date.now());
  const signature = incoming.join(',');
  useEffect(() => setChoices(incoming), [signature, id]);
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const attempts = useRef(new Map<string, string>());
  const send = async (picked: number[]) => {
    if (!chat || busy) return;
    setBusy(true);
    const key = JSON.stringify(picked),
      operation = attempts.current.get(key) ?? Crypto.randomUUID();
    attempts.current.set(key, operation);
    try {
      await chat.transport.answerSocial(id, { operation_id: operation, choices: picked });
      attempts.current.delete(key);
    } catch {
      notify(translate(language,"social.your_answer_was_not_saved_try_again"));
    } finally {
      setBusy(false);
    }
  };
  const action = (label: string, fn: () => void, selected = false, disabled = false) => (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected, disabled: disabled || busy }}
      disabled={disabled || busy}
      onPress={fn}
      style={[
        styles.action,
        { borderColor: selected ? c.accent : c.border, backgroundColor: selected ? c.accent : 'transparent' },
      ]}
    >
      <Text style={{ color: selected ? c.onAccent : c.text }}>{label}</Text>
    </Pressable>
  );
  if (value.kind === 'image')
    return imageLink(value.url) ? (
      <View style={[styles.card, { borderColor: c.border }]}>
        <Image
          source={{ uri: value.url }}
          resizeMode="contain"
          style={{ width: 260, height: 220, maxWidth: '100%', borderRadius: 12 }}
          accessibilityLabel={value.title}
        />
        {value.powered_by && <Text style={{ color: c.dimmed }}>Powered By {value.powered_by}</Text>}
        {action(translate(language,"social.save_to_sticker_shelf"), () => {
          if (chat)
            void chat.transport
              .saveSticker({
                operation_id: Crypto.randomUUID(),
                name: value.title.slice(0, 100) || 'Sticker',
                url: value.url,
              })
              .then(() => notify(translate(language,"social.saved")))
              .catch(() => notify(translate(language,"social.could_not_save")));
        })}
      </View>
    ) : null;
  if (value.kind === 'poll') {
    const ended = value.closed || (value.closes_at != null && Date.parse(value.closes_at) <= clock);
    return (
      <View style={[styles.card, { borderColor: c.border }]}>
        <Text style={[styles.title, { color: c.text }]}>{value.question}</Text>
        <Text style={{ color: c.dimmed }}>
          {value.multiple ? translate(language,"social.multiple_choices") : translate(language,"social.one_choice")}
        </Text>
        {value.options.map((o, i) => (
          <View key={i}>
            {action(
              o.label + ' · ' + o.voters.length,
              () =>
                setChoices((old) =>
                  value.multiple
                    ? old.includes(i)
                      ? old.filter((n) => n !== i)
                      : [...old, i].sort((a, b) => a - b)
                    : [i],
                ),
              choices.includes(i),
              ended,
            )}
          </View>
        ))}
        {value.closes_at && <Text style={{ color: c.dimmed }}>{new Date(value.closes_at).toLocaleString()}</Text>}
        {ended ? (
          <Text style={{ color: c.dimmed }}>{translate(language,"social.closed")}</Text>
        ) : (
          <View style={styles.actions}>
            {action(translate(language,"social.vote"), () => void send(choices))}
            {action(translate(language,"social.clear"), () => {
              setChoices([]);
              void send([]);
            })}
            {author === me &&
              action(translate(language,"social.close"), () => {
                if (chat)
                  void chat.transport
                    .closePoll(id, { operation_id: Crypto.randomUUID() })
                    .catch(() => notify(translate(language,"social.could_not_close_poll")));
              })}
          </View>
        )}
      </View>
    );
  }
  const expired = Date.parse(value.starts_at) <= clock;
  return (
    <View style={[styles.card, { borderColor: c.border }]}>
      <Text style={[styles.title, { color: c.text }]}>{value.title}</Text>
      <Text style={{ color: c.accent }}>{new Date(value.starts_at).toLocaleString()}</Text>
      <Text style={{ color: c.text }}>{value.description}</Text>
      <View style={styles.actions}>
        {[translate(language,"social.going"), translate(language,"social.maybe"), translate(language,"social.declined")].map((label, i) => (
          <View key={i}>
            {action(
              label + ' · ' + [value.going, value.maybe, value.declined][i]!.length,
              () => void send([i]),
              choices.includes(i),
              expired,
            )}
          </View>
        ))}
      </View>
      <JoinEventVoice room={room} c={c} />
      {!expired &&
        action(translate(language,"social.remind_me_beforehand"), () => {
          const account = currentReminderAccount();
          if (account)
            void setReminder(
              { account, messageId: id, rid: room, roomName: room, threadId: null, author, excerpt: value.title },
              Math.max(Date.now() + 60_000, Date.parse(value.starts_at) - 600_000),
            )
              .then(() => notify(translate(language,"social.reminder_added")))
              .catch(() => notify(translate(language,"social.could_not_set_reminder")));
        })}
    </View>
  );
}
function JoinEventVoice({ room, c }: { room: string; c: Colors }) {
  const router = useRouter(),
    sync = useSync(),
    language = useLanguage();
  return sync.phase === 'ready' && sync.provider.native?.chat.capabilities?.voice ? (
    <Pressable
      accessibilityRole="button"
      onPress={() => router.push({ pathname: '/voice/[rid]', params: { rid: room } })}
      style={styles.action}
    >
      <Text style={{ color: c.accent }}>{language === 'fr' ? 'Rejoindre l’appel' : 'Join voice'}</Text>
    </Pressable>
  ) : null;
}
export function VoiceReactions({ room }: { room: string }) {
  const sync = useSync(),
    voice = useVoice(),
    language = useLanguage(),
    c = useColors(),
    chat = sync.phase === 'ready' ? sync.provider.native?.chat : null,
    [unencrypted, setUnencrypted] = useState(false),
    [seen, setSeen] = useState<{ id: string; emoji: string; name: string }[]>([]);
  const ids = useRef(new Set<string>());
  useEffect(() => {
    let active = true;
    setUnencrypted(false);
    if (chat)
      void chat.store.roomEncrypted(room).then((encrypted) => {
        if (active) setUnencrypted(!encrypted);
      });
    return () => {
      active = false;
    };
  }, [chat, room]);
  useEffect(() => {
    if (!chat) return;
    const pull = () => {
      const reactions = chat.live.state?.voice_reactions ?? [];
      const incoming = reactions.filter((r) => r.room_id === room && !ids.current.has(r.id));
      for (const r of incoming) ids.current.add(r.id);
      if (incoming.length) {
        setSeen(
          incoming.map((r) => ({
            id: r.id,
            emoji: r.emoji,
            name: chat.live.state?.profiles?.find((p) => p.user.id === r.user_id)?.user.display_name ?? '',
          })),
        );
      }
      for (const id of ids.current) if (!reactions.some((r) => r.id === id)) ids.current.delete(id);
    };
    const off = chat.live.subscribe(pull);
    const timer = setInterval(() => {
      pull();
      setSeen((old) => old.filter((r) => (chat.live.state?.voice_reactions ?? []).some((x) => x.id === r.id)));
    }, 1000);
    return () => {
      off();
      clearInterval(timer);
    };
  }, [chat, room]);
  if (!unencrypted || !chat?.capabilities?.voice_reactions || voice.room !== room || voice.phase !== 'connected')
    return null;
  return (
    <View style={{ alignItems: 'center', gap: 6 }}>
      <View accessibilityLiveRegion="polite" style={styles.actions}>
        {seen.map((r) => (
          <VoiceBurst key={r.id} emoji={r.emoji} name={r.name} color={c.text} />
        ))}
      </View>
      <View style={styles.actions}>
        {['👏', '😂', '❤️', '🎉', '👍', '👋'].map((emoji) => (
          <Pressable
            key={emoji}
            accessibilityRole="button"
            accessibilityLabel={language === 'fr' ? 'Réagir ' + emoji : 'React ' + emoji}
            onPress={() =>
              void chat.transport
                .reactVoice(room, { operation_id: Crypto.randomUUID(), emoji })
                .catch(() => notify(language === 'fr' ? 'Réaction indisponible' : 'Reaction unavailable'))
            }
            style={{ padding: 8 }}
          >
            <Text style={{ fontSize: 22 }}>{emoji}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}
function VoiceBurst({ emoji, name, color }: { emoji: string; name: string; color: string }) {
  const lift = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const animation = Animated.timing(lift, { toValue: 1, duration: 1800, useNativeDriver: true });
    animation.start();
    return () => animation.stop();
  }, [lift]);
  return (
    <Animated.Text
      accessibilityLabel={name + ' ' + emoji}
      style={{
        fontSize: 36,
        color,
        transform: [{ translateY: lift.interpolate({ inputRange: [0, 1], outputRange: [8, -12] }) }],
      }}
    >
      {emoji}
    </Animated.Text>
  );
}
const styles = StyleSheet.create({
  card: { padding: 12, gap: 8, borderRadius: 14, borderWidth: 1, maxWidth: 340 },
  title: { fontFamily: FONTS.bodyBold, fontSize: 16 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  action: { padding: 9, borderRadius: 10, borderWidth: 1 },
});
