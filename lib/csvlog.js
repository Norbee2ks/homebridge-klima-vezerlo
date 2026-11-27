'use strict';
const fs = require('fs');
const path = require('path');

const COLUMNS = [
  'ido', 'szoba', 'esemeny', 'mod',
  'szobaho', 'para', 'akku', 'kulso',
  'menetrend_cel', 'eltolas', 'szoba_cel', 'tanult',
  'klima_akt_cel', 'klima_javasolt_cel', 'klima_sajat_ho', 'vent_akt', 'vent_javasolt', 'klima_be',
  'megjegyzes', 'lap_poz', 'lap_szog', 'lap_oldal',
];

function pad(n) { return String(n).padStart(2, '0'); }
function localStamp(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function cell(v) {
  if (v === null || v === undefined) return '';
  // Magyar Excelhez: pontosvessző elválasztó, tizedesvessző
  const s = typeof v === 'number' ? String(Math.round(v * 100) / 100).replace('.', ',') : String(v);
  return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

class CsvLog {
  constructor(dir, log) {
    this.dir = dir;
    this.log = log;
    fs.mkdirSync(dir, { recursive: true });
  }
  write(row) {
    const d = new Date();
    const header = COLUMNS.join(';');
    let file = path.join(this.dir, `klima-${d.getFullYear()}-${pad(d.getMonth() + 1)}.csv`);
    try {
      // ha egy korábbi verzió más oszlopokkal kezdte a havi fájlt, új fájlba írunk
      for (let i = 2; fs.existsSync(file) && fs.readFileSync(file, 'utf8').split('\n')[0].replace('\uFEFF', '') !== header; i++) {
        file = path.join(this.dir, `klima-${d.getFullYear()}-${pad(d.getMonth() + 1)}_${i}.csv`);
      }
      if (!fs.existsSync(file)) fs.writeFileSync(file, '﻿' + COLUMNS.join(';') + '\n');
      const line = COLUMNS.map(c => (c === 'ido' ? localStamp(d) : cell(row[c]))).join(';') + '\n';
      fs.appendFileSync(file, line);
    } catch (e) {
      this.log.error(`Napló írási hiba: ${e.message}`);
    }
  }

  // A napló fájljai (legújabb elöl) – a letöltő oldalhoz
  list() {
    try { return fs.readdirSync(this.dir).filter(f => f.endsWith('.csv')).sort().reverse(); } catch (_) { return []; }
  }
}

module.exports = { CsvLog, COLUMNS };
