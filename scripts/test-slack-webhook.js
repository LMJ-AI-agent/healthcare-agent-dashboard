#!/usr/bin/env node
import { readFile } from 'node:fs/promises';

const webhookUrl = (await readFile('secrets/slack-webhook.txt', 'utf8')).trim();
if (!webhookUrl) {
  throw new Error('secrets/slack-webhook.txt is empty.');
}

const response = await fetch(webhookUrl, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ text: 'Healthcare Agent: Slack webhook connection test.' }),
});

if (!response.ok) {
  throw new Error(`Slack webhook failed with ${response.status}: ${await response.text()}`);
}

console.log('Slack webhook test succeeded.');
