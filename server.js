'use strict';

const express = require('express');
const { WebSocketServer } = require('ws');
const net = require('net');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

// ─── CLI / ENV Config ──────────────────────────────────────────────────────────
// Usage: node server.js [options]
//   --mode        <m>        Operating mode: aprs | adsb | both  (default: aprs)
//   --port        <n>        Web server port                     (default: 3000)
// APRS options (active in mode: aprs, both):
//   --freq        <f>        RTL-FM frequency         (default: 144.390M)
//   --sample-rate <n>        Audio sample rate Hz     (default: 22050)
//   --gain        <n>        RTL-SDR gain, dB or "auto" (default: auto)
//   --ppm         <n>        RTL-SDR PPM correction   (default: 0)
//   --device      <n>        RTL-SDR device index     (default: 0)
//   --kiss-host   <h>        Direwolf KISS host       (default: 127.0.0.1)
//   --kiss-port   <n>        Direwolf KISS TCP port   (default: 8001)
// ADS-B options (active in mode: adsb, both):
//   --adsb-bin    <path>     dump1090 binary           (default: dump1090)
//   --adsb-device <n>        RTL-SDR device for ADS-B  (default: 1 in both, 0 otherwise)
//   --sbs-port    <n>        dump1090 SBS output port  (default: 30003)
// All options can also be set via environment variables (upper-snake-case):
//   MODE, PORT, FREQ, SAMPLE_RATE, GAIN, PPM, DEVICE, KISS_HOST, KISS_PORT
//   ADSB_BIN, ADSB_DEVICE, SBS_PORT

function parseArgs() {
  const args = process.argv.slice(2);
  const cfg = {};
  for (let i = 0; i < args.length; i++) {
    const m = args[i].match(/^--?([\w-]+)(?:=(.+))?$/);
    if (m) cfg[m[1]] = m[2] !== undefined ? m[2] : (args[i + 1] && !args[i + 1].startsWith('-') ? args[++i] : true);
  }
  return cfg;
}

const argv = parseArgs();
const get = (flag, envKey, def) =>
  argv[flag] !== undefined ? argv[flag]
  : process.env[envKey]    !== undefined ? process.env[envKey]
  : def;

const os = require('os');

const MODE        =        get('mode',        'MODE',        'aprs');  // aprs | adsb | both
const WEB_PORT    = Number(get('port',        'PORT',        3000));
const FREQ        =        get('freq',        'FREQ',        '144.390M');
const SAMPLE_RATE = Number(get('sample-rate', 'SAMPLE_RATE', 22050));
const GAIN        =        get('gain',        'GAIN',        'auto');
const PPM         = Number(get('ppm',         'PPM',         0));
const RTL_DEVICE  = Number(get('device',      'DEVICE',      0));
const DIREWOLF_HOST =      get('kiss-host',   'KISS_HOST',   '127.0.0.1');
const KISS_PORT   = Number(get('kiss-port',   'KISS_PORT',   8001));
const PAT_BIN     =        get('pat-bin',     'PAT_BIN',     path.join(os.homedir(), 'go/bin/pat'));
const PAT_PORT    = Number(get('pat-port',    'PAT_PORT',    8080));
const PAT_CALL    =        get('pat-callsign','PAT_CALLSIGN','');
const ADSB_BIN    =        get('adsb-bin',    'ADSB_BIN',    'dump1090');
const ADSB_DEVICE = Number(get('adsb-device', 'ADSB_DEVICE', MODE === 'both' ? 1 : 0));
const SBS_PORT    = Number(get('sbs-port',    'SBS_PORT',    30003));

// KISS special bytes
const FEND = 0xC0;
const FESC = 0xDB;
const TFEND = 0xDC;
const TFESC = 0xDD;

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const stations = new Map();   // callsign -> station object
const packetLog = [];          // last 200 packets
const MAX_LOG = 200;
const wsClients = new Set();
const winlinkMsgs = [];        // last 100 Winlink messages from Pat
const MAX_WL = 100;
const seenMIDs = new Set();    // dedup Pat inbox polls
const aircraft = new Map();    // icao -> aircraft object
const MAX_AC_TRACK = 100;

