const http = require('http');

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, { timeout: 3000 }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch(e) { reject(e); }
      });
    }).on('error', reject).on('timeout', () => reject(new Error('timeout')));
  });
}

async function main() {
  const ports = [
    { name: 'P1', port: 3001 },
    { name: 'P2', port: 3002 },
    { name: 'P3', port: 3003 },
    { name: 'P4', port: 3004 },
  ];
  for (const { name, port } of ports) {
    try {
      const data = await getJson(`http://localhost:${port}/health`);
      console.log(`${name} eventsProcessed: ${data.eventsProcessed}`);
    } catch(e) {
      console.log(`${name} error: ${e.message}`);
    }
  }
}
main();
