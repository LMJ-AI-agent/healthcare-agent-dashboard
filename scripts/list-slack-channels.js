#!/usr/bin/env node
import { readFile } from 'node:fs/promises';

const token = (await readFile('secrets/slack-bot-token.txt', 'utf8')).trim();
if (!token) throw new Error('secrets/slack-bot-token.txt is empty.');

const url = new URL('https://slack.com/api/conversations.list');
url.searchParams.set('types', 'public_channel,private_channel');
url.searchParams.set('limit', '1000');
url.searchParams.set('exclude_archived', 'true');

const response = await fetch(url, {
  headers: { Authorization: `Bearer ${token}` },
});
const data = await response.json();
if (!data.ok) throw new Error(`Slack API conversations.list failed: ${data.error}`);

for (const channel of data.channels || []) {
  console.log(`${channel.id}\t${channel.is_private ? 'private' : 'public'}\t#${channel.name}`);
}
