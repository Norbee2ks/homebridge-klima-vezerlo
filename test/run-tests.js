'use strict';
// Egyszerű tesztek külső függőség nélkül: node test/run-tests.js
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const logic = require('../lib/logic');

let failed = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ok  ', name); } catch (e) { failed++; console.log('  HIBA', name, '\n', e); }
}
const D = logic.DEFAULTS;
const SCH = [{ start: '06:30', target: 23 }, { start: '17:00', target: 24 }, { start: '23:00', target: 21, night: true }];

(async () => {
  console.log('logika');
  await t('szakasz nappal', () => {
    const p = logic.currentPeriod(SCH, new Date(2026, 10, 21, 10, 0));
    assert.strictEqual(p.period.target, 23);
  });
  await t('szakasz éjfél után = előző napi éjszaka', () => {
    const p = logic.currentPeriod(SCH, new Date(2026, 10, 22, 2, 0));
    assert.strictEqual(p.period.target, 21);
    assert.ok(p.key.startsWith('2026-11-21@23:00'));
  });
  await t('fagyvédelem −6 °C-nál éjjel', () => {
    const b = logic.baseTarget(SCH, new Date(2026, 10, 22, 2, 0), -6, D);
    assert.strictEqual(b.target, 23.5); assert.ok(b.frost);
  });
  await t('nincs fagyvédelem −3 °C-nál', () => {
    const b = logic.baseTarget(SCH, new Date(2026, 10, 22, 2, 0), -3, D);
    assert.strictEqual(b.target, 21);
  });
  await t('hideg nappali: magas beállítás, plafon cél+3', () => {
    const d = logic.decide({ roomTarget: 23, roomTemp: 21.5, bias: 2, night: false, opts: D });
    assert.strictEqual(d.setpoint, 26); assert.strictEqual(d.fan, 60);
  });
  await t('meleg háló: alacsony beállítás', () => {
    const d = logic.decide({ roomTarget: 22, roomTemp: 23.6, bias: -1.5, night: false, opts: D });
    assert.strictEqual(d.setpoint, 19); assert.strictEqual(d.fan, 40); // 22 − 1,5 − 1,6 = 18,9 → 19
  });
  await t('éjjel ventilátor max 40', () => {
    const d = logic.decide({ roomTarget: 21, roomTemp: 19, bias: 0, night: true, opts: D });
    assert.strictEqual(d.fan, 40);
  });
  await t('szenzor nélkül: cél + eltolás', () => {
    const d = logic.decide({ roomTarget: 23, roomTemp: null, bias: 1.2, night: false, opts: D });
    assert.strictEqual(d.setpoint, 24);
  });
  await t('tanult eltolás lépés és korlát', () => {
    assert.strictEqual(logic.updateBias(1, 0.5, D), 1.1);
    assert.strictEqual(logic.updateBias(1, 0.2, D), 1);
    assert.strictEqual(logic.updateBias(3, 2, D), 3);
    assert.strictEqual(logic.updateBias(-2, -1, D), -2);
  });

  console.log('integráció (mock Homebridge + mock HAP)');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kv-'));
  const PIN = '111-22-333';
  // mock HAP szerver: egy Midea-szerű klíma
  const chars = { '2.10': 1, '2.11': 22.0, '2.12': 23, '2.13': 1, '2.14': 41, '2.21': 4.5, '2.31': false, '2.41': 0, '2.42': 0, '2.43': 25 };
  const writes = [];
  const hapSrv = http.createServer((req, res) => {
    if (req.headers.authorization !== PIN) { res.writeHead(470); return res.end(); }
    if (req.method === 'GET' && req.url === '/accessories') {
      res.writeHead(200, { 'Content-Type': 'application/hap+json' });
      return res.end(JSON.stringify({ accessories: [{ aid: 2, services: [
        { iid: 1, type: '3E', characteristics: [{ iid: 2, type: '23', value: 'Nappali' }] },
        { iid: 9, type: 'BC', characteristics: [
          { iid: 8, type: '23', value: 'Nappali' },
          { iid: 10, type: 'B0', value: chars['2.10'] }, { iid: 11, type: '11', value: 22 },
          { iid: 12, type: '12', value: 23 }, { iid: 13, type: 'B2', value: 1 }, { iid: 14, type: '29', value: 41 } ] },
        { iid: 20, type: '8A', characteristics: [{ iid: 19, type: '23', value: 'Outdoor' }, { iid: 21, type: '11', value: 4.5 }] },
        { iid: 30, type: '49', characteristics: [{ iid: 29, type: '23', value: 'Sleep' }, { iid: 31, type: '25', value: false }] },
        { iid: 40, type: '8C', characteristics: [{ iid: 39, type: '23', value: 'Swing' }, { iid: 41, type: '7C', value: 0 }, { iid: 42, type: '7D', value: 0 }, { iid: 43, type: '7B', value: 25 }] },
      ] }] }));
    }
    if (req.method === 'GET' && req.url.startsWith('/characteristics')) {
      const ids = new URL(req.url, 'http://x').searchParams.get('id').split(',');
      res.writeHead(200, { 'Content-Type': 'application/hap+json' });
      return res.end(JSON.stringify({ characteristics: ids.map(id => { const [aid, iid] = id.split('.').map(Number); return { aid, iid, value: chars[id] }; }) }));
    }
    if (req.method === 'PUT' && req.url === '/characteristics') {
      let b = ''; req.on('data', c => (b += c)); req.on('end', () => {
        for (const c of JSON.parse(b).characteristics) { chars[`${c.aid}.${c.iid}`] = c.value; writes.push(c); }
        res.writeHead(204); res.end();
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise(r => hapSrv.listen(0, '127.0.0.1', r));
  const hapPort = hapSrv.address().port;
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ bridge: { port: hapPort, pin: PIN }, platforms: [] }));

  const api = require('./mock-api')(tmp);
  const plugin = require('../index.js');
  plugin(api);
  const logs = [];
  const log = { info: m => logs.push('I ' + m), warn: m => logs.push('W ' + m), error: m => logs.push('E ' + m), debug: () => {} };
  const webhookPort = 52000 + Math.floor(Math.random() * 1000);
  const platform = new api.Platform(log, {
    platform: 'KlimaVezerlo', mode: 'eles', webhookPort,
    louver: { nappali: 100, nappaliOldal: 75 },
    rooms: [{ id: 'nappali', name: 'Nappali szoba', acName: 'Nappali', buttons: true, initialBias: 2, schedule: SCH }],
  }, api);
  api.emit('didFinishLaunching');
  clearInterval(platform.tickTimer);
  await new Promise(r => setTimeout(r, 300));

  await t('kiegészítők létrejöttek (szoba + 2 gomb)', () => {
    assert.strictEqual(api.registered.length, 4);
    assert.deepStrictEqual(api.registered.map(a => a.displayName).sort(), ['Fázok', 'Kinti hőmérséklet', 'Melegem van', 'Nappali szoba']);
  });
  const get = (p) => new Promise((res, rej) => http.get(`http://127.0.0.1:${webhookPort}${p}`, r => { r.resume(); res(r.statusCode); }).on('error', rej));
  await t('webhook: 200 ismert, 404 ismeretlen', async () => {
    assert.strictEqual(await get('/?accessoryId=nappali_hom&value=21.4'), 200);
    assert.strictEqual(await get('/?accessoryId=nappali_para&value=58'), 200);
    assert.strictEqual(await get('/?accessoryId=nappali_akku&value=12'), 200);
    assert.strictEqual(await get('/?accessoryId=teszt_hom&value=20'), 404);
  });
  const room = platform.rooms[0];
  await t('csempe értékek', async () => {
    const C = api.hap.Characteristic;
    const th = platform.ui.nappali.thermo;
    assert.strictEqual(await th.getCharacteristic(C.CurrentTemperature).get(), 21.4);
    assert.strictEqual(await th.getCharacteristic(C.CurrentRelativeHumidity).get(), 58);
    assert.strictEqual(await platform.ui.nappali.battery.getCharacteristic(C.StatusLowBattery).get(), 1);
  });
  await t('klíma felderítés (outdoor + sleep)', async () => {
    await platform.discover();
    const ac = platform.acs.nappali;
    assert.ok(ac && ac.refs.outdoor && ac.refs.sleep);
  });
  await t('kinti hőmérséklet csempe', async () => {
    await platform.tick(room, {});
    assert.strictEqual(await platform.outdoorSvc.getCharacteristic(api.hap.Characteristic.CurrentTemperature).get(), 4.5);
  });
  await t('éles mód: parancs a számolt beállításra', async () => {
    platform.st(room).lastCmdAt = 0;
    await platform.tick(room, { force: true });
    const exp = logic.decide({ roomTarget: platform.roomTarget(room).roomTarget, roomTemp: 21.4, bias: 2, night: false, opts: D }).setpoint;
    assert.strictEqual(chars['2.12'], exp, JSON.stringify(writes));
  });
  await t('kézi állítás felismerése és tiszteletben tartása', async () => {
    chars['2.12'] = 20;
    await platform.tick(room, { force: true });
    assert.strictEqual(platform.st(room).manualKey, platform.roomTarget(room).key);
    const n = writes.length;
    await platform.tick(room, { force: true });
    assert.strictEqual(writes.length, n);
    assert.strictEqual(chars['2.12'], 20);
  });
  await t('Melegem van gomb: −0,5 eltolás és naplózás', async () => {
    const C = api.hap.Characteristic;
    const btn = api.registered.find(a => a.displayName === 'Melegem van');
    await btn.services.find(s => s.isSwitch).getCharacteristic(C.On).set(true);
    assert.strictEqual(platform.st(room).offset, -0.5);
  });
  await t('CSV napló készült, fejléc + sorok', () => {
    const dir = path.join(tmp, 'klima-naplo');
    const f = fs.readdirSync(dir)[0];
    const lines = fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n');
    assert.ok(lines[0].includes('szobaho'));
    assert.ok(lines.some(l => l.includes(';gomb;')), lines.join('\n'));
    assert.ok(lines.some(l => l.includes(';kezi;')));
  });
  await t('szenzor kiesés: csempe „Nem válaszol”', async () => {
    const C = api.hap.Characteristic;
    platform.st(room).lastSeen = Date.now() - 60 * 60000;
    await platform.tick(room, {});
    await assert.rejects(() => platform.ui.nappali.thermo.getCharacteristic(C.CurrentTemperature).get());
  });

  await t('megfigyelő mód: nem ír a klímára', async () => {
    platform.mode = 'megfigyelo';
    const st = platform.st(room); st.manualKey = null; st.lastSeen = Date.now(); st.temp = 20;
    const n = writes.length;
    await platform.tick(room, { force: true });
    assert.strictEqual(writes.length, n);
  });
  await t('megfigyelő mód: rögzített ventilátor 70%', async () => {
    platform.config.fan = { nappali: 70, ej: 70 };
    chars['2.14'] = 41; platform.st(room).lastFanFixAt = 0;
    const realNow = Date.now; Date.now = () => new Date(2026, 10, 27, 10, 0).getTime();
    try { await platform.tick(room, {}); } finally { Date.now = realNow; }
    assert.strictEqual(chars['2.14'], 70);
    delete platform.config.fan;
  });
  await t('légterelő lapok visszaállítása (fel-le 100, oldal 75)', async () => {
    chars['2.41'] = 0; chars['2.43'] = 25; platform.st(room).lastLouverAt = 0;
    await platform.tick(room, {});
    assert.strictEqual(chars['2.41'], 100);
    assert.strictEqual(chars['2.43'], 75);
  });
  await t('napló letöltő oldal', async () => {
    const body = await new Promise((res, rej) => http.get(`http://127.0.0.1:${webhookPort}/naplo`, r => { let b = ''; r.on('data', c => (b += c)); r.on('end', () => res(b)); }).on('error', rej));
    assert.ok(body.includes('klima-') && body.includes('.csv'), body);
  });
  platform.server.close(); hapSrv.close();
  platform.saveState(true);
  console.log(failed ? `\n${failed} HIBA` : '\nMinden teszt rendben.');
  console.log(logs.filter(l => !l.startsWith('I ')).join('\n'));
  process.exit(failed ? 1 : 0);
})();
