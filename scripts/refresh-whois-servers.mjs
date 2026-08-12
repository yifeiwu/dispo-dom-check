/**
 * Builds the port-43 server map for every root-zone suffix that publishes one, into
 * `lib/data/whois-servers.json`.
 *
 * This once covered only the suffixes with no RDAP, on the reasoning that where RDAP exists it is the
 * better source and a second entry beside it would answer a settled question twice. That holds only while
 * RDAP actually answers. Measured against the labelled holdout, 14% of domains got no registration record
 * because their registry rate limits by stalling the connection rather than returning a status, and port
 * 43 answered those same domains immediately — so for them the question was not settled at all, and the
 * map's own scope was what made the fallback impossible. RDAP is still preferred wherever it responds.
 *
 * The server for each suffix comes from IANA's own root database over port 43, which is the authoritative
 * registry-to-server mapping rather than a community list that has to be trusted. Discovery is done here
 * instead of at request time because it would otherwise cost an extra round trip on every lookup, to learn
 * something that changes on the order of years.
 *
 * Run `npm run refresh:whois` and commit the diff.
 */
import { createConnection } from 'node:net';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const RDAP_BOOTSTRAP = 'https://data.iana.org/rdap/dns.json';
const ROOT_ZONE_TLDS = 'https://data.iana.org/TLD/tlds-alpha-by-domain.txt';
const IANA_WHOIS = 'whois.iana.org';
const OUTPUT = fileURLToPath(new URL('../lib/data/whois-servers.json', import.meta.url));

const CONCURRENCY = 8;
const TIMEOUT_MS = 10_000;

/** One port-43 query. Duplicated from `lib/collect/whois.ts` so the script stays free of the app build. */
function whoisQuery(server, query) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: server, port: 43 });
    const chunks = [];

    socket.setTimeout(TIMEOUT_MS);
    socket.on('connect', () => socket.write(`${query}\r\n`));
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    socket.on('timeout', () => {
      socket.destroy();
      reject(new Error(`timeout after ${TIMEOUT_MS}ms`));
    });
    socket.on('error', (error) => {
      socket.destroy();
      reject(error);
    });
  });
}

async function fetchText(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.text();
}

const [bootstrapJson, tldList] = await Promise.all([fetchText(RDAP_BOOTSTRAP), fetchText(ROOT_ZONE_TLDS)]);

const withRdap = new Set();
for (const [suffixes, urls] of JSON.parse(bootstrapJson).services) {
  if (urls.length > 0) for (const suffix of suffixes) withRdap.add(suffix.toLowerCase());
}

const allTlds = tldList
  .split('\n')
  .map((line) => line.trim().toLowerCase())
  .filter((line) => line && !line.startsWith('#'));

const missing = allTlds;

console.log(
  `${allTlds.length} suffixes in the root zone, ${withRdap.size} with RDAP, ` +
    `all ${missing.length} to look up over port 43 so a stalled RDAP server has somewhere to fall back to`,
);

const servers = {};
const noServer = [];
const failed = [];
let done = 0;

async function worker(queue) {
  for (;;) {
    const tld = queue.shift();
    if (!tld) return;
    try {
      const response = await whoisQuery(IANA_WHOIS, tld);
      // IANA's root record carries at most one `whois:` line, naming the registry's port-43 server.
      const server = response.match(/^whois:\s*(\S+)\s*$/im)?.[1]?.toLowerCase();
      if (server) servers[tld] = server;
      else noServer.push(tld);
    } catch (error) {
      failed.push(`${tld}: ${error.message}`);
    }
    done += 1;
    if (done % 50 === 0) process.stderr.write(`  ${done}/${missing.length}\n`);
  }
}

const queue = [...missing];
await Promise.all(Array.from({ length: CONCURRENCY }, () => worker(queue)));

if (failed.length > 0) {
  console.error(`\n${failed.length} lookups failed and are absent from the map:`);
  for (const entry of failed) console.error(`  ${entry}`);
}

const sorted = {};
for (const tld of Object.keys(servers).sort()) sorted[tld] = servers[tld];

const snapshot = {
  source: `${IANA_WHOIS} root database, every root-zone suffix publishing a port-43 server`,
  fetchedAt: new Date().toISOString().slice(0, 10),
  servers: sorted,
};

await writeFile(OUTPUT, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');

console.log(
  `\nWrote ${Object.keys(sorted).length} suffixes to ${OUTPUT}\n` +
    `${noServer.length} publish no port-43 server and stay unsupported where RDAP cannot answer either`,
);
