#!/usr/bin/env node
import { buildHealthPlanetAuthUrl, readHealthPlanetClient } from '../src/healthPlanet.js';

const clientPath = process.argv[2] || 'secrets/healthplanet-client.json';
const client = await readHealthPlanetClient(clientPath);

console.log(buildHealthPlanetAuthUrl(client));
