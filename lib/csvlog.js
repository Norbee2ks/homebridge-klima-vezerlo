'use strict';
const fs = require('fs');
const path = require('path');

const COLUMNS = [
  'ido', 'szoba', 'esemeny', 'mod',
  'szobaho', 'para', 'akku', 'kulso',
  'menetrend_cel', 'eltolas', 'szoba_cel', 'tanult',
  'klima_akt_cel', 'klima_javasolt_cel', 'klima_sajat_ho', 'vent_akt', 'vent_javasolt', 'klima_be',
  'megjegyzes',
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
    const file = path.join(this.dir, `klima-${d.getFullYear()}-${pad(d.getMonth() + 1)}.csv`);
    try {
      if (!fs.existsSync(file)) fs.writeFileSync(file, '﻿' + COLUMNS.join(';') + '\n');
      const line = COLUMNS.map(c => (c === 'ido' ? localStamp(d) : cell(row[c]))).join(';') + '\n';
      fs.appendFileSync(file, line);
    } catch (e) {
      this.log.error(`Napló írási hiba: ${e.message}`);
    }
  }
}

module.exports = { CsvLog, COLUMNS };
