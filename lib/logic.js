'use strict';
// Tiszta (mellékhatás nélküli) szabályozó logika – unit-tesztelhető.

function parseHHMM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s).trim());
  if (!m) throw new Error(`Hibás időpont: ${s}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

// schedule: [{start:"06:30", target:23, night?:bool}, ...] (bármilyen sorrendben)
// Visszaadja az aktuális szakaszt + egy kulcsot (dátum + kezdés), ami szakaszváltáskor változik.
function currentPeriod(schedule, date) {
  const list = schedule
    .map((p, i) => ({ ...p, idx: i, min: parseHHMM(p.start) }))
    .sort((a, b) => a.min - b.min);
  const nowMin = date.getHours() * 60 + date.getMinutes();
  let cur = null;
  for (const p of list) if (p.min <= nowMin) cur = p;
  let dayOffset = 0;
  if (!cur) { cur = list[list.length - 1]; dayOffset = -1; } // éjfél után: előző napi utolsó szakasz
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate() + dayOffset);
  const key = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}@${cur.start}`;
  return { period: cur, key, list };
}

// Az éjszakai szakaszt megelőző nappali cél (fagyvédelemhez).
function previousDayTarget(list, period) {
  const i = list.findIndex(p => p.idx === period.idx);
  for (let k = 1; k <= list.length; k++) {
    const p = list[(i - k + list.length) % list.length];
    if (!p.night) return p.target;
  }
  return period.target;
}

const round05 = v => Math.round(v * 2) / 2;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Alapcél a menetrend + fagyvédelem alapján.
function baseTarget(schedule, date, outdoorTemp, opts) {
  const { period, key, list } = currentPeriod(schedule, date);
  let target = period.target;
  let frost = false;
  if (period.night && typeof outdoorTemp === 'number' && outdoorTemp < opts.frostLimit) {
    const dayT = previousDayTarget(list, period);
    const t = dayT - opts.frostNightDrop;
    if (t > target) { target = t; frost = true; }
  }
  return { target, frost, period, key };
}

/**
 * Döntés egy szobára.
 * in: { roomTarget, roomTemp (null ha nincs friss), bias, night, opts }
 * out: { setpoint, fan, error }
 */
function decide(inp) {
  const o = inp.opts;
  let error = null;
  let sp;
  if (typeof inp.roomTemp === 'number') {
    error = inp.roomTarget - inp.roomTemp;
    sp = inp.roomTarget + inp.bias + o.kp * error;
  } else {
    sp = inp.roomTarget + inp.bias; // szenzor nélkül: csak tanult eltolás
  }
  sp = clamp(sp, o.minSetpoint, Math.min(o.maxSetpoint, inp.roomTarget + o.maxAboveTarget));
  sp = round05(sp);

  let fan;
  if (error === null) fan = o.fanNear;
  else if (error > o.fanHighError) fan = o.fanHigh;
  else if (error > o.fanMidError) fan = o.fanMid;
  else fan = o.fanNear;
  if (inp.night) fan = Math.min(fan, o.fanNightMax);
  return { setpoint: sp, fan, error };
}

// Tanult eltolás frissítése (hívd ~30 percenként).
function updateBias(bias, error, opts) {
  if (error === null || Math.abs(error) <= opts.biasDeadband) return bias;
  const nb = bias + Math.sign(error) * opts.biasStep;
  return Math.round(clamp(nb, opts.biasMin, opts.biasMax) * 100) / 100;
}

const DEFAULTS = {
  kp: 1.0,
  minSetpoint: 17,
  maxSetpoint: 30,
  maxAboveTarget: 3,
  fanHigh: 60, fanMid: 40, fanNear: 40, fanNightMax: 40,
  fanHighError: 1.0, fanMidError: 0.3,
  biasStep: 0.1, biasDeadband: 0.3, biasMin: -2, biasMax: 3,
  biasIntervalMin: 30,
  frostLimit: -5, frostNightDrop: 0.5,
  minCommandIntervalMin: 15,
  buttonStep: 0.5, offsetMax: 2,
  staleMin: 40,
  lowBattery: 15,
};

module.exports = { parseHHMM, currentPeriod, baseTarget, decide, updateBias, round05, clamp, DEFAULTS };
