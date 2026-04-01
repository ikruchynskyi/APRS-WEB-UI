# APRS Web Monitor

A live APRS packet monitor with a real-time web UI. Receives packets from an RTL-SDR dongle via `rtl_fm` + Direwolf, decodes AX.25/APRS frames, and displays stations on an interactive Leaflet map with a live packet log.

![APRS Web Monitor UI](example.png)

## Features

- RTL-SDR → rtl_fm → Direwolf radio pipeline (auto-restarts on crash)
- Full APRS decoder: position (standard, compressed, Mic-E), message, object, item, weather, telemetry, status
- Interactive Leaflet map with station markers and track lines
- Real-time WebSocket push — no page refresh needed
- Station detail panel, callsign search, packet log
- ADS-B mode: live aircraft radar via dump1090, colour-coded by altitude

## Requirements

| Tool | Purpose | Mode |
|------|---------|------|
| Node.js ≥ 18 | Runs the web server | all |
| `rtl_fm` (rtl-sdr) | Tunes the SDR and outputs raw FM audio | aprs |
| `direwolf` | Decodes AX.25 frames, provides KISS TCP interface | aprs |
| `dump1090` | Decodes ADS-B Mode S at 1090 MHz | adsb |
| RTL-SDR USB dongle | Hardware SDR receiver | all |

## Installation

### 1. Node.js

**Debian / Ubuntu / Raspberry Pi OS:**
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node --version   # should print v20.x.x or higher
```

**macOS (Homebrew):**
```bash
brew install node
```

**Windows:** Download the installer from https://nodejs.org

---

### 2. RTL-SDR tools (`rtl_fm`)

**Debian / Ubuntu / Raspberry Pi OS:**
```bash
sudo apt update
sudo apt install -y rtl-sdr
```

**macOS (Homebrew):**
```bash
brew install librtlsdr
```

**From source (any Linux):**
```bash
sudo apt install -y cmake libusb-1.0-0-dev
git clone https://github.com/osmocom/rtl-sdr.git
cd rtl-sdr && mkdir build && cd build
cmake .. -DINSTALL_UDEV_RULES=ON
make && sudo make install && sudo ldconfig
```

**Blacklist the kernel DVB driver** so rtl-sdr can claim the device:
```bash
echo 'blacklist dvb_usb_rtl28xxu' | sudo tee /etc/modprobe.d/rtlsdr.conf
sudo modprobe -r dvb_usb_rtl28xxu   # unload without rebooting
```

Verify: plug in the dongle and run `rtl_test` — it should print device info.

---

### 3. Direwolf

**Debian / Ubuntu / Raspberry Pi OS:**
```bash
sudo apt install -y direwolf
```

**From source (recommended for latest version):**
```bash
sudo apt install -y cmake libasound2-dev libhamlib-dev
git clone https://www.github.com/wb2osz/direwolf.git
cd direwolf && mkdir build && cd build
cmake ..
make -j$(nproc) && sudo make install
```

**macOS (Homebrew):**
```bash
brew install direwolf
```

Direwolf is started automatically by `server.js` — you do not need to configure or launch it manually.

---

### 4. dump1090 (ADS-B decoder)

**Debian / Ubuntu / Raspberry Pi OS:**
```bash
sudo apt install -y dump1090-mutability
# or the FlightAware fork:
sudo apt install -y dump1090-fa
```

**From source:**
```bash
sudo apt install -y librtlsdr-dev libusb-1.0-0-dev
git clone https://github.com/antirez/dump1090.git
cd dump1090 && make
sudo cp dump1090 /usr/local/bin/
```

**macOS (Homebrew):**
```bash
brew install dump1090-mutability
```

Verify: `dump1090 --help`

---

### 5. Node.js dependencies (npm packages)

```bash
cd aprs-web
npm install
```

This installs `express` and `ws` from `package.json`. No other packages are required.

---

## Quick Start

```bash
npm install
node server.js
```

Open `http://localhost:3000` in a browser.

Run `node server.js --help` to see all available options.

## Parameters

All parameters can be passed as CLI flags or environment variables.

### CLI usage

```
node server.js [options]
```

| Flag | Env Var | Default | Description |
|------|---------|---------|-------------|
| `--mode <m>` | `MODE` | `aprs` | Operating mode: `aprs` or `adsb` |
| `--port <n>` | `PORT` | `3000` | Web server HTTP port |
| `--freq <f>` | `FREQ` | `144.390M` | RTL-FM receive frequency |
| `--gain <n\|auto>` | `GAIN` | `auto` | RTL-SDR gain in dB, or `auto` |
| `--ppm <n>` | `PPM` | `0` | RTL-SDR PPM frequency correction |
| `--device <n>` | `DEVICE` | `0` | RTL-SDR device index (for multiple dongles) |
| `--sample-rate <n>` | `SAMPLE_RATE` | `22050` | Audio sample rate in Hz |
| `--kiss-host <h>` | `KISS_HOST` | `127.0.0.1` | Direwolf KISS TCP host |
| `--kiss-port <n>` | `KISS_PORT` | `8001` | Direwolf KISS TCP port |
| `--adsb-bin <path>` | `ADSB_BIN` | `dump1090` | Path to dump1090 binary |
| `--adsb-device <n>` | `ADSB_DEVICE` | `0` | RTL-SDR device index for ADS-B |
| `--sbs-port <n>` | `SBS_PORT` | `30003` | dump1090 SBS TCP output port |

### Examples

```bash
# North America APRS (default)
node server.js

# Europe APRS frequency
node server.js --freq 144.800M

# Custom port, manual gain, PPM correction
node server.js --port 8080 --gain 40 --ppm -5

# Second RTL-SDR dongle, alternate web port
node server.js --device 1 --port 3001

# Using environment variables
PORT=8080 FREQ=144.800M GAIN=35 node server.js
```

### Common APRS Frequencies

| Region | Frequency |
|--------|-----------|
| North America | `144.390M` |
| Europe | `144.800M` |
| Australia | `145.175M` |
| New Zealand | `144.575M` |
| Japan | `144.640M` |
| South America | `144.390M` |

## ADS-B Mode

Spawns `dump1090` to decode Mode S transponder signals at 1090 MHz and displays aircraft on the radar map in real time. Aircraft markers are colour-coded by altitude and rotate to show heading.

| Colour | Altitude |
|--------|----------|
| Grey | Ground / < 1 000 ft |
| Green | 1 000 – 10 000 ft |
| Amber | 10 000 – 25 000 ft |
| Blue | > 25 000 ft |

Aircraft disappear automatically after 60 seconds without a signal.

```bash
# ADS-B only
node server.js --mode adsb

# Custom dump1090 binary location
node server.js --mode adsb --adsb-bin /usr/bin/dump1090-fa
```

## Architecture

```
APRS mode:                          ADS-B mode:
  RTL-SDR dongle (144.390 MHz)        RTL-SDR dongle (1090 MHz)
        │                                   │
     rtl_fm  (FM demod, 22050 Hz)       dump1090  (Mode S decoder)
        │ (pipe)                             │ (SBS TCP :30003)
    Direwolf  (AX.25 / KISS TCP)            │
        │ (KISS TCP :8001)                  │
        └──────────────┬────────────────────┘
                  server.js  (Node.js — parser, store, WebSocket)
                       │ (WebSocket + HTTP :3000)
                   Browser  (Leaflet map, station/aircraft list)
```

## Running with pm2 (auto-restart on reboot)

```bash
npm install -g pm2
pm2 start server.js --name aprs-web -- --freq 144.390M --gain 35
pm2 save
pm2 startup
```

## License

MIT