// ─── WebSocket ────────────────────────────────────────────────────────────────

wss.on('connection', (ws) => {
  wsClients.add(ws);
  ws.send(JSON.stringify({
    type: 'init',
    stations: Array.from(stations.values()),
    log: packetLog.slice(-50),
    winlink: winlinkMsgs.slice(-50),
    aircraft: Array.from(aircraft.values())
  }));
  ws.on('close', () => wsClients.delete(ws));
  ws.on('error', () => wsClients.delete(ws));
});

function broadcast(msg) {
  const str = JSON.stringify(msg);
  for (const ws of wsClients) {
    if (ws.readyState === 1) ws.send(str);
  }
}

// ─── AX.25 Parser ─────────────────────────────────────────────────────────────

function decodeAddr(buf, off) {
  let call = '';
  for (let i = 0; i < 6; i++) {
    const c = (buf[off + i] >> 1) & 0x7F;
    if (c > 0x20) call += String.fromCharCode(c);
  }
  const ssidByte = buf[off + 6];
  const ssid = (ssidByte >> 1) & 0x0F;
  const last = (ssidByte & 0x01) === 1;
  const repeated = (ssidByte & 0x80) !== 0;
  return { call: ssid ? `${call.trim()}-${ssid}` : call.trim(), last, repeated };
}

function parseAX25(buf) {
  if (buf.length < 16) return null;
  const dest = decodeAddr(buf, 0);
  const src  = decodeAddr(buf, 7);
  let off = 14;
  const path = [];
  if (!src.last) {
    while (off + 7 <= buf.length) {
      const d = decodeAddr(buf, off);
      off += 7;
      path.push(d);
      if (d.last) break;
    }
  }
  if (off >= buf.length) return null;
  const ctrl = buf[off++];
  if ((ctrl & 0xEF) !== 0x03) return null; // UI frames only
  if (off >= buf.length) return null;
  off++; // PID
  return { dest: dest.call, src: src.call, path, info: buf.slice(off) };
}

// ─── APRS Parser ──────────────────────────────────────────────────────────────

function toDecDeg(deg, min, dir) {
  let v = deg + min / 60;
  if (dir === 'S' || dir === 'W') v = -v;
  return Math.round(v * 1000000) / 1000000;
}

function parseStdPos(s) {
  // DDmm.mmN/DDDmm.mmWS[comment]
  // Spaces in minute fields are legal (APRS position ambiguity — treat as 0)
  const m = s.match(/^(\d{2})([\d ]{2}\.[\d ]+)([NS])(.)(\d{3})([\d ]{2}\.[\d ]+)([EW])(.)(.*)$/s);
  if (!m) return null;
  return {
    lat: toDecDeg(+m[1], +m[2].replace(/ /g, '0'), m[3]),
    lon: toDecDeg(+m[5], +m[6].replace(/ /g, '0'), m[7]),
    symTable: m[4], sym: m[8], comment: m[9]
  };
}

function parseCompressedPos(s) {
  // /YYYYXXXXcsT
  if (s.length < 13) return null;
  const symTable = s[0];
  const b = (c) => c.charCodeAt(0) - 33;
  const lat = 90 - (b(s[1]) * 753571 + b(s[2]) * 8281 + b(s[3]) * 91 + b(s[4])) / 380926;
  const lon = -180 + (b(s[5]) * 753571 + b(s[6]) * 8281 + b(s[7]) * 91 + b(s[8])) / 190463;
  return {
    lat: Math.round(lat * 1000000) / 1000000,
    lon: Math.round(lon * 1000000) / 1000000,
    symTable, sym: s[9], comment: s.slice(13)
  };
}

