'use strict';
// Minimális Homebridge API utánzat a tesztekhez.
const EventEmitter = require('events');
const crypto = require('crypto');
const path = require('path');

module.exports = (storage) => {
  class HapStatusError extends Error { constructor(s) { super('HAP ' + s); this.hapStatus = s; } }
  const C = {};
  for (const n of ['CurrentTemperature', 'TargetTemperature', 'CurrentRelativeHumidity', 'BatteryLevel', 'On', 'Manufacturer', 'Model', 'SerialNumber']) C[n] = { key: n };
  C.TargetHeatingCoolingState = { key: 'TargetHeatingCoolingState', OFF: 0, HEAT: 1, COOL: 2, AUTO: 3 };
  C.CurrentHeatingCoolingState = { key: 'CurrentHeatingCoolingState', OFF: 0, HEAT: 1, COOL: 2 };
  C.TemperatureDisplayUnits = { key: 'TemperatureDisplayUnits', CELSIUS: 0 };
  C.ChargingState = { key: 'ChargingState', NOT_CHARGEABLE: 2 };
  C.StatusLowBattery = { key: 'StatusLowBattery', BATTERY_LEVEL_NORMAL: 0, BATTERY_LEVEL_LOW: 1 };

  class Char {
    constructor() { this.value = null; }
    setProps(p) { this.props = p; return this; }
    onGet(f) { this.g = f; return this; }
    onSet(f) { this.s = f; return this; }
    updateValue(v) { this.value = v; return this; }
    async get() { return this.g ? this.g() : this.value; }
    async set(v) { this.value = v; if (this.s) await this.s(v); }
  }
  class Svc {
    constructor(type, name) { this.type = type; this.name = name; this.chars = {}; this.isSwitch = type === 'Switch'; }
    getCharacteristic(c) { return (this.chars[c.key] = this.chars[c.key] || new Char()); }
    setCharacteristic(c, v) { this.getCharacteristic(c).updateValue(v); return this; }
    updateCharacteristic(c, v) { this.getCharacteristic(c).updateValue(v); return this; }
    setPrimaryService() {}
  }
  const S = {};
  for (const n of ['Thermostat', 'Battery', 'Switch', 'AccessoryInformation']) S[n] = n;

  class PlatformAccessory {
    constructor(name, uuid) { this.displayName = name; this.UUID = uuid; this.services = [new Svc('AccessoryInformation')]; }
    getService(t) { return this.services.find(s => s.type === t); }
    addService(t, name) { const s = new Svc(t, name); this.services.push(s); return s; }
  }

  const api = new EventEmitter();
  api.registered = [];
  api.registerPlatform = (_p, _n, cls) => { api.Platform = cls; };
  api.registerPlatformAccessories = (_p, _n, accs) => api.registered.push(...accs);
  api.unregisterPlatformAccessories = () => {};
  api.platformAccessory = PlatformAccessory;
  api.user = { storagePath: () => storage, configPath: () => path.join(storage, 'config.json') };
  api.hap = {
    Service: S, Characteristic: C, HapStatusError,
    HAPStatus: { SERVICE_COMMUNICATION_FAILURE: -70402 },
    uuid: { generate: s => crypto.createHash('md5').update(s).digest('hex') },
  };
  return api;
};
