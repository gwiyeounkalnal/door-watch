const express = require('express');
const fs = require('fs');
const path = require('path');
const https = require('https');
const os = require('os');
const selfsigned = require('selfsigned');

const app = express();

// ---- 실행 옵션: --public(HTTP로 실행, 터널 뒤에서 사용) --password=비번 ----
const args = process.argv.slice(2);
const arg = k => { const a = args.find(x => x === '--' + k || x.startsWith('--' + k + '=')); return a ? (a.includes('=') ? a.split('=').slice(1).join('=') : '1') : null; };
const PUBLIC = !!arg('public') || process.env.HTTP_ONLY === '1';
const PASSWORD = arg('password') || process.env.PASSWORD;

// 비밀번호 보호 (아이디는 아무거나, 비밀번호만 맞으면 통과)
if (PASSWORD) app.use((req, res, next) => {
  const [type, b64] = (req.headers.authorization || '').split(' ');
  if (type === 'Basic' && b64) {
    const pw = Buffer.from(b64, 'base64').toString('utf8').split(':').slice(1).join(':');
    if (pw === PASSWORD) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="app"').status(401).send('Password required');
});
const DIR = path.join(__dirname, 'records');          // 기록 폴더
const SNAP = path.join(DIR, 'snapshots');             // 스냅샷 폴더
fs.mkdirSync(SNAP, { recursive: true });

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/snapshots', express.static(SNAP));

// 횟수 파일: records/당김.txt, records/밀기.txt (숫자만 저장)
const COUNT_FILE = { pull: path.join(DIR, '당김.txt'), push: path.join(DIR, '밀기.txt') };
const readCount = d => parseInt(fs.existsSync(COUNT_FILE[d]) ? fs.readFileSync(COUNT_FILE[d], 'utf8') : '0', 10) || 0;
const writeCount = (d, n) => fs.writeFileSync(COUNT_FILE[d], String(Math.max(0, n)));
['pull', 'push'].forEach(d => writeCount(d, readCount(d)));   // 없으면 0으로 생성

const logFile = () => path.join(DIR, new Date().toISOString().slice(0, 10) + '.jsonl');

// 기록 저장: records/YYYY-MM-DD.jsonl 에 한 줄씩 추가
app.post('/api/records', (req, res) => {
  const { direction, confidence, snapshot, corrected } = req.body;
  if (!['push', 'pull'].includes(direction)) return res.status(400).json({ error: 'bad direction' });
  const time = new Date().toISOString();
  let image = null;
  if (typeof snapshot === 'string' && snapshot.startsWith('data:image/jpeg;base64,')) {
    image = time.replace(/[:.]/g, '-') + '_' + direction + '.jpg';
    fs.writeFileSync(path.join(SNAP, image), Buffer.from(snapshot.split(',')[1], 'base64'));
  }
  const rec = { time, direction, confidence, corrected: !!corrected, image };
  fs.appendFileSync(logFile(), JSON.stringify(rec) + '\n');
  const other = direction === 'pull' ? 'push' : 'pull';
  if (corrected) writeCount(other, readCount(other) - 1);   // 정정: 잘못 센 쪽을 1 빼기
  writeCount(direction, readCount(direction) + 1);
  res.json({ ...rec, counts: { pull: readCount('pull'), push: readCount('push') } });
});

// 오탐 취소(사람이 지나간 것을 문으로 잘못 센 경우): 횟수 -1 + 로그에 취소 기록
app.post('/api/records/undo', (req, res) => {
  const { direction } = req.body;
  if (!['push', 'pull'].includes(direction)) return res.status(400).json({ error: 'bad direction' });
  writeCount(direction, readCount(direction) - 1);
  const rec = { time: new Date().toISOString(), direction, falsePositive: true };
  fs.appendFileSync(logFile(), JSON.stringify(rec) + '\n');
  res.json({ pull: readCount('pull'), push: readCount('push') });
});

app.post('/api/counts/reset', (req, res) => {
  ['pull', 'push'].forEach(d => writeCount(d, 0));
  res.json({ pull: 0, push: 0 });
});

app.get('/api/counts', (req, res) => res.json({ pull: readCount('pull'), push: readCount('push') }));

// 최근 기록 100개
app.get('/api/records', (req, res) => {
  const files = fs.readdirSync(DIR).filter(f => f.endsWith('.jsonl')).sort().reverse();
  let out = [];
  for (const f of files) {
    const lines = fs.readFileSync(path.join(DIR, f), 'utf8').split('\n').filter(Boolean);
    out = out.concat(lines.map(l => JSON.parse(l)).reverse());
    if (out.length >= 100) break;
  }
  res.json(out.slice(0, 100));
});

// ---- 서버 시작 ----
const PORT = process.env.PORT || 3000;
const ips = Object.values(os.networkInterfaces()).flat()
  .filter(i => i.family === 'IPv4' && !i.internal).map(i => i.address);

if (PUBLIC) {
  // 터널(Cloudflare 등)이 https를 처리하므로 서버는 http로 실행
  require('http').createServer(app).listen(PORT, '0.0.0.0', () => {
    console.log(`http://localhost:${PORT}  (터널용 모드)`);
    console.log(PASSWORD ? '비밀번호 보호: 켜짐' : '⚠ 비밀번호가 없습니다. --password=비번 을 붙이세요.');
  });
} else {
  const CERT_DIR = path.join(__dirname, 'certs');
  const KEY = path.join(CERT_DIR, 'key.pem'), CRT = path.join(CERT_DIR, 'cert.pem'), IPS = path.join(CERT_DIR, 'ips.txt');
  fs.mkdirSync(CERT_DIR, { recursive: true });
  // IP가 바뀌었거나 인증서가 없으면 새로 생성
  if (!fs.existsSync(KEY) || !fs.existsSync(CRT) || !fs.existsSync(IPS) || fs.readFileSync(IPS, 'utf8') !== ips.join(',')) {
    const altNames = [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }, ...ips.map(ip => ({ type: 7, ip }))];
    const pems = selfsigned.generate([{ name: 'commonName', value: 'door-watch' }], {
      days: 825, keySize: 2048, algorithm: 'sha256',
      extensions: [{ name: 'subjectAltName', altNames }]
    });
    fs.writeFileSync(KEY, pems.private); fs.writeFileSync(CRT, pems.cert); fs.writeFileSync(IPS, ips.join(','));
  }
  https.createServer({ key: fs.readFileSync(KEY), cert: fs.readFileSync(CRT) }, app)
    .listen(PORT, '0.0.0.0', () => {
      console.log(`https://localhost:${PORT}`);
      ips.forEach(ip => console.log(`https://${ip}:${PORT}`));
      console.log('※ 처음 접속 시 "안전하지 않음" 경고가 뜨면 [고급] → [계속 진행]을 누르세요.');
    });
}
