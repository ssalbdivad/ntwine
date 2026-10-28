#!/usr/bin/env node
// Availability sweep for a product name across npm and DNS, in one pass.
//
//   node scripts/check-names.mjs ntwine.dev ntwineground.com npm:ntwineground
//   node scripts/check-names.mjs --domains com,dev,sh --names ntwineground,ntwinehq
//
// Domains: RDAP first (rdap.org bootstrap). A 404 with a JSON body means the registry
// answered "no such domain" => available. A 404 with an EMPTY body means rdap.org has no
// server for that TLD, so we fall back to `whois -h <registry host>` and read its
// "Domain not found." line. Never trust a network error as "available".
//
// npm: GET registry.npmjs.org/<name> — 404 => unpublished. Scoped names work too.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

const WHOIS_HOST = (tld) =>
  ({ com: "whois.verisign-grs.com", net: "whois.verisign-grs.com" })[tld] ?? `whois.nic.${tld}`;

async function rdap(domain) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`https://rdap.org/domain/${domain}`, {
        redirect: "follow",
        signal: AbortSignal.timeout(15000),
      });
      const body = await res.text();
      if (res.status === 200) return { state: "taken", via: "rdap" };
      if (res.status === 404) {
        // Empty body = rdap.org knows no server for this TLD, not an answer about the domain.
        if (body.trim().length === 0) return { state: "unknown", via: "rdap-no-server" };
        return { state: "free", via: "rdap" };
      }
    } catch {
      // fall through to retry
    }
  }
  return { state: "unknown", via: "rdap-error" };
}

async function whois(domain) {
  const tld = domain.split(".").pop();
  try {
    const { stdout } = await run("whois", ["-h", WHOIS_HOST(tld), domain], {
      timeout: 20000,
      maxBuffer: 1 << 20,
    });
    const text = stdout.toLowerCase();
    if (/no match|not found|no data found|no entries found|is available/.test(text))
      return { state: "free", via: "whois" };
    if (/domain name:|creation date:|registrar:/.test(text)) return { state: "taken", via: "whois" };
    return { state: "unknown", via: "whois-unparsed" };
  } catch {
    return { state: "unknown", via: "whois-error" };
  }
}

async function checkDomain(domain) {
  const first = await rdap(domain);
  if (first.state !== "unknown") return { target: domain, kind: "domain", ...first };
  return { target: domain, kind: "domain", ...(await whois(domain)) };
}

async function checkNpm(name) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`https://registry.npmjs.org/${name.replace("/", "%2F")}`, {
        signal: AbortSignal.timeout(15000),
      });
      if (res.status === 404) return { target: name, kind: "npm", state: "free", via: "registry" };
      if (res.status === 200) {
        const j = await res.json();
        const latest = j["dist-tags"]?.latest;
        return {
          target: name,
          kind: "npm",
          state: "taken",
          via: "registry",
          note: `v${latest}, modified ${j.time?.modified?.slice(0, 10)}`,
        };
      }
    } catch {
      // retry
    }
  }
  return { target: name, kind: "npm", state: "unknown", via: "registry-error" };
}

async function pool(items, limit, worker) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await worker(items[i]);
      }
    }),
  );
  return out;
}

function parseArgs(argv) {
  const targets = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--domains" || argv[i] === "--names") flags[argv[i].slice(2)] = argv[++i];
    else targets.push(argv[i]);
  }
  if (flags.names) {
    const tlds = (flags.domains ?? "com").split(",");
    for (const name of flags.names.split(",")) {
      targets.push(`npm:${name}`);
      for (const tld of tlds) targets.push(`${name}.${tld}`);
    }
  }
  return targets;
}

const targets = parseArgs(process.argv.slice(2));
if (targets.length === 0) {
  console.error("usage: check-names.mjs <domain|npm:name>... | --names a,b --domains com,dev");
  process.exit(1);
}

const results = await pool(targets, 8, (t) =>
  t.startsWith("npm:") ? checkNpm(t.slice(4)) : checkDomain(t),
);

const mark = { free: "FREE ", taken: "taken", unknown: "  ?  " };
for (const r of results) {
  console.log(
    `${mark[r.state]}  ${r.kind === "npm" ? "npm " : "    "}${r.target.padEnd(28)} ${r.via}${r.note ? ` (${r.note})` : ""}`,
  );
}
const unknown = results.filter((r) => r.state === "unknown");
if (unknown.length) console.error(`\n${unknown.length} inconclusive — re-run or check by hand.`);
