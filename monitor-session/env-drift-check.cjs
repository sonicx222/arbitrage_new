const {execSync} = require('child_process');
const fs = require('fs');

const codeOut = execSync('grep -roh "process\\.env\\.[A-Z_]*[A-Z]" services/ shared/ --include="*.ts" --exclude-dir=node_modules --exclude-dir=__tests__', {encoding:'utf8',maxBuffer:10*1024*1024});
const codeVars = [...new Set(codeOut.split('\n').filter(Boolean).map(s=>s.replace('process.env.','')))].sort();

// Count both uncommented (VAR=) and commented-out (# VAR=) entries as documented.
// Commented entries are intentional: secrets must not have live defaults in the template.
const envDoc = fs.readFileSync('.env.example','utf8').split('\n').filter(l=>/^#?\s*[A-Z_]+=/.test(l)).map(l=>l.replace(/^#\s*/,'').split('=')[0]);
const docSet = new Set(envDoc);

const standard = new Set('NODE_ENV,PORT,CI,JEST_WORKER_ID,HOME,PATH,HOSTNAME,FLY_APP_NAME,FLY_REGION,FLY_ALLOC_ID,RENDER_SERVICE_NAME,RAILWAY_SERVICE_NAME,KOYEB_SERVICE_NAME,GITHUB_ACTIONS'.split(','));

let crit=0, high=0, med=0, orphan=0;
const undocList = [];
for (const v of codeVars) {
  if (docSet.has(v) || standard.has(v) || v.startsWith('npm_')) continue;
  if (/KEY|SECRET|TOKEN|PASSWORD|MNEMONIC|PRIVATE/.test(v)) { crit++; undocList.push('CRIT:'+v); }
  else if (/TIMEOUT|THRESHOLD|MAX_|MIN_|LIMIT|SIZE|ENABLED/.test(v)) { high++; undocList.push('HIGH:'+v); }
  else { med++; undocList.push('MED:'+v); }
}

const codeSet = new Set(codeVars);
for (const v of envDoc) {
  if (!codeSet.has(v)) orphan++;
}

console.log('Code vars: ' + codeVars.length + ', Doc vars: ' + envDoc.length);
console.log('Undocumented: CRITICAL=' + crit + ' HIGH=' + high + ' MEDIUM=' + med + ' Orphaned=' + orphan);
if (crit > 0) console.log('Critical undoc:', undocList.filter(s=>s.startsWith('CRIT')).join(', '));
if (high > 0) console.log('High undoc:', undocList.filter(s=>s.startsWith('HIGH')).join(', '));
