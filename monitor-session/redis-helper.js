const net = require('net');
const commands = process.argv.slice(2);
if (commands.length === 0) { process.exit(1); }
const c = net.createConnection({ host: '127.0.0.1', port: 6379 });
let buf = '';
c.on('connect', () => {
  for (const cmd of commands) c.write(cmd + '\r\n');
  c.write('QUIT\r\n');
});
c.on('data', d => buf += d.toString());
c.on('end', () => {
  const lines = buf.split('\r\n');
  for (const line of lines) {
    if (line === '' || line === '+OK') continue;
    if (line.startsWith('$-1')) { console.log('(nil)'); continue; }
    if (line.startsWith('$')) continue;
    if (line.startsWith('*')) continue;
    if (line.startsWith('+')) { console.log(line.substring(1)); continue; }
    if (line.startsWith('-')) { console.log('ERROR:', line.substring(1)); continue; }
    if (line.startsWith(':')) { console.log(line.substring(1)); continue; }
    console.log(line);
  }
});
c.on('error', e => { console.error('Connection error:', e.message); process.exit(1); });
setTimeout(() => { c.destroy(); }, 10000);
