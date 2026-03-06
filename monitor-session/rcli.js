const net = require('net');
const args = process.argv.slice(2);

function encodeRESP(args) {
  let resp = `*${args.length}\r\n`;
  for (const a of args) {
    resp += `$${Buffer.byteLength(a)}\r\n${a}\r\n`;
  }
  return resp;
}

function parseRESP(buf) {
  const lines = buf.split('\r\n');
  const results = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line) { i++; continue; }
    if (line[0] === '+') { results.push(line.slice(1)); i++; }
    else if (line[0] === '-') { results.push('ERR: ' + line.slice(1)); i++; }
    else if (line[0] === ':') { results.push(line.slice(1)); i++; }
    else if (line[0] === '$') {
      const len = parseInt(line.slice(1));
      if (len === -1) { results.push('(nil)'); i++; }
      else { results.push(lines[i + 1] || ''); i += 2; }
    }
    else if (line[0] === '*') {
      const count = parseInt(line.slice(1));
      if (count === -1 || count === 0) { results.push(count === -1 ? '(empty array)' : '(empty array)'); i++; }
      else { i++; continue; }
    }
    else { results.push(line); i++; }
  }
  return results.join('\n');
}

const c = net.createConnection(6379, '127.0.0.1');
let buf = '';
c.on('connect', () => c.write(encodeRESP(args)));
c.on('data', d => buf += d.toString());
c.setTimeout(3000, () => { process.stdout.write(buf); c.end(); });
c.on('end', () => process.stdout.write(parseRESP(buf) + '\n'));
c.on('error', e => { console.error('ERR:', e.message); process.exit(1); });
