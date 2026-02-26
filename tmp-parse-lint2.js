const fs = require('fs');
const lines = fs.readFileSync('C:/Users/kj2bn8f/AppData/Local/Temp/lint-out2.txt', 'utf8').split('\n');
let file = '';
for (const line of lines) {
  if (line.startsWith('C:')) {
    file = line.trim().replace('C:\\Users\\kj2bn8f\\arbitrage_new\\', '');
  } else if (line.includes('error') && line.indexOf('Unexpected any') !== -1) {
    const match = line.trim().match(/^(\d+):\d+/);
    if (match) console.log(file + ':' + match[1]);
  }
}
