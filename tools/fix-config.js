#!/usr/bin/env node
'use strict';
// Javítja a config.json-t:
//  - HttpWebHooks: kiveszi az űrlap által létrehozott üres (név/azonosító nélküli) elemeket
//  - KlimaVezerlo: kiveszi a hiányos "rooms" beállítást (a beépített alapértelmezés marad)
//  - a homebridge-klima-vezerlo plugint újra engedélyezi
// Mentés előtt biztonsági másolatot készít: config.json.bak-<időbélyeg>
const fs = require('fs');
const path = require('path');

const file = process.argv[2] || '/var/lib/homebridge/config.json';
const raw = fs.readFileSync(file, 'utf8');
const cfg = JSON.parse(raw);
const changes = [];

for (const p of cfg.platforms || []) {
  if (p.platform === 'HttpWebHooks') {
    for (const [k, v] of Object.entries(p)) {
      if (!Array.isArray(v)) continue;
      const kept = v.filter(x => x && typeof x === 'object' && x.id && x.name);
      if (kept.length !== v.length) changes.push(`HttpWebHooks.${k}: ${v.length - kept.length} üres elem törölve`);
      if (kept.length) p[k] = kept; else delete p[k];
    }
  }
  if (p.platform === 'KlimaVezerlo' && Array.isArray(p.rooms)) {
    const ok = p.rooms.filter(r => r && r.id && r.acName);
    if (ok.length !== p.rooms.length) {
      changes.push(`KlimaVezerlo.rooms: ${p.rooms.length - ok.length} hiányos szoba törölve`);
      if (ok.length) p.rooms = ok; else delete p.rooms;
    }
  }
}
if (Array.isArray(cfg.disabledPlugins) && cfg.disabledPlugins.includes('homebridge-klima-vezerlo')) {
  cfg.disabledPlugins = cfg.disabledPlugins.filter(x => x !== 'homebridge-klima-vezerlo');
  changes.push('homebridge-klima-vezerlo újra engedélyezve');
}

if (!changes.length) { console.log('Nem kellett változtatni.'); process.exit(0); }
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const bak = `${file}.bak-${stamp}`;
fs.writeFileSync(bak, raw);
fs.writeFileSync(file, JSON.stringify(cfg, null, 4) + '\n');
console.log(changes.map(c => ' - ' + c).join('\n'));
console.log(`Kész. Biztonsági másolat: ${path.basename(bak)}`);
console.log('Most indítsd újra a Homebridge-et.');