function parseMicE(destCall, infoBuf) {
  const dest = destCall.split('-')[0].padEnd(6);
  if (dest.length < 6 || infoBuf.length < 9) return null;

  function decChar(c) {
    const code = c.charCodeAt(0);
    if (code >= 0x30 && code <= 0x39) return { d: code - 0x30, flag: false };
    if (code === 0x4C) return { d: 0, flag: false };               // L
    if (code >= 0x41 && code <= 0x4B) return { d: code - 0x41, flag: true }; // A-K
    if (code >= 0x50 && code <= 0x5A) return { d: code - 0x50, flag: true }; // P-Z
    return null;
  }

  const dc = [];
  for (let i = 0; i < 6; i++) {
    const r = decChar(dest[i]);
    if (!r) return null;
    dc.push(r);
  }

  const latDeg = dc[0].d * 10 + dc[1].d;
  const latMin = dc[2].d * 10 + dc[3].d + (dc[4].d * 10 + dc[5].d) / 100;
  const isNorth   = dc[3].flag;
  const lonOffset = dc[4].flag;
  const isWest    = dc[5].flag;

  let lat = latDeg + latMin / 60;
  if (!isNorth) lat = -lat;

  let lonDeg = infoBuf[1] - 28;
  let lonMin = infoBuf[2] - 28;
  const lonFrac = infoBuf[3] - 28;
  if (lonOffset) lonDeg += 100;
  if (lonDeg >= 180 && lonDeg <= 189) lonDeg -= 80;
  if (lonMin >= 60) lonMin -= 60;

  let lon = lonDeg + lonMin / 60 + lonFrac / 6000;
  if (isWest) lon = -lon;

  // Speed/course: spec says subtract 800/400 if value meets or exceeds threshold
  let speed  = (infoBuf[4] - 28) * 10 + Math.floor((infoBuf[5] - 28) / 10);
  let course = ((infoBuf[5] - 28) % 10) * 100 + (infoBuf[6] - 28);
  if (speed  >= 800) speed  -= 800;
  if (course >= 400) course -= 400;

  const symTable = String.fromCharCode(infoBuf[7]);
  const sym      = String.fromCharCode(infoBuf[8]);

  // Optional altitude field: 3 base-91 chars + '}', may precede the comment
  let raw = infoBuf.slice(9).toString('latin1').replace(/^[\r\n]/, '');
  let altitude = null;
  const altMatch = raw.match(/^([\x21-\x7b]{3})\}([\s\S]*)$/);
  if (altMatch) {
    const a = altMatch[1];
    altitude = (a.charCodeAt(0) - 33) * 8281 + (a.charCodeAt(1) - 33) * 91 + (a.charCodeAt(2) - 33) - 10000;
    raw = altMatch[2];
  }

  return {
    lat: Math.round(lat * 1000000) / 1000000,
    lon: Math.round(lon * 1000000) / 1000000,
    symTable, sym, comment: raw.trim(), speed, course,
    ...(altitude !== null ? { altitude } : {})
  };
}

