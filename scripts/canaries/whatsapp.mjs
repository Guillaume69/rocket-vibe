import { broken, check, notice, ok, pick, request, source } from './lib.mjs';

const STAMP = 'crates/rv-whatsapp/wacore/src/version/generated.rs';
const FETCH = 'crates/rv-whatsapp/src/version.rs';
const PARSE = 'crates/rv-whatsapp/wacore/src/version.rs';
const TOKENS = 'crates/rv-whatsapp/wacore/binary/src/tokens.json';
const DICT = 'crates/rv-whatsapp/wacore/binary/src/token.rs';
const WHATSPEC = 'https://raw.githubusercontent.com/oxidezap/whatspec/main/generated';

/** `parse_sw_js` (crates/rv-whatsapp/wacore/src/version.rs): the first digits after the revision key. */
export function swRevision(text, key) {
  const at = text.indexOf(key);
  if (at < 0) return null;
  const digits = /\d+/.exec(text.slice(at + key.length));
  return digits ? Number(digits[0]) : null;
}

export async function whatsapp() {
  const stamp = pick(STAMP, /WA_WEB_VERSION_STR: &str = "([\d.]+)"/, 'the vendored WhatsApp Web version');
  const revision = Number(stamp.split('.')[2]);
  let live = null;

  const sw = await check('wa.sw-revision', async () => {
    const url = pick(FETCH, /url: "(https:\/\/web\.whatsapp\.com\/sw\.js)"/, 'the sw.js URL');
    const agent = pick(FETCH, /"user-agent",\s*"([^"]+)"/, "the sw.js fetch's user agent");
    const key = pick(PARSE, /const REVISION_KEY: &str = "([^"]+)"/, 'the revision key');
    const answer = await request(url, { headers: { 'sec-fetch-site': 'none', connection: 'close', 'user-agent': agent } });
    if (answer.status !== 200) return broken('wa.sw-revision', `${url} answered ${answer.status} to the engine's request: the engine cannot learn the version and does not connect.`);
    live = swRevision(answer.text, key);
    if (live === null) return broken('wa.sw-revision', `${url} no longer carries \`${key}\` followed by a number: the engine cannot parse the version and does not connect.`);
    return ok('wa.sw-revision', `sw.js serves revision ${live}`);
  });

  const manifest = await check('wa.whatspec', async () => {
    const answer = await request(`${WHATSPEC}/manifest.json`);
    if (answer.status !== 200 || !answer.json) return broken('wa.whatspec', `whatspec's manifest answered ${answer.status}`);
    const theirs = answer.json.waVersion;
    if (theirs !== stamp) return broken('wa.whatspec', `whatspec now extracts WhatsApp Web ${theirs}; the vendored schemas, tables and version stamp are from ${stamp}. Regenerate them from whatspec and check what moved.`);
    return ok('wa.whatspec', `whatspec and the vendored code are both at ${stamp}`);
  });

  const tokens = await check('wa.tokens', async () => {
    const answer = await request(`${WHATSPEC}/tokens/tokens.json`);
    if (answer.status !== 200 || !answer.json) return broken('wa.tokens', `whatspec's tokens.json answered ${answer.status}`);
    const ours = JSON.parse(source(TOKENS));
    const theirs = answer.json;
    const differs = ['single_byte', 'double_byte'].filter((table) => JSON.stringify(ours[table]) !== JSON.stringify(theirs[table]));
    const index = await request(`${WHATSPEC}/tokens/index.json`);
    const dict = Number(pick(DICT, /DICT_VERSION: u8 = (\d+)/, 'the token dictionary version'));
    if (index.json?.dictVersion !== undefined && index.json.dictVersion !== dict) differs.push(`dictVersion ${index.json.dictVersion} (ours ${dict})`);
    if (differs.length > 0) return broken('wa.tokens', `the binary token dictionary moved: ${differs.join(', ')} differ from ${TOKENS}. Every stanza is encoded with it.`);
    return ok('wa.tokens', `token tables and dictionary version ${dict} match whatspec`);
  });

  const results = [sw, manifest, tokens];
  if (live !== null) results.push(notice('wa.drift', `live WhatsApp Web is ${live - revision} revisions past the vendored stamp ${stamp} (the engine reports the live one; only the schemas are that old)`));
  return results;
}
