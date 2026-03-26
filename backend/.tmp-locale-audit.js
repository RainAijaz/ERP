const fs = require('fs');
const path = require('path');

const localePath = path.join('src', 'middleware', 'core', 'locale.js');
const text = fs.readFileSync(localePath, 'utf8');
const m = text.match(/en:\s*\{([\s\S]*?)\n\s*\},\s*\n\s*ur:/);
if (!m) {
  console.error('en block not found');
  process.exit(1);
}
const block = m[1];
const keyRe = /^\s*([a-zA-Z0-9_]+)\s*:/gm;
const en = new Set();
let km;
while ((km = keyRe.exec(block))) en.add(km[1]);

function walk(dir, arr = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (['node_modules', 'test-results', 'current'].includes(e.name)) continue;
      walk(p, arr);
    } else if (/\.(js|ejs|ts|tsx)$/.test(e.name)) {
      arr.push(p);
    }
  }
  return arr;
}

const files = walk('src');
const used = new Set();
const patterns = [
  /\bt\(\s*['\"]([^'\"\n]+)['\"]\s*\)/g,
  /res\.locals\.t\(\s*['\"]([^'\"\n]+)['\"]\s*\)/g,
  /i18n\.__\(\s*['\"]([^'\"\n]+)['\"]\s*\)/g,
];

for (const f of files) {
  const c = fs.readFileSync(f, 'utf8');
  for (const re of patterns) {
    let mm;
    while ((mm = re.exec(c))) used.add(mm[1]);
  }
}

const missing = [...used].filter((k) => !en.has(k)).sort();
const suspicious = [...en].filter((k) => k.includes('loss') || k.includes('draft')).sort();

console.log('USED_KEYS', used.size);
console.log('EN_KEYS', en.size);
console.log('MISSING_KEYS', missing.length);
for (const k of missing) console.log(k);
console.log('---SUSPICIOUS---');
for (const k of suspicious) console.log(k);