function parseAPRS(frame) {
  if (!frame.info || frame.info.length === 0) return null;
  const infoStr = frame.info.toString('latin1');
  const type = infoStr[0];
  const now = new Date().toISOString();

  const pkt = {
    from: frame.src,
    to: frame.dest,
    path: frame.path.map(d => d.call + (d.repeated ? '*' : '')).join(','),
    raw: infoStr,
    type: 'unknown',
    time: now
  };

  let pos = null;

  switch (type) {
    case '!':
    case '=':
      pkt.type = 'position';
      pos = parseStdPos(infoStr.slice(1));
      if (!pos) pos = parseCompressedPos(infoStr.slice(1));
      break;

    case '/':
    case '@': {
      pkt.type = 'position';
      const ts = infoStr.slice(1, 8);
      pkt.timestamp = ts;
      pos = parseStdPos(infoStr.slice(8));
      if (!pos) pos = parseCompressedPos(infoStr.slice(8));
      break;
    }

    case ':':
      pkt.type = 'message';
      pkt.addressee = infoStr.slice(1, 10).trim();
      pkt.message   = infoStr.slice(11);
      if (pkt.addressee === 'WLNK-1' || pkt.addressee.startsWith('WL2K')) pkt.winlink = true;
      break;

    case ';': {
      pkt.type = 'object';
      pkt.name = infoStr.slice(1, 10).trim();
      pkt.live = infoStr[10] === '*';
      const oTs = infoStr.slice(11, 18);
      pos = parseStdPos(infoStr.slice(18));
      break;
    }

    case ')': {
      pkt.type = 'item';
      const excl = infoStr.indexOf('!', 1);
      if (excl > 0) {
        pkt.name = infoStr.slice(1, excl);
        pos = parseStdPos(infoStr.slice(excl + 1));
      }
      break;
    }

    case '>':
      pkt.type = 'status';
      pkt.status = infoStr.slice(1).replace(/^\d{6}[zh]\s*/, '');
      break;

    case '_':
      pkt.type = 'weather';
      pkt.comment = infoStr.slice(1);
      break;

    case 'T':
      pkt.type = 'telemetry';
      pkt.comment = infoStr.slice(1);
      break;

    case '`':
    case '\'': {
      pkt.type = 'position';
      const m = parseMicE(frame.dest, frame.info);
      if (m) {
        pos = m;
        pkt.speed  = m.speed;
        pkt.course = m.course;
        if (m.altitude != null) pkt.altitude = m.altitude;
      }
      break;
    }

    default: {
      // Compressed position: valid symbol-table char + 8 base-91 data bytes (chars 33–123)
      const slice = infoStr.slice(1);
      if (slice.length >= 13) {
        const c0 = slice.charCodeAt(0);
        const validTable = c0 === 0x2F || c0 === 0x5C ||
          (c0 >= 0x30 && c0 <= 0x39) || (c0 >= 0x41 && c0 <= 0x5A);
        const validData = slice.slice(1, 9).split('').every(c => {
          const cc = c.charCodeAt(0); return cc >= 33 && cc <= 123;
        });
        if (validTable && validData) {
          pos = parseCompressedPos(slice);
          if (pos) pkt.type = 'position';
        }
      }
    }
  }

  if (pos) {
    pkt.lat = pos.lat;
    pkt.lon = pos.lon;
    pkt.symbol  = pos.symTable + pos.sym;
    pkt.comment = (pos.comment || '').trim();
  }

  // Detect Winlink
  if (frame.dest && (frame.dest.startsWith('APWL') || frame.dest.startsWith('APRS2')))
    pkt.winlink = true;
  if (pkt.symbol === '\\W') pkt.winlink = true;

  return pkt;
}

// ─── Station Store ─────────────────────────────────────────────────────────────

function handlePacket(pkt) {
  if (!stations.has(pkt.from)) {
    stations.set(pkt.from, {
      callsign:  pkt.from,
      firstSeen: pkt.time,
      lastSeen:  pkt.time,
      packets:   0,
      track:     [],
      lat: null, lon: null,
      symbol: '/>',
      comment: '',
      status: '',
      type: pkt.type,
      winlink: false,
      altitude: null
    });
  }

  const st = stations.get(pkt.from);
  st.lastSeen = pkt.time;
  st.packets++;
  st.type = pkt.type !== 'unknown' ? pkt.type : st.type;

  if (pkt.lat != null && pkt.lon != null) {
    st.lat = pkt.lat;
    st.lon = pkt.lon;
    st.track.push({ lat: pkt.lat, lon: pkt.lon, time: pkt.time });
    if (st.track.length > 200) st.track.shift();
  }
  if (pkt.symbol)  st.symbol  = pkt.symbol;
  if (pkt.comment !== undefined && pkt.comment !== '') st.comment = pkt.comment;
  if (pkt.status)  st.status  = pkt.status;
  if (pkt.winlink) st.winlink = true;
  if (pkt.speed    != null) { st.speed = pkt.speed; st.course = pkt.course; }
  if (pkt.altitude != null) st.altitude = pkt.altitude;

  packetLog.push(pkt);
  if (packetLog.length > MAX_LOG) packetLog.shift();

  broadcast({ type: 'packet', packet: pkt, station: st });
  console.log(`[APRS] ${pkt.from} > ${pkt.to} (${pkt.type})${pkt.lat != null ? ` @ ${pkt.lat},${pkt.lon}` : ''}`);
}

