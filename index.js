'use strict';
/*
 * homebridge-klima-vezerlo
 * Szobaszenzor-alapú klímavezérlés Midea (vagy bármely HeaterCooler) klímákhoz.
 *  - fogadja az ESP szenzorok webhookjait (http-webhooks kompatibilis URL)
 *  - szobánként egy termosztát-csempe a valós szobahővel (+ pára, akku)
 *  - „Melegem van” / „Fázok” gombok
 *  - szabályozás: megfigyelő módban csak naplóz, éles módban állítja a klímát
 *  - CSV napló a Homebridge tárhelyén
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { URL } = require('url');
const logic = require('./lib/logic');
const hap = require('./lib/hap-client');
const { CsvLog } = require('./lib/csvlog');

const PLUGIN_NAME = 'homebridge-klima-vezerlo';
const PLATFORM_NAME = 'KlimaVezerlo';

module.exports = (api) => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, KlimaVezerloPlatform);
};

const DEFAULT_ROOMS = [
  {
    id: 'nappali', name: 'Nappali szoba', acName: 'Nappali', buttons: true, initialBias: 2,
    schedule: [{ start: '06:30', target: 23 }, { start: '17:00', target: 24 }, { start: '23:00', target: 21, night: true }],
  },
  {
    id: 'halo', name: 'Háló szoba', acName: 'Hálószoba', buttons: false, initialBias: -1.5,
    schedule: [{ start: '06:30', target: 22 }, { start: '17:00', target: 22 }, { start: '23:00', target: 21, night: true }],
  },
];

class KlimaVezerloPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.hapTypes = api.hap;
    this.cached = new Map();
    this.mode = this.config.mode === 'eles' ? 'eles' : 'megfigyelo';
    this.opts = { ...logic.DEFAULTS, ...(this.config.tuning || {}) };
    this.rooms = this.validRooms(this.config.rooms);

    this.storage = api.user.storagePath();
    this.statePath = path.join(this.storage, 'klima-vezerlo-state.json');
    this.csv = new CsvLog(path.join(this.storage, 'klima-naplo'), log);
    this.state = this.loadState();
    this.outdoor = null;
    this.acs = {};          // roomId -> discovered AC
    this.ui = {};           // roomId -> { acc, thermo, battery }
    this.lastErr = {};

    api.on('didFinishLaunching', () => this.start());
    api.on('shutdown', () => this.saveState(true));
  }

  // Hiányos/hibás szoba- és menetrend-beállításnál nem áll le: a hibás elemet kihagyja, és az alapértéket használja.
  validRooms(cfgRooms) {
    const okPeriod = p => p && typeof p.start === 'string' && /^\d{1,2}:\d{2}$/.test(p.start.trim()) && typeof p.target === 'number';
    const out = [];
    for (const r of Array.isArray(cfgRooms) ? cfgRooms : []) {
      if (!r || !r.id || !r.acName) { this.log.warn(`Hiányos szoba-beállítás kihagyva: ${JSON.stringify(r)}`); continue; }
      const def = DEFAULT_ROOMS.find(d => d.id === r.id) || DEFAULT_ROOMS[0];
      const sch = Array.isArray(r.schedule) ? r.schedule.filter(okPeriod) : [];
      out.push({ ...def, ...r, name: r.name || def.name || r.id, schedule: sch.length ? sch : def.schedule });
    }
    if (!out.length) return DEFAULT_ROOMS.map(r => ({ ...r }));
    return out;
  }

  configureAccessory(acc) { this.cached.set(acc.UUID, acc); }

  // ---------- állapot ----------
  loadState() {
    try { return JSON.parse(fs.readFileSync(this.statePath, 'utf8')); } catch (_) { return { rooms: {} }; }
  }
  saveState(now) {
    const doSave = () => {
      this._saveTimer = null;
      try { fs.writeFileSync(this.statePath, JSON.stringify(this.state, null, 1)); } catch (e) { this.log.error(`Állapot mentési hiba: ${e.message}`); }
    };
    if (now) return doSave();
    if (!this._saveTimer) this._saveTimer = setTimeout(doSave, 5000);
  }
  st(room) {
    if (!this.state.rooms[room.id]) {
      this.state.rooms[room.id] = {
        temp: null, hum: null, batt: null, lastSeen: 0, staleLogged: false,
        offset: 0, bias: typeof room.initialBias === 'number' ? room.initialBias : 0, lastBiasAt: 0,
        manualKey: null, lastCmdAt: 0, lastCmdSp: null, lastPeriodKey: null, lastAcHeat: null, lastStatusLogAt: 0,
        modeWarned: false,
      };
    }
    return this.state.rooms[room.id];
  }

  // ---------- indulás ----------
  start() {
    const C = this.hapTypes.Characteristic;
    const S = this.hapTypes.Service;
    const wanted = new Set();

    for (const room of this.rooms) {
      const st = this.st(room);
      const acc = this.getAccessory(`room:${room.id}`, room.name, wanted);
      const thermo = acc.getService(S.Thermostat) || acc.addService(S.Thermostat, room.name);
      thermo.setPrimaryService(true);
      thermo.getCharacteristic(C.CurrentTemperature).setProps({ minValue: -20, maxValue: 60, minStep: 0.1 })
        .onGet(() => {
          if (!this.isFresh(st)) throw new this.hapTypes.HapStatusError(this.hapTypes.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
          return st.temp;
        });
      thermo.getCharacteristic(C.TargetTemperature).updateValue(this.roomTarget(room).roomTarget).setProps({ minValue: 16, maxValue: 28, minStep: 0.5 })
        .onGet(() => this.roomTarget(room).roomTarget)
        .onSet(v => this.onTileSet(room, Number(v)));
      thermo.getCharacteristic(C.TargetHeatingCoolingState).updateValue(C.TargetHeatingCoolingState.HEAT).setProps({ validValues: [C.TargetHeatingCoolingState.HEAT] })
        .onGet(() => C.TargetHeatingCoolingState.HEAT).onSet(() => { /* csak fűtés */ });
      thermo.getCharacteristic(C.CurrentHeatingCoolingState)
        .onGet(() => (this.acActive(room) === false ? C.CurrentHeatingCoolingState.OFF : C.CurrentHeatingCoolingState.HEAT));
      thermo.getCharacteristic(C.TemperatureDisplayUnits).onGet(() => C.TemperatureDisplayUnits.CELSIUS);
      thermo.getCharacteristic(C.CurrentRelativeHumidity).onGet(() => (st.hum === null ? 0 : st.hum));

      const battery = acc.getService(S.Battery) || acc.addService(S.Battery, `${room.name} akku`);
      battery.getCharacteristic(C.BatteryLevel).onGet(() => (st.batt === null ? 0 : st.batt));
      battery.getCharacteristic(C.ChargingState).onGet(() => C.ChargingState.NOT_CHARGEABLE);
      battery.getCharacteristic(C.StatusLowBattery).onGet(() => this.lowBatt(st));
      this.ui[room.id] = { acc, thermo, battery };

      if (room.buttons) {
        this.makeButton(room, 'warm', 'Melegem van', -1, wanted);
        this.makeButton(room, 'cold', 'Fázok', +1, wanted);
      }
    }

    // Kinti hőmérséklet (a klíma kültéri egységének érzékelője)
    if (this.config.outdoorTile !== false) {
      const oacc = this.getAccessory('outdoor:1', this.config.outdoorName || 'Kinti hőmérséklet', wanted);
      this.outdoorSvc = oacc.getService(S.TemperatureSensor) || oacc.addService(S.TemperatureSensor, this.config.outdoorName || 'Kinti hőmérséklet');
      this.outdoorSvc.getCharacteristic(C.CurrentTemperature).setProps({ minValue: -40, maxValue: 60, minStep: 0.1 })
        .onGet(() => {
          if (typeof this.outdoor !== 'number') throw new this.hapTypes.HapStatusError(this.hapTypes.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
          return this.outdoor;
        });
    }

    // régi, már nem használt kiegészítők törlése
    const stale = [...this.cached.values()].filter(a => !wanted.has(a.UUID));
    if (stale.length) this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);

    this.startWebhook();
    this.log.info(`Indulás – mód: ${this.mode === 'eles' ? 'ÉLES (állítja a klímát)' : 'MEGFIGYELŐ (csak naplóz)'}; napló: ${this.csv.dir}`);
    setTimeout(() => this.discover(), 20000);
    this.tickTimer = setInterval(() => this.tickAll(), 60000);
  }

  getAccessory(key, name, wanted) {
    const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:${key}`);
    wanted.add(uuid);
    let acc = this.cached.get(uuid);
    if (!acc) {
      acc = new this.api.platformAccessory(name, uuid);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [acc]);
      this.cached.set(uuid, acc);
    }
    const C = this.hapTypes.Characteristic;
    acc.getService(this.hapTypes.Service.AccessoryInformation)
      .setCharacteristic(C.Manufacturer, 'Klíma vezérlő')
      .setCharacteristic(C.Model, key.split(':')[0])
      .setCharacteristic(C.SerialNumber, key);
    return acc;
  }

  makeButton(room, key, label, dir, wanted) {
    const C = this.hapTypes.Characteristic;
    const acc = this.getAccessory(`button:${room.id}:${key}`, label, wanted);
    const sw = acc.getService(this.hapTypes.Service.Switch) || acc.addService(this.hapTypes.Service.Switch, label);
    sw.getCharacteristic(C.On).onGet(() => false).onSet(v => {
      if (!v) return;
      this.onButton(room, label, dir);
      setTimeout(() => sw.updateCharacteristic(C.On, false), 800);
    });
  }

  // ---------- segédfüggvények ----------
  isFresh(st) { return st.lastSeen && (Date.now() - st.lastSeen) < this.opts.staleMin * 60000 && typeof st.temp === 'number'; }
  lowBatt(st) {
    const C = this.hapTypes.Characteristic;
    return st.batt !== null && st.batt < this.opts.lowBattery ? C.StatusLowBattery.BATTERY_LEVEL_LOW : C.StatusLowBattery.BATTERY_LEVEL_NORMAL;
  }
  acActive(room) { const a = this.acs[room.id]; return a && a.last ? a.last.active === 1 : null; }
  roomTarget(room, date = new Date()) {
    const st = this.st(room);
    const bt = logic.baseTarget(room.schedule, date, this.outdoor, this.opts);
    const roomTarget = logic.round05(logic.clamp(bt.target + (st.offset || 0), 16, 28));
    return { ...bt, roomTarget };
  }
  row(room, esemeny, extra = {}) {
    const st = this.st(room);
    const a = this.acs[room.id] && this.acs[room.id].last;
    const rt = this.roomTarget(room);
    this.csv.write({
      szoba: room.id, esemeny, mod: this.mode,
      szobaho: this.isFresh(st) ? st.temp : null, para: st.hum, akku: st.batt, kulso: this.outdoor,
      menetrend_cel: rt.target, eltolas: st.offset, szoba_cel: rt.roomTarget, tanult: st.bias,
      klima_akt_cel: a ? a.heat : null, klima_sajat_ho: a ? a.cur : null, vent_akt: a ? a.fan : null,
      klima_be: a ? a.active : null,
      ...extra,
    });
  }

  // ---------- webhook (ESP szenzorok) ----------
  startWebhook() {
    const port = Number(this.config.webhookPort || 51828);
    const fwd = this.config.forwardUrl ? new URL(this.config.forwardUrl) : null;
    this.server = http.createServer((req, res) => {
      let u;
      try { u = new URL(req.url, 'http://x'); } catch (_) { res.writeHead(400); return res.end(); }
      if (fwd) this.forward(fwd, req.url);
      const id = u.searchParams.get('accessoryId');
      const value = Number(u.searchParams.get('value'));
      const m = id && /^(.+)_(hom|para|akku)$/.exec(id);
      const room = m && this.rooms.find(r => r.id === m[1]);
      if (!room || !Number.isFinite(value)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, error: 'ismeretlen accessoryId' }));
      }
      this.onSensor(room, m[2], value);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    });
    this.server.on('error', e => {
      if (e.code === 'EADDRINUSE') this.log.error(`A ${port} port foglalt – a http-webhooks plugint tedd át másik portra (és add meg forwardUrl-ként), vagy kapcsold ki.`);
      else this.log.error(`Webhook szerver hiba: ${e.message}`);
    });
    this.server.listen(port, '0.0.0.0', () => this.log.info(`Szenzor-webhook figyel: ${port}${fwd ? ` (továbbítás: ${fwd.origin})` : ''}`));
  }

  forward(fwd, reqUrl) {
    const r = http.request({ host: fwd.hostname, port: fwd.port || 80, path: reqUrl, method: 'GET', timeout: 3000 }, res => res.resume());
    r.on('error', () => {});
    r.on('timeout', () => r.destroy());
    r.end();
  }

  onSensor(room, kind, value) {
    const st = this.st(room);
    const C = this.hapTypes.Characteristic;
    const ui = this.ui[room.id];
    const wasStale = !this.isFresh(st);
    if (kind === 'hom') { st.temp = value; st.lastSeen = Date.now(); }
    if (kind === 'para') st.hum = Math.round(logic.clamp(value, 0, 100));
    if (kind === 'akku') st.batt = Math.round(logic.clamp(value, 0, 100));
    if (ui) {
      if (kind === 'hom') ui.thermo.updateCharacteristic(C.CurrentTemperature, value);
      if (kind === 'para') ui.thermo.updateCharacteristic(C.CurrentRelativeHumidity, st.hum);
      if (kind === 'akku') {
        ui.battery.updateCharacteristic(C.BatteryLevel, st.batt);
        ui.battery.updateCharacteristic(C.StatusLowBattery, this.lowBatt(st));
      }
    }
    if (kind === 'hom' && wasStale && st.staleLogged) { st.staleLogged = false; this.row(room, 'szenzor_vissza'); }
    this.log.debug(`${room.id} ${kind} = ${value}`);
    this.saveState();
    clearTimeout(this['deb_' + room.id]);
    this['deb_' + room.id] = setTimeout(() => this.tick(room, { reason: 'szenzor' }), 3000);
  }

  // ---------- visszajelzés ----------
  onButton(room, label, dir) {
    const st = this.st(room);
    const before = st.offset || 0;
    st.offset = logic.clamp(before + dir * this.opts.buttonStep, -this.opts.offsetMax, this.opts.offsetMax);
    st.manualKey = null; // a gomb felülírja a korábbi kézi állítást
    this.log.info(`[${room.name}] gomb: ${label} → eltolás ${before} → ${st.offset}`);
    this.row(room, 'gomb', { megjegyzes: label });
    this.saveState();
    this.tick(room, { reason: 'gomb', force: true });
  }

  onTileSet(room, value) {
    const st = this.st(room);
    const rt = this.roomTarget(room);
    const before = st.offset || 0;
    st.offset = logic.clamp(value - rt.target, -this.opts.offsetMax - 1, this.opts.offsetMax + 1);
    st.manualKey = null;
    this.log.info(`[${room.name}] csempe: cél ${rt.roomTarget} → ${value} (eltolás ${before} → ${st.offset})`);
    this.row(room, 'csempe', { megjegyzes: `${rt.roomTarget} -> ${value}` });
    this.saveState();
    this.tick(room, { reason: 'csempe', force: true });
  }

  // ---------- klímák felderítése ----------
  hapTargets() {
    if (this.config.hapPort) return [{ port: Number(this.config.hapPort), pin: this.config.hapPin }];
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(this.api.user.configPath(), 'utf8')); } catch (_) { /* */ }
    const main = cfg.bridge || {};
    const pin = this.config.hapPin || main.pin;
    const list = [];
    for (const p of [...(cfg.platforms || []), ...(cfg.accessories || [])]) {
      if (p && p._bridge && p._bridge.port) list.push({ port: Number(p._bridge.port), pin: p._bridge.pin || pin });
    }
    if (main.port) list.push({ port: Number(main.port), pin });
    return list;
  }

  async discover() {
    const targets = this.hapTargets();
    let missing = 0;
    for (const room of this.rooms) {
      if (this.acs[room.id]) continue;
      try {
        const ac = await hap.discoverAc(targets, room.acName, this.log);
        if (ac) {
          this.acs[room.id] = ac;
          this.log.info(`[${room.name}] klíma megtalálva: „${room.acName}” (port ${ac.port}, aid ${ac.aid}, outdoor: ${ac.refs.outdoor ? 'igen' : 'nem'}, sleep: ${ac.refs.sleep ? 'igen' : 'nem'})`);
        } else missing++;
      } catch (e) { missing++; }
    }
    if (missing) {
      this.log.warn(`${missing} klíma nem található a HAP felületen (insecure mode be van kapcsolva? jó az acName?). Újrapróbálás 5 perc múlva.`);
      setTimeout(() => this.discover(), 5 * 60000);
    }
    this.tickAll();
  }

  // ---------- szabályozási ciklus ----------
  tickAll() { for (const r of this.rooms) this.tick(r, { reason: 'ciklus' }); }

  // Szobánként sorba fűzött futás: ha épp fut egy ciklus, a kérés utána fut le (nem vész el).
  tick(room, { reason, force } = {}) {
    const k = 'q_' + room.id;
    const prev = this[k] || Promise.resolve();
    const next = prev.then(() => this._tick(room, reason, force))
      .catch(e => this.throttledError(room.id, `ciklus hiba: ${e.message}`));
    this[k] = next;
    return next;
  }

  throttledError(key, msg) {
    const now = Date.now();
    if (!this.lastErr[key] || now - this.lastErr[key] > 30 * 60000) { this.lastErr[key] = now; this.log.warn(msg); }
  }

  async _tick(room, reason, force) {
    const st = this.st(room);
    const C = this.hapTypes.Characteristic;
    const now = Date.now();
    const ac = this.acs[room.id];

    // 1) klíma állapot
    let a = null;
    if (ac) {
      try {
        a = await hap.readAc(ac);
        ac.last = a;
        // Kinti hő: egy rögzített klímáról (alapból az első szoba, pl. Nappali); ha az nem ad értéket, bármelyikről.
        const src = this.config.outdoorSource || this.rooms[0].id;
        const srcAc = this.acs[src];
        const srcOk = srcAc && srcAc.last && typeof srcAc.last.outdoor === 'number';
        if (typeof a.outdoor === 'number' && (room.id === src || !srcOk)) {
          this.outdoor = a.outdoor;
          if (this.outdoorSvc) this.outdoorSvc.updateCharacteristic(this.hapTypes.Characteristic.CurrentTemperature, a.outdoor);
        }
      } catch (e) { this.throttledError('read_' + room.id, `[${room.name}] klíma olvasási hiba: ${e.message}`); }
    }

    // 2) menetrend
    const rt0 = this.roomTarget(room);
    let periodChanged = false;
    if (rt0.key !== st.lastPeriodKey) {
      const first = st.lastPeriodKey === null;
      st.lastPeriodKey = rt0.key;
      st.offset = 0;
      st.manualKey = null;
      periodChanged = !first;
      force = true;
      this.row(room, first ? 'indulas' : 'menetrend', { megjegyzes: `${rt0.period.start} cél ${rt0.target}${rt0.frost ? ' (fagyvédelem)' : ''}` });
      if (this.mode === 'eles' && ac && ac.refs.sleep && a) {
        const wantSleep = !!rt0.period.night;
        if (a.sleep !== wantSleep) {
          try { await hap.writeAc(ac, { sleep: wantSleep }); this.row(room, 'parancs', { megjegyzes: `Sleep ${wantSleep ? 'be' : 'ki'}` }); } catch (e) { this.log.warn(e.message); }
        }
      }
    }
    const rt = this.roomTarget(room);
    const fresh = this.isFresh(st);

    // 3) szenzor kiesés
    if (!fresh && st.lastSeen && !st.staleLogged) {
      st.staleLogged = true;
      this.log.warn(`[${room.name}] a szenzor ${this.opts.staleMin} perce nem küldött adatot`);
      this.row(room, 'szenzor_kiesett');
      const ui = this.ui[room.id];
      if (ui) ui.thermo.updateCharacteristic(C.CurrentTemperature, new this.hapTypes.HapStatusError(this.hapTypes.HAPStatus.SERVICE_COMMUNICATION_FAILURE));
    }

    // 4) klíma-változás / kézi állítás felismerése
    if (a && typeof a.heat === 'number') {
      if (st.lastAcHeat !== null && a.heat !== st.lastAcHeat) {
        const own = this.mode === 'eles' && st.lastCmdSp === a.heat && now - st.lastCmdAt < 5 * 60000;
        if (!own) {
          if (this.mode === 'eles') {
            st.manualKey = rt.key;
            this.log.info(`[${room.name}] kézi állítás: ${st.lastAcHeat} → ${a.heat}; a következő menetrend-váltásig nem írom felül`);
            this.row(room, 'kezi', { megjegyzes: `${st.lastAcHeat} -> ${a.heat}` });
          } else {
            this.row(room, 'klima_valtozas', { megjegyzes: `${st.lastAcHeat} -> ${a.heat}` });
          }
        }
      }
      st.lastAcHeat = a.heat;
    }
    const manual = st.manualKey === rt.key;

    // 5) döntés
    const night = !!rt.period.night;
    const d = logic.decide({ roomTarget: rt.roomTarget, roomTemp: fresh ? st.temp : null, bias: st.bias, night, opts: this.opts });

    // 6) tanult eltolás (csak éles módban, ha a klíma tényleg a mi beállításunkon fut)
    if (this.mode === 'eles' && fresh && a && a.active === 1 && !manual && now - st.lastBiasAt >= this.opts.biasIntervalMin * 60000) {
      if (st.lastBiasAt) st.bias = logic.updateBias(st.bias, d.error, this.opts);
      st.lastBiasAt = now;
    }

    // 7) parancs (éles mód)
    if (this.mode === 'eles' && a && !manual) {
      const heatMode = a.mode === null || a.mode === 1; // 1 = HEAT
      if (a.active !== 1) {
        // ki van kapcsolva – nem kapcsoljuk be
      } else if (!heatMode) {
        if (!st.modeWarned) { st.modeWarned = true; this.row(room, 'nem_futes', { megjegyzes: `mode=${a.mode}` }); }
      } else {
        st.modeWarned = false;
        const needSp = typeof a.heat !== 'number' || Math.abs(d.setpoint - a.heat) >= 0.5;
        const needFan = typeof a.fan === 'number' && Math.abs(d.fan - a.fan) >= 10;
        const allowed = force || now - st.lastCmdAt >= this.opts.minCommandIntervalMin * 60000;
        if ((needSp || needFan) && allowed) {
          const vals = {};
          if (needSp) vals.heat = d.setpoint;
          if (needFan) vals.fan = d.fan;
          try {
            await hap.writeAc(ac, vals);
            st.lastCmdAt = now;
            if (needSp) st.lastCmdSp = d.setpoint;
            this.log.info(`[${room.name}] klíma → ${needSp ? d.setpoint + ' °C ' : ''}${needFan ? 'vent ' + d.fan + '%' : ''} (szoba ${fresh ? st.temp : '?'} / cél ${rt.roomTarget})`);
            this.row(room, 'parancs', { klima_javasolt_cel: d.setpoint, vent_javasolt: d.fan, megjegyzes: reason });
          } catch (e) { this.throttledError('write_' + room.id, `[${room.name}] klíma írási hiba: ${e.message}`); }
        }
      }
    }

    // 8) HomeKit csempe frissítése
    const ui = this.ui[room.id];
    if (ui) {
      ui.thermo.updateCharacteristic(C.TargetTemperature, rt.roomTarget);
      ui.thermo.updateCharacteristic(C.CurrentHeatingCoolingState,
        a && a.active === 0 ? C.CurrentHeatingCoolingState.OFF : C.CurrentHeatingCoolingState.HEAT);
    }

    // 9) állapotsor 5 percenként (és szakaszváltáskor)
    if (periodChanged || now - st.lastStatusLogAt >= 5 * 60000 - 5000) {
      st.lastStatusLogAt = now;
      this.row(room, 'allapot', { klima_javasolt_cel: d.setpoint, vent_javasolt: d.fan, megjegyzes: manual ? 'kezi_aktiv' : (rt.frost ? 'fagyvedelem' : '') });
    }
    this.saveState();
  }
}
