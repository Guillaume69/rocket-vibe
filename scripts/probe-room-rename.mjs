#!/usr/bin/env node
// Self-cleaning rename probe on the local benches: a throwaway channel is
// created, renamed, read back, then deleted. Rocket.Chat through
// rooms.saveRoomSettings {roomName}, Mattermost through the channel patch.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(
  readFileSync(join(ROOT, 'docker', '.env'), 'utf8')
    .split('\n')
    .map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2].replace(/^(['"])(.*)\1$/, '$2')]),
);
const stamp = Date.now().toString(36);

async function rocketChat() {
  const base = env.ROOT_URL.replace(/\/$/, '');
  let auth = {};
  const call = async (method, path, body) => {
    const r = await fetch(`${base}/api/v1/${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...auth },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  const login = await call('POST', 'login', { user: env.ADMIN_USERNAME, password: env.ADMIN_PASS });
  auth = { 'X-User-Id': login.json.data.userId, 'X-Auth-Token': login.json.data.authToken };
  const made = await call('POST', 'channels.create', { name: `rv-rename-${stamp}` });
  const rid = made.json.channel._id;
  const out = {};
  const pick = async () => {
    const info = (await call('GET', `rooms.info?roomId=${rid}`)).json.room;
    return { name: info.name, fname: info.fname };
  };
  for (const name of [`rv-renamed-${stamp}`, `Renamed ${stamp}`, `été-${stamp}`, '']) {
    const r = await call('POST', 'rooms.saveRoomSettings', { rid, roomName: name });
    out[JSON.stringify(name)] = { status: r.status, error: r.json?.errorType ?? r.json?.error ?? null, after: await pick() };
  }
  const del = await call('POST', 'channels.delete', { roomId: rid });
  return { ...out, cleaned: del.status };
}

async function mattermost() {
  const base = (process.env.MM_URL ?? 'http://127.0.0.1:8065').replace(/\/$/, '');
  const password = process.env.MM_PASSWORD ?? 'Rv-bench-2026!';
  let token = '';
  const call = async (method, path, body) => {
    const r = await fetch(`${base}/api/v4${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, token: r.headers.get('token'), json: await r.json().catch(() => null) };
  };
  token = (await call('POST', '/users/login', { login_id: 'rvadmin', password })).token;
  const team = (await call('GET', '/users/me/teams')).json[0].id;
  const made = await call('POST', '/channels', { team_id: team, name: `rv-rename-${stamp}`, display_name: 'Rename probe', type: 'O' });
  const id = made.json.id;
  const out = {};
  for (const display of [`Renamed ${stamp}`, `Été ${stamp}`, '']) {
    const r = await call('PUT', `/channels/${id}/patch`, { display_name: display });
    const back = (await call('GET', `/channels/${id}`)).json;
    out[JSON.stringify(display)] = { status: r.status, error: r.json?.id ?? null, after: { name: back.name, display_name: back.display_name } };
  }
  const del = await call('DELETE', `/channels/${id}`);
  return { ...out, cleaned: del.status };
}

console.log(JSON.stringify({ rocketchat: await rocketChat().catch((e) => String(e)), mattermost: await mattermost().catch((e) => String(e)) }, null, 2));