// ─── KISS TCP Client ──────────────────────────────────────────────────────────

function processKISSFrame(data) {
  if (data.length < 2) return;
  if ((data[0] & 0x0F) !== 0) return; // data frame type 0 only
  const ax25 = data.slice(1);
  const frame = parseAX25(ax25);
  if (!frame) return;
  const pkt = parseAPRS(frame);
  if (!pkt) return;
  handlePacket(pkt);
}

function startKISSClient() {
  const sock = new net.Socket();
  let inFrame = false, escaped = false, buf = [];

  sock.on('connect', () => {
    console.log(`[KISS] Connected to Direwolf ${DIREWOLF_HOST}:${KISS_PORT}`);
    inFrame = false; escaped = false; buf = [];
    broadcast({ type: 'status', connected: true });
  });

  sock.on('data', (data) => {
    for (const byte of data) {
      if (escaped) {
        if (byte === TFEND) buf.push(FEND);
        else if (byte === TFESC) buf.push(FESC);
        escaped = false;
      } else if (byte === FEND) {
        if (inFrame && buf.length > 1) {
          try { processKISSFrame(Buffer.from(buf)); } catch (e) {}
        }
        buf = []; inFrame = true;
      } else if (byte === FESC) {
        escaped = true;
      } else if (inFrame) {
        buf.push(byte);
      }
    }
  });

  sock.on('error', (err) => {
    console.error('[KISS] Error:', err.message);
    broadcast({ type: 'status', connected: false });
  });

  sock.on('close', () => {
    console.log('[KISS] Disconnected — retrying in 5s');
    broadcast({ type: 'status', connected: false });
    setTimeout(() => sock.connect(KISS_PORT, DIREWOLF_HOST), 5000);
  });

  sock.connect(KISS_PORT, DIREWOLF_HOST);
}

// ─── Radio Pipeline ────────────────────────────────────────────────────────────

