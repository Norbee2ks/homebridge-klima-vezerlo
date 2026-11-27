'use strict';
// Minimális kliens a Homebridge (insecure mode) helyi HAP HTTP felületéhez.
const http = require('http');

// HAP típusok (rövid forma, ahogy a HAP-NodeJS a /accessories-ban adja)
const T = {
  HeaterCooler: 'BC',
  TemperatureSensor: '8A',
  Switch: '49',
  Name: '23',
  ConfiguredName: 'E3',
  Active: 'B0',
  CurrentTemperature: '11',
  HeatingThreshold: '12',
  TargetHeaterCoolerState: 'B2',
  RotationSpeed: '29',
  On: '25',
  WindowCovering: '8C',
  TargetPosition: '7C',
  TargetVerticalTilt: '7D',
  TargetHorizontalTilt: '7B',
};

function shortType(t) {
  if (!t) return '';
  const s = String(t).toUpperCase();
  const m = /^0*([0-9A-F]+)-0000-1000-8000-0026BB765291$/.exec(s);
  return m ? m[1] : s.replace(/^0+/, '');
}

function request(port, pin, method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({
      host: '127.0.0.1', port, method, path,
      headers: {
        'Content-Type': 'application/hap+json',
        Authorization: pin,
        ...(data ? { 'Content-Length': data.length } : {}),
      },
      timeout: 8000,
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const txt = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = txt ? JSON.parse(txt) : null; } catch (_) { /* nem JSON */ }
        resolve({ status: res.statusCode, json, text: txt });
      });
    });
    req.on('timeout', () => req.destroy(new Error('időtúllépés')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function charName(service) {
  const c = service.characteristics.find(x => shortType(x.type) === T.ConfiguredName)
    || service.characteristics.find(x => shortType(x.type) === T.Name);
  return c ? String(c.value || '') : '';
}

function findChar(service, type) {
  return service.characteristics.find(x => shortType(x.type) === type) || null;
}

/**
 * Megkeresi a klímát név alapján az összes megadott híd (port) között.
 * Visszaad: { port, pin, aid, refs: {active, cur, heat, mode, fan, outdoor, sleep} } – minden ref {aid, iid} vagy null
 */
async function discoverAc(targets, acName, log) {
  const wanted = acName.trim().toLowerCase();
  for (const t of targets) {
    let r;
    try { r = await request(t.port, t.pin, 'GET', '/accessories'); } catch (e) { continue; }
    if (r.status === 401 || r.status === 470) {
      log.warn(`[HAP] A ${t.port} porton elutasítva (${r.status}) – be van kapcsolva az insecure mode, és jó a PIN?`);
      continue;
    }
    if (!r.json || !Array.isArray(r.json.accessories)) continue;
    const accs = r.json.accessories;
    for (const acc of accs) {
      const hc = acc.services.find(s => shortType(s.type) === T.HeaterCooler && charName(s).trim().toLowerCase() === wanted);
      if (!hc) continue;
      const ref = (a, c) => (c ? { aid: a, iid: c.iid } : null);
      const out = {
        port: t.port, pin: t.pin, aid: acc.aid,
        refs: {
          active: ref(acc.aid, findChar(hc, T.Active)),
          cur: ref(acc.aid, findChar(hc, T.CurrentTemperature)),
          heat: ref(acc.aid, findChar(hc, T.HeatingThreshold)),
          mode: ref(acc.aid, findChar(hc, T.TargetHeaterCoolerState)),
          fan: ref(acc.aid, findChar(hc, T.RotationSpeed)),
          outdoor: null, sleep: null, louverPos: null, louverTilt: null, louverH: null,
        },
      };
      // 1) ugyanazon kiegészítő szolgáltatásai között
      const scan = (a, own) => {
        for (const s of a.services) {
          const n = charName(s).toLowerCase();
          const nameOk = own || n.includes(wanted);
          if (!out.refs.outdoor && shortType(s.type) === T.TemperatureSensor && n.includes('outdoor') && nameOk) out.refs.outdoor = ref(a.aid, findChar(s, T.CurrentTemperature));
          if (!out.refs.sleep && shortType(s.type) === T.Switch && /sleep$/.test(n) && nameOk) out.refs.sleep = ref(a.aid, findChar(s, T.On));
          // légterelő lap (Midea „Swing” szögkiegészítő): ablakárnyékoló-szerű szolgáltatás
          if (!out.refs.louverPos && nameOk && (own || n.includes('swing'))) {
            const tp = findChar(s, T.TargetPosition);
            const tt = findChar(s, T.TargetVerticalTilt);
            if (shortType(s.type) === T.WindowCovering || tt) {
              out.refs.louverPos = ref(a.aid, tp);
              out.refs.louverTilt = ref(a.aid, tt);
              out.refs.louverH = ref(a.aid, findChar(s, T.TargetHorizontalTilt));
            }
          }
        }
      };
      scan(acc, true);
      // 2) külön kiegészítőként, a klíma nevével
      for (const a of accs) if (a.aid !== acc.aid) scan(a, false);
      return out;
    }
  }
  return null;
}

async function readAc(ac) {
  const keys = Object.keys(ac.refs).filter(k => ac.refs[k]);
  const ids = keys.map(k => `${ac.refs[k].aid}.${ac.refs[k].iid}`).join(',');
  const r = await request(ac.port, ac.pin, 'GET', `/characteristics?id=${ids}`);
  if (!r.json || !Array.isArray(r.json.characteristics)) throw new Error(`HAP olvasás sikertelen (${r.status})`);
  const val = {};
  for (const c of r.json.characteristics) val[`${c.aid}.${c.iid}`] = c.value;
  const v = k => (ac.refs[k] && val[`${ac.refs[k].aid}.${ac.refs[k].iid}`] !== undefined ? val[`${ac.refs[k].aid}.${ac.refs[k].iid}`] : null);
  const sleep = v('sleep');
  return { active: v('active'), cur: v('cur'), heat: v('heat'), mode: v('mode'), fan: v('fan'), outdoor: v('outdoor'), sleep: sleep === null ? null : !!sleep, louverPos: v('louverPos'), louverTilt: v('louverTilt'), louverH: v('louverH') };
}

async function writeAc(ac, values) {
  const list = [];
  for (const [k, val] of Object.entries(values)) {
    if (!ac.refs[k]) continue;
    list.push({ aid: ac.refs[k].aid, iid: ac.refs[k].iid, value: val });
  }
  if (!list.length) return;
  const r = await request(ac.port, ac.pin, 'PUT', '/characteristics', { characteristics: list });
  if (r.status !== 204 && r.status !== 207 && r.status !== 200) throw new Error(`HAP írás sikertelen (${r.status}) ${r.text}`);
  if (r.status === 207 && r.json && Array.isArray(r.json.characteristics)) {
    const bad = r.json.characteristics.filter(c => c.status && c.status !== 0);
    if (bad.length) throw new Error(`HAP írás részben sikertelen: ${JSON.stringify(bad)}`);
  }
}

module.exports = { request, discoverAc, readAc, writeAc, shortType };
