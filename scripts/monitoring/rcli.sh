#!/bin/bash
# Minimal redis-cli replacement using node
node -e "
const net = require('net');
const args = process.argv.slice(1);
const cmd = args.join(' ') + '\r\n';
const c = net.createConnection(6379, '127.0.0.1');
let buf = '';
c.on('connect', () => c.write(cmd));
c.on('data', d => { buf += d.toString(); if (buf.includes('\r\n') && !buf.endsWith('\r\n\r\n')) { /* wait */ } });
c.on('end', () => { console.log(buf.trim()); });
setTimeout(() => { console.log(buf.trim()); c.end(); }, 2000);
c.on('error', e => { console.log('ERR: ' + e.message); process.exit(1); });
" "$@"