function startRadio() {
  console.log(`[radio] Starting rtl_fm → direwolf pipeline (freq=${FREQ}, gain=${GAIN}, ppm=${PPM}, device=${RTL_DEVICE})`);

  const rtlArgs = ['-f', FREQ, '-M', 'fm', '-s', String(SAMPLE_RATE), '-E', 'deemp', '-d', String(RTL_DEVICE)];
  if (PPM !== 0) rtlArgs.push('-p', String(PPM));
  if (GAIN !== 'auto') rtlArgs.push('-g', String(GAIN));
  rtlArgs.push('-');

  const rtlFm = spawn('rtl_fm', rtlArgs, {
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const direwolf = spawn('direwolf', ['-r', String(SAMPLE_RATE), '-'], {
    stdio: ['pipe', 'pipe', 'pipe']
  });

  // Pipe rtl_fm audio → direwolf stdin
  rtlFm.stdout.pipe(direwolf.stdin);

  // Log direwolf output (packet decodes etc.)
  direwolf.stdout.on('data', d => process.stdout.write(d));
  direwolf.stderr.on('data', d => process.stderr.write(d));
  rtlFm.stderr.on('data', d => process.stderr.write(d));

  let dead = false;
  function die(label, code) {
    if (dead) return;
    dead = true;
    console.log(`[radio] ${label} exited (${code}) — restarting in 5s`);
    try { rtlFm.kill();    } catch (_) {}
    try { direwolf.kill(); } catch (_) {}
    setTimeout(startRadio, 5000);
  }

  rtlFm.on('close',    (c) => die('rtl_fm',    c));
  direwolf.on('close', (c) => die('direwolf',  c));
  rtlFm.on('error',    (e) => die('rtl_fm',    e.message));
  direwolf.on('error', (e) => die('direwolf',  e.message));
}

// ─── Pat / Winlink ─────────────────────────────────────────────────────────────

async function pollPat() {
  try {
    const res = await fetch(`http://127.0.0.1:${PAT_PORT}/api/mailbox/inbox`);
    if (!res.ok) return;
    const messages = await res.json();
    if (!Array.isArray(messages)) return;
    for (const msg of messages) {
      if (seenMIDs.has(msg.MID)) continue;
      seenMIDs.add(msg.MID);
      winlinkMsgs.push(msg);
      if (winlinkMsgs.length > MAX_WL) winlinkMsgs.shift();
      broadcast({ type: 'winlink', message: msg });
      console.log(`[Pat] New message: "${msg.Subject}" from ${msg.From}`);
    }
  } catch (_) { /* Pat not running yet */ }
}

function startPat() {
  const args = [];
  if (PAT_CALL) args.push('--mycall', PAT_CALL);
  args.push('http', '-a', `0.0.0.0:${PAT_PORT}`);

  console.log(`[Pat] Starting ${PAT_BIN} ${args.join(' ')}`);
  const pat = spawn(PAT_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });

  pat.stdout.on('data', d => process.stdout.write(`[Pat] ${d}`));
  pat.stderr.on('data', d => process.stderr.write(`[Pat] ${d}`));

  pat.on('error', (e) => console.error(`[Pat] Failed to start: ${e.message}`));
  pat.on('close', (c) => {
    console.log(`[Pat] exited (${c}) — restarting in 10s`);
    setTimeout(startPat, 10000);
  });

  // Begin polling after Pat has time to initialize
  setTimeout(() => {
    pollPat();
    setInterval(pollPat, 30000);
  }, 5000);
}

// ─── ADS-B / SBS ───────────────────────────────────────────────────────────────

function parseSBS(line) {
  // SBS (BaseStation) format: MSG,type,,,icao,,,,,,,alt,spd,hdg,lat,lon,vr,sqk,...
  const f = line.split(',');
  if (f[0] !== 'MSG' || f.length < 16) return null;
  const type = Number(f[1]);
  const icao = f[4].trim().toUpperCase();
  if (!icao) return null;

  const upd = { icao, time: new Date().toISOString() };
  if (type === 1 && f[10].trim()) upd.callsign = f[10].trim();
  if (type === 3) {
    if (f[11] !== '') upd.altitude    = Number(f[11]);
    if (f[14] !== '') upd.lat         = Number(f[14]);
    if (f[15] !== '') upd.lon         = Number(f[15]);
    upd.onGround = f[21] !== undefined && f[21].trim() === '1';
  }
  if (type === 4) {
    if (f[12] !== '') upd.speed       = Number(f[12]);
    if (f[13] !== '') upd.heading     = Number(f[13]);
    if (f[16] !== '') upd.verticalRate = Number(f[16]);
  }
  if (type === 6 && f[17] !== '') upd.squawk = f[17].trim();
  return upd;
}

function handleAircraft(upd) {
  if (!aircraft.has(upd.icao)) {
    aircraft.set(upd.icao, {
      icao: upd.icao, callsign: '',
      lat: null, lon: null,
      altitude: null, speed: null, heading: null,
      verticalRate: null, squawk: null, onGround: false,
      firstSeen: upd.time, lastSeen: upd.time, track: []
    });
  }
  const ac = aircraft.get(upd.icao);
  ac.lastSeen = upd.time;
  if (upd.callsign     !== undefined) ac.callsign     = upd.callsign;
  if (upd.altitude     !== undefined) ac.altitude     = upd.altitude;
  if (upd.speed        !== undefined) ac.speed        = upd.speed;
  if (upd.heading      !== undefined) ac.heading      = upd.heading;
  if (upd.verticalRate !== undefined) ac.verticalRate = upd.verticalRate;
  if (upd.squawk       !== undefined) ac.squawk       = upd.squawk;
  if (upd.onGround     !== undefined) ac.onGround     = upd.onGround;
  if (upd.lat != null && upd.lon != null) {
    ac.lat = upd.lat; ac.lon = upd.lon;
    ac.track.push({ lat: upd.lat, lon: upd.lon, time: upd.time });
    if (ac.track.length > MAX_AC_TRACK) ac.track.shift();
  }
  broadcast({ type: 'aircraft', aircraft: ac });
}

// Remove aircraft not heard in 60 s
setInterval(() => {
  const cutoff = Date.now() - 60000;
  for (const [icao, ac] of aircraft) {
    if (new Date(ac.lastSeen).getTime() < cutoff) {
      aircraft.delete(icao);
      broadcast({ type: 'aircraft_remove', icao });
    }
  }
}, 15000);

function connectSBS() {
  const sock = new net.Socket();
  let buf = '';

  sock.on('connect', () => console.log(`[SBS] Connected to dump1090 on :${SBS_PORT}`));

  sock.on('data', (data) => {
    buf += data.toString();
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      try {
        const upd = parseSBS(line.trim());
        if (upd) handleAircraft(upd);
      } catch (_) {}
    }
  });

  sock.on('error', (err) => console.error('[SBS] Error:', err.message));
  sock.on('close', () => {
    console.log('[SBS] Disconnected — retrying in 5s');
    setTimeout(() => sock.connect(SBS_PORT, '127.0.0.1'), 5000);
  });

  sock.connect(SBS_PORT, '127.0.0.1');
}

