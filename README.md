# APRS Web Monitor

A live APRS packet monitor with a real-time web UI. Receives packets from an RTL-SDR dongle via `rtl_fm` + Direwolf, decodes AX.25/APRS frames, and displays stations on an interactive Leaflet map with a live packet log.

![APRS Web Monitor UI](example.png)

## Features

- RTL-SDR → rtl_fm → Direwolf radio pipeline (auto-restarts on crash)
- Full APRS decoder: position (standard, compressed, Mic-E), message, object, item, weather, telemetry, status
- Interactive Leaflet map with station markers and track lines
- Real-time WebSocket push — no page refresh needed
- Station detail panel, callsign search, packet log
- Winlink / WL2K station detection

## Requirements

| Tool | Purpose |
|------|---------|
| Node.js ≥ 18 | Runs the web server |
| `rtl_fm` (rtl-sdr) | Tunes the SDR and outputs raw FM audio |
| `direwolf` | Decodes AX.25 frames, provides KISS TCP interface |
| RTL-SDR USB dongle | Hardware SDR receiver |

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

### 4. Go (required for Pat)

**Debian / Ubuntu / Raspberry Pi OS:**
```bash
# Download the latest Go release (check https://go.dev/dl/ for the current version)
wget https://go.dev/dl/go1.23.4.linux-arm64.tar.gz        # Raspberry Pi / ARM64
# wget https://go.dev/dl/go1.23.4.linux-amd64.tar.gz      # x86-64 Linux

sudo rm -rf /usr/local/go
sudo tar -C /usr/local -xzf go1.23.4.linux-*.tar.gz

# Add Go to PATH (add to ~/.bashrc or ~/.zshrc to persist)
export PATH=$PATH:/usr/local/go/bin:$HOME/go/bin
source ~/.bashrc
go version   # should print go1.23.x
```

**macOS (Homebrew):**
```bash
brew install go
```

---

### 5. Pat (Winlink client)

```bash
go install github.com/la5nta/pat@latest
# Binary is installed to ~/go/bin/pat
~/go/bin/pat --version
```

**Initial configuration:**
```bash
~/go/bin/pat configure
```

This opens a text editor with `~/.config/pat/config.json`. Set at minimum:
```json
{
  "mycall": "YOUR_CALLSIGN",
  "locator": "FN30",
  "http_addr": "0.0.0.0:8080"
}
```

---

### 6. Node.js dependencies (npm packages)

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

## Parameters

All parameters can be passed as CLI flags or environment variables.

### CLI usage

```
node server.js [options]
```

| Flag | Env Var | Default | Description |
|------|---------|---------|-------------|
| `--port <n>` | `PORT` | `3000` | Web server HTTP port |
| `--freq <f>` | `FREQ` | `144.390M` | RTL-FM receive frequency |
| `--gain <n\|auto>` | `GAIN` | `auto` | RTL-SDR gain in dB, or `auto` |
| `--ppm <n>` | `PPM` | `0` | RTL-SDR PPM frequency correction |
| `--device <n>` | `DEVICE` | `0` | RTL-SDR device index (for multiple dongles) |
| `--sample-rate <n>` | `SAMPLE_RATE` | `22050` | Audio sample rate in Hz |
| `--kiss-host <h>` | `KISS_HOST` | `127.0.0.1` | Direwolf KISS TCP host |
| `--kiss-port <n>` | `KISS_PORT` | `8001` | Direwolf KISS TCP port |
| `--pat-bin <path>` | `PAT_BIN` | `~/go/bin/pat` | Path to Pat binary |
| `--pat-port <n>` | `PAT_PORT` | `8080` | Pat HTTP API port |
| `--pat-callsign <call>` | `PAT_CALLSIGN` | *(from pat config)* | Override callsign passed to Pat |

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

## Winlink

The server automatically spawns `pat http` at startup and polls its REST API every 30 seconds. Incoming messages appear in the **Winlink** tab of the web UI with an unread badge counter.

### Testing Winlink connectivity

```bash
# 1. Verify Pat is configured (check your callsign is set)
~/go/bin/pat --version
cat ~/.config/pat/config.json

# 2. Test connection to Winlink via Telnet (internet, no radio needed)
~/go/bin/pat connect telnet

# 3. Send yourself a test message via Winlink webmail, then poll Pat to fetch it
~/go/bin/pat connect telnet   # connects, syncs inbox, disconnects

# 4. Check Pat inbox via its REST API (while pat http is running)
curl http://localhost:8080/api/mailbox/inbox | python3 -m json.tool

# 5. Manually trigger a fetch without waiting 30 s (restart server or use curl above)
```

> **Tip:** Go to https://webmail.winlink.org, log in with your callsign, and send a test message to yourself. Then run `~/go/bin/pat connect telnet` — it will download the message into Pat's inbox, and the server will pick it up on the next poll.

### Winlink via RF (VHF Packet)

To use Winlink over the air instead of Telnet, configure Pat for the `ax25` or `ardop`/`vara` transport and ensure your TNC/modem is running. This is independent of the APRS 144.390 MHz monitoring — you can run both simultaneously.

## Architecture

```
RTL-SDR dongle
      │
   rtl_fm          (FM demodulation, 22050 Hz audio)
      │ (pipe)
  Direwolf         (AX.25 / APRS decoding, KISS TCP server)
      │ (KISS TCP 127.0.0.1:8001)
  server.js        (Node.js — APRS parser, station store, WebSocket broadcast)
      │ (WebSocket + HTTP)
  Browser          (Leaflet map, packet log, station list)
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
