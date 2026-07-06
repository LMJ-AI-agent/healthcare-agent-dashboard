#!/usr/bin/env node
import { exchangeHealthPlanetCode, readHealthPlanetClient } from '../src/healthPlanet.js';

const code = readArg('--code');
if (!code) {
  throw new Error('Usage: npm run healthplanet:token -- --code YOUR_AUTH_CODE');
}

const clientPath = readArg('--client') || 'secrets/healthplanet-client.json';
const tokenPath = readArg('--token') || 'secrets/healthplanet-token.json';
const client = await readHealthPlanetClient(clientPath);
const token = await exchangeHealthPlanetCode({ client, code, tokenPath });

console.log(`HealthPlanet token saved: ${tokenPath}`);
console.log(JSON.stringify({ token_type: token.token_type, expires_in: token.expires_in ?? null }, null, 2));

function readArg(name) {
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1];
  const prefix = `${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) || null;
}