function startADSB() {
  console.log(`[ADS-B] Starting ${ADSB_BIN} (device=${ADSB_DEVICE})`);
  const args = [
    '--device-index', String(ADSB_DEVICE),
    '--net',
    '--net-sbs-port', String(SBS_PORT),
    '--quiet'
  ];
  const proc = spawn(ADSB_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout.on('data', d => process.stdout.write(d));
  proc.stderr.on('data', d => process.stderr.write(d));
  proc.on('error', e => console.error(`[ADS-B] Failed to start: ${e.message}`));
  proc.on('close', (c) => {
    console.log(`[ADS-B] dump1090 exited (${c}) — restarting in 5s`);
    setTimeout(startADSB, 5000);
  });
  setTimeout(connectSBS, 2000);
}

// ─── Start ─────────────────────────────────────────────────────────────────────

server.listen(WEB_PORT, '0.0.0.0', () => {
  const ifaces = os.networkInterfaces();
  const ips = Object.values(ifaces).flat().filter(i => i.family === 'IPv4' && !i.internal).map(i => i.address);
  console.log(`APRS Web Monitor → http://localhost:${WEB_PORT}`);
  ips.forEach(ip => console.log(`                   http://${ip}:${WEB_PORT}`));
  console.log(`Mode:   ${MODE}`);
  if (MODE !== 'adsb')
    console.log(`APRS:   freq=${FREQ}  gain=${GAIN}  ppm=${PPM}  device=${RTL_DEVICE}  sample-rate=${SAMPLE_RATE}  kiss=${DIREWOLF_HOST}:${KISS_PORT}`);
  if (MODE !== 'aprs')
    console.log(`ADS-B:  bin=${ADSB_BIN}  device=${ADSB_DEVICE}  sbs-port=${SBS_PORT}`);
  console.log(`Pat:    bin=${PAT_BIN}  port=${PAT_PORT}${PAT_CALL ? `  callsign=${PAT_CALL}` : '  (set --pat-callsign)'}`);
});

if (MODE === 'aprs' || MODE === 'both') { startRadio(); startKISSClient(); }
if (MODE === 'adsb' || MODE === 'both') startADSB();
startPat();
