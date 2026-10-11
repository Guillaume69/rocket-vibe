import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ScrollView,
  View,
  Text,
  TextInput,
  Pressable,
  Image,
  Switch,
  ActivityIndicator,
  StyleSheet,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Crypto from 'expo-crypto';
import { useSession } from '../ui/session.tsx';
import { useSync } from '../ui/sync.tsx';
import { useLanguage } from '../ui/i18n.ts';
import {translate} from '../ui/messages.ts';
import { useColors, FONTS } from '../ui/theme.ts';
import { useSheetBottomMargin } from '../ui/sheetMargin.ts';
import { readLocalStickers, writeLocalStickers } from '../ui/social.tsx';
import { finishGifSelection } from '../ui/gifSelection.ts';
import { imageLink, searchGiphy, sendGiphy, type GifPreview } from '../lib/giphy.ts';
import { pickableDays, atMinute } from '../lib/scheduled.ts';
import { minuteOf } from '../lib/quiet.ts';
import type { CreateSocial, Sticker } from '../providers/rocketvibe/protocol.generated.ts';
type Mode = 'menu' | 'poll' | 'game_night' | 'stickers' | 'giphy';
type Media = { id: string; name: string; url: string; preview?: GifPreview };
export default function SocialScreen() {
  const params = useLocalSearchParams<{ rid: string; root?: string; mode?: string; q?: string; request?: string }>(),
    { state } = useSession(),
    sync = useSync(),
    c = useColors(),
    language = useLanguage(),
    router = useRouter(),
    bottom = useSheetBottomMargin();
  const client = state.phase === 'connected' ? state.client : null,
    session = state.phase === 'connected' ? state.session : null,
    chat = sync.phase === 'ready' ? sync.provider.native?.chat : null,
    account = session ? session.baseUrl + '|' + session.userId : null;
  const [mode, setMode] = useState<Mode>(params.mode === 'giphy' ? 'giphy' : 'menu'),
    [title, setTitle] = useState(''),
    [options, setOptions] = useState(''),
    [description, setDescription] = useState(''),
    [multiple, setMultiple] = useState(false),
    [closing, setClosing] = useState(0),
    [closingAt,setClosingAt]=useState<string|null>(null),
    [day, setDay] = useState(1),
    [time, setTime] = useState('20:00'),
    [query, setQuery] = useState(params.q ?? ''),
    [url, setUrl] = useState(''),
    [items, setItems] = useState<Media[]>([]),
    [resultQuery, setResultQuery] = useState(query),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const days = useMemo(() => pickableDays(new Date()), []),
    alive = useRef(true),
    running = useRef(false),
    request = useRef(0),
    attempts = useRef(new Map<string, string>());
  const op = (key: string) => {
    let id = attempts.current.get(key);
    if (!id) {
      id = Crypto.randomUUID();
      attempts.current.set(key, id);
    }
    return id;
  };
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      request.current++;
      finishGifSelection(params.request, false);
    };
  }, [account, params.request]);
  const accountRef = useRef(account);
  accountRef.current = account;
  const active = () => alive.current && accountRef.current === account && !!client && !!session;
  const run = async (fn: () => Promise<void>) => {
    if (running.current || !active()) return;
    running.current = true;
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch {
      if (active())
        setError(
          translate(language,"social.could_not_complete_check_the_fields_or_try_again"),
        );
    } finally {
      running.current = false;
      if (active()) setBusy(false);
    }
  };
  const load = async (next: Mode) => {
    const version = ++request.current;
    if (!active()) return;
    setError('');
    setItems([]);
    try {
      if (next === 'stickers') {
        const stickers = chat ? (await chat.transport.stickers()).stickers : await readLocalStickers(account!);
        if (active() && version === request.current)
          setItems(stickers.map((s) => ({ id: s.id, name: s.name, url: s.url })));
      } else if (next === 'giphy') {
        const sentQuery = query;
        const result = chat
          ? (await chat.transport.gifs(sentQuery)).items.map((i) => ({ id: i.id, name: i.title || 'GIF', url: i.url }))
          : client!.kind === 'rocketchat'
            ? (await searchGiphy(client!, params.rid, sentQuery)).map((i) => ({
                id: i.id,
                name: 'GIF',
                url: i.value,
                preview: i,
              }))
            : [];
        if (active() && version === request.current) {
          setResultQuery(sentQuery);
          setItems(result);
        }
      }
    } catch {
      if (active() && version === request.current)
        setError(
          next === 'giphy'
            ? translate(language,"social.giphy_is_unavailable_on_this_server")
            : translate(language,"social.could_not_load_the_shelf"),
        );
    }
  };
  useEffect(() => {
    if (mode === 'stickers' || mode === 'giphy') void load(mode);
  }, [mode, account]);
  const change = (next: Mode) => {
    request.current++;
    setMode(next);
    setError('');
  };
  const publish = () =>
    run(async () => {
      if (!chat) return;
      const name = title.trim();
      if (!name) throw Error('title');
      let value: CreateSocial;
      if (mode === 'poll') {
        const choices = options
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean);
        if (
          choices.length < 2 ||
          choices.length > 10 ||
          new Set(choices.map((s) => s.toLowerCase())).size !== choices.length
        )
          throw Error('choices');
        value = {
          kind: 'poll',
          operation_id: '',
          question: name,
          options: choices,
          multiple,
          closes_at: closingAt,
          reply_to: params.root ?? null,
        };
      } else {
        const minute = minuteOf(time),
          date = minute === null ? null : atMinute(days[day]!, minute);
        if (!date || date.getTime() <= Date.now()) throw Error('date');
        value = {
          kind: 'game_night',
          operation_id: '',
          title: name,
          starts_at: date.toISOString(),
          description,
          reply_to: params.root ?? null,
        };
      }
      value.operation_id = op(JSON.stringify(value));
      await chat.transport.createSocial(params.rid, value);
      if (active()) router.back();
    });
  const send = (item: Media) =>
    run(async () => {
      if (chat)
        await chat.transport.sendImage(params.rid, {
          operation_id: op('send:' + item.url),
          title: item.name.slice(0, 200) || 'Sticker',
          url: item.url,
          reply_to: params.root ?? null,
        });
      else if (client?.kind === 'rocketchat') {
        if (item.preview)
          await sendGiphy(client, params.rid, resultQuery, item.preview, op('gif:' + item.id), params.root);
        else
          await client.post('chat.sendMessage', {
            body: {
              message: {
                _id: op('send:' + item.url),
                rid: params.rid,
                msg: '',
                attachments: [{ title: item.name, image_url: item.url, title_link: item.url }],
                ...(params.root ? { tmid: params.root } : {}),
              },
            },
          });
      }
      if (active()) {
        finishGifSelection(params.request, true);
        router.back();
      }
    });
  const save = (item: Media) =>
    run(async () => {
      if (!imageLink(item.url)) throw Error('url');
      if (chat)
        await chat.transport.saveSticker({
          operation_id: op('save:' + item.url),
          name: item.name.slice(0, 100) || 'Sticker',
          url: item.url,
        });
      else {
        const old = await readLocalStickers(account!);
        await writeLocalStickers(account!, [
          ...old.filter((s) => s.url !== item.url),
          { id: op('save:' + item.url), name: item.name.slice(0, 100), url: item.url },
        ]);
      }
      if (active() && mode === 'stickers') {
        setTitle('');
        setUrl('');
        await load('stickers');
      }
    });
  const remove = (item: Media) =>
    run(async () => {
      if (chat) await chat.transport.removeSticker(item.id);
      else {
        const old = await readLocalStickers(account!);
        await writeLocalStickers(
          account!,
          old.filter((s) => s.id !== item.id),
        );
      }
      if (active()) await load('stickers');
    });
  const label =
    mode === 'poll'
      ? translate(language,"social.poll")
      : mode === 'game_night'
        ? translate(language,"social.game")
        : mode === 'stickers'
          ? translate(language,"social.shelf")
          : mode === 'giphy'
            ? 'GIF · Powered By GIPHY'
            : translate(language,"social.share_something");
  const button = (text: string, fn: () => void, selected = false) => (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: busy, selected }}
      disabled={busy}
      onPress={fn}
      style={[
        styles.button,
        { borderColor: selected ? c.accent : c.border, backgroundColor: selected ? c.accent : c.card },
      ]}
    >
      <Text style={{ color: selected ? c.onAccent : c.text }}>{text}</Text>
    </Pressable>
  );
  const field = (hint: string, value: string, set: (value: string) => void, multiline = false) => (
    <View style={{ gap: 6 }}>
      <Text style={{ color: c.dimmed }}>{hint}</Text>
      <TextInput
        accessibilityLabel={hint}
        value={value}
        onChangeText={set}
        multiline={multiline}
        style={[styles.input, { color: c.text, borderColor: c.border, minHeight: multiline ? 90 : 44 }]}
        autoCapitalize="sentences"
      />
    </View>
  );
  return (
    <ScrollView
      style={{ backgroundColor: c.deepCard }}
      contentContainerStyle={{ padding: 20, paddingBottom: bottom, gap: 14 }}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={[styles.heading, { color: c.text }]}>{label}</Text>
      {mode !== 'menu' && button(translate(language,"social.back"), () => change('menu'))}
      {error !== '' && (
        <Text accessibilityLiveRegion="polite" style={{ color: c.errorText }}>
          {error}
        </Text>
      )}
      {busy && <ActivityIndicator color={c.accent} />}
      {mode === 'menu' && (
        <View style={{ gap: 10 }}>
          {chat?.capabilities?.social_cards && (
            <>
              {button(translate(language,"social.poll"), () => change('poll'))}
              {button(translate(language,"social.game"), () => change('game_night'))}
            </>
          )}
          {(client?.kind === 'rocketchat' || chat?.capabilities?.sticker_shelf) &&
            button(translate(language,"social.shelf"), () => change('stickers'))}
          {(client?.kind === 'rocketchat' || chat?.capabilities?.giphy) &&
            button('GIF · Powered By GIPHY', () => change('giphy'))}
        </View>
      )}
      {(mode === 'poll' || mode === 'game_night') && (
        <>
          {field(mode === 'poll' ? translate(language,"social.question") : translate(language,"social.title_more"), title, setTitle)}
          {mode === 'poll' ? (
            <>
              {field(translate(language,"social.options"), options, setOptions, true)}
              <View style={styles.row}>
                <Text style={{ color: c.text }}>{translate(language,"social.multiple_choices")}</Text>
                <Switch value={multiple} onValueChange={setMultiple} />
              </View>
              <Text style={{ color: c.dimmed }}>{translate(language,"social.closing_time")}</Text>
              <View style={styles.row}>
                {[0, 1, 24, 168].map((h) => (
                  <View key={h}>
                    {button(
                      h === 0
                        ? translate(language,"social.no_deadline")
                        : h === 1
                          ? translate(language,"social.in_1_hour")
                          : h === 24
                            ? translate(language,"social.in_1_day")
                            : translate(language,"social.in_1_week"),
                      () => {setClosing(h);setClosingAt(h?new Date(Date.now()+h*3_600_000).toISOString():null)},
                      closing === h,
                    )}
                  </View>
                ))}
              </View>
            </>
          ) : (
            <>
              {field(translate(language,"social.details_more"), description, setDescription, true)}
              <Text style={{ color: c.dimmed }}>{translate(language,"social.date_in_your_timezone")}</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
                {days.map((date, i) => (
                  <View key={date.getTime()}>
                    {button(
                      date.toLocaleDateString(language === 'fr' ? 'fr-FR' : 'en-US', {
                        weekday: 'short',
                        day: 'numeric',
                        month: 'short',
                      }),
                      () => setDay(i),
                      day === i,
                    )}
                  </View>
                ))}
              </ScrollView>
              {field(translate(language,"social.time_hh_mm"), time, setTime)}
            </>
          )}
          {button(translate(language,"social.post"), () => void publish())}
        </>
      )}
      {mode === 'giphy' && (
        <>
          {field(translate(language,"social.search_gifs"), query, setQuery)}
          {button(translate(language,"social.search"), () => void load('giphy'))}
          <Text style={{ color: c.dimmed }}>Powered By GIPHY</Text>
        </>
      )}
      {(mode === 'giphy' || mode === 'stickers') && (
        <View style={styles.grid}>
          {items.map((item) => (
            <View key={item.id} style={[styles.item, { borderColor: c.border }]}>
              <Image
                source={{ uri: item.url }}
                style={{ height: 130, width: '100%' }}
                resizeMode="contain"
                accessibilityLabel={item.name}
              />
              <Text numberOfLines={2} style={{ color: c.text }}>
                {item.name}
              </Text>
              {button(translate(language,"social.send"), () => void send(item))}
              {mode === 'giphy'
                ? button(translate(language,"social.save"), () => void save(item))
                : button(translate(language,"social.remove"), () => void remove(item))}
            </View>
          ))}
        </View>
      )}
      {mode === 'stickers' && (
        <>
          {items.length === 0 && (
            <Text style={{ color: c.dimmed }}>
              {translate(language,"social.save_a_gif_or_add_your_images")}
            </Text>
          )}
          {field(translate(language,"social.name"), title, setTitle)}
          {field(translate(language,"social.image_link"), url, setUrl)}
          {button(translate(language,"social.add"), () => void save({ id: '', name: title.trim(), url: url.trim() }))}
        </>
      )}
    </ScrollView>
  );
}
const styles = StyleSheet.create({
  heading: { fontFamily: FONTS.bodyBold, fontSize: 22 },
  input: { borderWidth: 1, borderRadius: 12, padding: 10, fontFamily: FONTS.body, fontSize: 16 },
  button: { borderWidth: 1, borderRadius: 12, padding: 10 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  item: { width: '47%', flexGrow: 1, borderWidth: 1, borderRadius: 12, padding: 8, gap: 8 },
});
