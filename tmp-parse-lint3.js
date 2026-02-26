const fs = require('fs');
const lines = fs.readFileSync('C:/Users/kj2bn8f/AppData/Local/Temp/lint-out3.txt', 'utf8').split('\n');
let file = '';
const results = {};
for (const line of lines) {
  if (line.startsWith('C:')) {
    file = line.trim().replace(/C:\\Users\\kj2bn8f\\arbitrage_new\\/g, '').replace(/\\/g, '/');
  } else if (line.includes('no-explicit-any')) {
    const m = line.trim().match(/^(\d+):\d+/);
    if (m) {
      if (!results[file]) results[file] = [];
      results[file].push(parseInt(m[1]));
    }
  }
}
for (const [f, lns] of Object.entries(results).sort()) {
  console.log(f + ': lines ' + lns.join(', '));
}
console.log('---');
console.log('Total files: ' + Object.keys(results).length);
console.log('Total errors: ' + Object.values(results).reduce((a, b) => a + b.length, 0));
