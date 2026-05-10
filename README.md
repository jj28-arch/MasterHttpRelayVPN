# MasterHttpRelayVPN — TCP Tunnel Fork

**[🇮🇷 راهنمای فارسی (Persian)](README_FA.md)**

> **This is a fork of [masterking32/MasterHttpRelayVPN](https://github.com/masterking32/MasterHttpRelayVPN)** with a major core change: it adds **real TCP tunneling** on top of the original HTTP relay.
>
> The upstream project relays only HTTP/HTTPS traffic through Google Apps Script. That works for browsing, but it cannot carry arbitrary TCP — because **Google Apps Script has no TCP socket API**: `UrlFetchApp` only speaks HTTP. Any application that needs raw TCP (SSH, generic SOCKS5 traffic from non-MITM-able clients, custom protocols, browsers that won't trust the local MITM CA, etc.) falls outside its reach.
>
> This fork keeps the original HTTP relay intact and adds a second data plane that gives the client a *real* end-to-end TCP connection through the same fronted Google channel. The persistent socket lives on a **Cloudflare Worker Durable Object** that Apps Script forwards to; the Python proxy drives both directions concurrently with **long-polling** so the browser experiences a normal TCP connection without us burning Apps Script quota on busy-loop polls.

---

## Why this fork exists

The original tool's flow is:

```
Browser → Local HTTP Proxy → Google front → Apps Script → fetch(target URL) → response
```

Apps Script sees the request, calls `UrlFetchApp.fetch(...)`, and returns the body. **Each request is a one-shot HTTP fetch.** Once the response is returned, no state is kept on the Google side. There is no socket, no `connect()`, no half-open stream — Apps Script's runtime simply does not expose TCP primitives.

That makes the upstream project unable to serve:
- A browser configured to use it as a **SOCKS5** proxy (the browser does not always treat it as an HTTP proxy and TLS state must survive across many roundtrips).
- Any SOCKS5 client that needs to talk a non-HTTP protocol (SSH, MTProto, raw TLS to opaque hosts, etc.).
- Anything where the browser refuses to trust the locally-installed MITM CA (work laptops, mobile browsers, Firefox containers without exception, etc.).

This fork solves that by introducing a real persistent TCP socket **upstream of Apps Script**, on Cloudflare, and turning Apps Script into a forwarder.

---

## Architecture

```
                                                           ┌──────────────────────────────┐
                                                           │  Cloudflare Worker           │
 Browser (SOCKS5)                                          │  ┌────────────────────────┐  │
       │                                                   │  │ Durable Object         │  │
       ▼                                                   │  │  TcpTunnel(tunnel_id)  │  │
 ┌──────────────┐    HTTPS (SNI=www.google.com,            │  │   • real TCP socket    │  │
 │  Local Proxy │──── Host=script.google.com) ────►  Apps  │  │   • recv buffer        │──┼──► target host:port
 │  (Python)    │◄──── action-based JSON ────  Script  ────┼─►│   • long-poll waiter   │  │
 └──────────────┘                                          │  └────────────────────────┘  │
       ▲                                                   └──────────────────────────────┘
       │
   uploader (client → relay)         downloader (relay → client, long-polled)
```

### The action protocol (Python ↔ Apps Script ↔ DO)

The Python proxy POSTs JSON to Apps Script; Apps Script forwards it verbatim to the Cloudflare Worker, which routes it to the Durable Object instance keyed by `tunnel_id`. The DO is the *only* place that holds the live TCP socket.

| action  | what it does                                                                 |
|---------|-------------------------------------------------------------------------------|
| `open`  | DO opens a TCP socket to `target_host:target_port`. Optional `data` is sent on the wire and any immediate response (e.g. SSH banner) comes back in the same round-trip. |
| `send`  | DO writes `data` to the socket; piggy-backs `wait_ms` to drain any reply that arrives in that window — the TLS handshake's `ServerHello` typically rides this exact reply. |
| `poll`  | Long-poll. DO returns immediately if the recv buffer has bytes; otherwise it sleeps up to ~30 s waiting for the upstream server to speak. This is the **idle channel** that keeps the connection alive without traffic. |
| `close` | Frees the socket and the DO instance. Sent when the client disconnects. |

### Why long-polling

A naive design would have the Python client poll Apps Script every ~50 ms for new bytes. That is **20 requests/second per tunnel**, which would burn through Apps Script's daily `UrlFetchApp` quota (~20 000 calls/day on free tier) in under 20 minutes per tunnel.

Instead, the downloader issues a single **30-second long-poll**. The DO sleeps inside that one HTTP request until either (a) the server speaks, or (b) the wait window expires. So:

- An idle browser tab keeping a tunnel alive costs ~2 calls/min ≈ 2 880/day.
- Active TLS handshake / HTTP request bursts return *instantly* the moment data arrives — there is no fixed polling cadence to wait for.

### Concurrent uploader + downloader

Two independent loops run on the Python side:

- **Uploader:** reads from the SOCKS5 client, coalesces tiny back-to-back writes into a single POST (~20 ms batching window), sends `action=send`. Each upload also opportunistically drains downstream bytes (`wait_ms=200`), so request/response patterns like an HTTP fetch resolve in a single round-trip.
- **Downloader:** continuously long-polls the DO (`action=poll`, `wait_ms=30 000`) and writes whatever bytes arrive to the client.

A shared `closed` event ties them together — either side hitting EOF or a DO-reported `closed: true` tears the whole tunnel down and emits `action=close` so the upstream socket frees promptly.

---

## Current challenges & limitations

- **Google Apps Script rate limits.** The dominant constraint. Free Google accounts get roughly **20 000 `UrlFetchApp` calls/day** and ~6 hours of total script execution time per day. Long-polling is what makes this tunnel feasible at all on the free tier. Heavy use (multiple browsers, video streaming over the SOCKS5 path) **will** hit the daily cap and the tunnel will return errors until the quota resets at midnight Pacific time. Workspace accounts have higher caps. Distributing `script_id` across multiple Google accounts (the original project's "sticky per-host" multi-script feature) helps too.
- **Cloudflare Worker free tier.** 100 000 requests/day per account. Each Apps Script call to the Worker = one request, so the Worker quota is generally easier to hit than the Apps Script quota in *aggregate*, but Workers' Durable-Object compute time billing means very long-lived idle tunnels accumulate GB-seconds. Still well within free-tier comfort for personal use.
- **Latency.** Every roundtrip traverses *Browser → Python → Apps Script → Cloudflare → target → back*. Expect noticeable extra RTT vs. a real VPN. Fine for browsing and SSH; not great for low-latency games.
- **Apps Script execution timeout.** A single `UrlFetchApp` call must finish within ~60 s. We clamp the Worker's `wait_ms` to 45 s so a full Apps Script call always returns cleanly with margin to spare.
- **Per-tunnel parallelism.** Each tunnel uses one Durable Object instance. CF DO concurrency is plentiful but isn't infinite on free tier — many simultaneous tunnels (dozens of browser tabs each opening fresh connections) may approach the limit.

---

## Deployment guide

End-to-end you will deploy three things and connect them with shared secrets:

1. **A Google Apps Script web-app** (HTTP relay + TCP forwarder).
2. **A Cloudflare Worker with a Durable Object** (the persistent TCP socket).
3. **The Python proxy** running locally.

You will need:

- A Google account.
- A Cloudflare account (free tier is enough).
- **Node.js** (for `wrangler`, the Cloudflare CLI).
- **Python 3.10+**.

### Step 1 — Install Node.js (required for `wrangler`)

`wrangler` is the official CLI Cloudflare ships for deploying Workers. It runs on Node.

#### Linux (Debian/Ubuntu/Pop!_OS)

```bash
# Use the NodeSource setup script for an up-to-date Node 20.x:
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version   # should print v20.x.x
npm --version
```

Or via your distro:

```bash
sudo apt-get update && sudo apt-get install -y nodejs npm   # may be older than 20
```

#### Linux (Fedora / RHEL)

```bash
curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
sudo dnf install -y nodejs
```

#### Linux (Arch)

```bash
sudo pacman -S nodejs npm
```

#### macOS

```bash
brew install node
```

(or download from [nodejs.org/en/download](https://nodejs.org/en/download))

#### Windows

Download the LTS installer from [nodejs.org](https://nodejs.org/en/download) and run it. Open a fresh PowerShell after install:

```powershell
node --version
npm --version
```

#### Cross-platform alternative (recommended for managing multiple Node versions): nvm

```bash
# Linux / macOS
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
# Reopen your shell, then:
nvm install --lts
nvm use --lts
```

### Step 2 — Install Wrangler

```bash
npm install -g wrangler
wrangler --version
wrangler login          # opens a browser to authorize your CF account
```

### Step 3 — Pick a strong shared secret

The same `AUTH_KEY` value must appear in **three** places: the Apps Script, the Cloudflare Worker, and `config.json`. Generate one and keep it handy:

```bash
python -c "import secrets; print(secrets.token_hex(32))"
```

### Step 4 — Deploy the Cloudflare Worker (TCP Durable Object)

```bash
git clone https://github.com/JJ-arch/MasterHttpRelayVPN.git
cd MasterHttpRelayVPN/apps_script
```

Edit `wrangler_tcp.toml` and replace the `AUTH_KEY` value under `[vars]` with your shared secret from Step 3. Optionally rename the worker:

```toml
name = "tcp-tunnel"     # → produces https://tcp-tunnel.<your-subdomain>.workers.dev
```

Deploy:

```bash
wrangler deploy --config wrangler_tcp.toml
```

Wrangler will print the deployed URL, e.g. `https://tcp-tunnel.<your-subdomain>.workers.dev`. **Save this URL.**

Sanity check:

```bash
curl https://tcp-tunnel.<your-subdomain>.workers.dev
# {"ok":true,"status":"healthy","role":"tcp_tunnel"}
```

### Step 5 — Deploy the Google Apps Script

1. Open <https://script.google.com> → **New project**.
2. Delete the default code and paste the entire contents of [`apps_script/Code.gs`](apps_script/Code.gs).
3. At the top of the file, set:
   - `AUTH_KEY` → your shared secret from Step 3.
   - `CF_ENDPOINT` → the worker URL from Step 4 (no trailing slash needed; both work).
4. Click **Deploy → New deployment**.
5. Choose:
   - **Type:** Web app
   - **Execute as:** Me
   - **Who has access:** Anyone
6. Click **Deploy** and copy the **Deployment ID** (the long token in the URL after `/exec`/`/dev` — what Google calls the "Web app URL"). Save it; you will paste it into `config.json` next.

If you previously had the old non-TCP Apps Script deployed, you can either edit the existing project (preferred — keeps the same Deployment ID) or create a new deployment.

### Step 6 — Install the Python proxy

From the repo root:

```bash
# Linux / macOS
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# Windows (PowerShell)
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

Copy and edit the config:

```bash
cp config.example.json config.json
```

Set at minimum:

```jsonc
{
  "auth_key": "<your shared secret from Step 3>",
  "script_id": "<Apps Script Deployment ID from Step 5>",
  "listen_port": 8080,
  "socks5_enabled": true,
  "socks5_port": 1080
}
```

(The included config wizard `python setup.py` will walk you through this interactively.)

### Step 7 — Run it

```bash
python main.py
```

You should see lines similar to:

```
Apps Script relay : SNI=www.google.com → script.google.com
HTTP proxy listening on 127.0.0.1:8080
SOCKS5 proxy listening on 127.0.0.1:1080
```

Now configure your browser:

- **HTTPS / HTTP traffic that you want MITM'd through the original relay path:** point HTTP/HTTPS proxy at `127.0.0.1:8080`.
- **Real TCP tunneling (this fork's new feature):** point SOCKS5 proxy at `127.0.0.1:1080`.

For Firefox: *Settings → Network Settings → Manual proxy configuration → SOCKS Host = `127.0.0.1`, Port = `1080`, SOCKS v5*. Tick **Proxy DNS when using SOCKS v5** so DNS leaves through the tunnel as well.

### Step 8 — Verify the TCP path

```bash
# Should fetch through the SOCKS5 → Apps Script → CF DO → real TCP path:
curl -x socks5h://127.0.0.1:1080 https://example.com
```

Then load a TLS site in the browser. You should see logs like:

```
SOCKS5 CONNECT → example.com:443
TCP-tunnel [<id>] → example.com:443 (open)
TCP-tunnel [<id>] closed (up=2048, down=46123)
```

---

## Configuration reference (TCP-relevant fields)

The Python proxy reads `config.json`. Key fields for the TCP path:

| key                 | purpose                                                          |
|---------------------|------------------------------------------------------------------|
| `auth_key`          | shared secret — must match `AUTH_KEY` in `Code.gs` and `wrangler_tcp.toml`. |
| `script_id`         | Apps Script Deployment ID. Can be a list for multi-account spreading. |
| `socks5_enabled`    | `true` to expose the SOCKS5 listener that uses this fork's TCP relay. |
| `socks5_port`       | listening port for SOCKS5 (default `1080`). |
| `front_domain`      | TLS SNI presented to the network (default `www.google.com`).     |
| `google_ip`         | IP to TCP-connect to for the front (auto-scanned via `python main.py --scan`). |
| `tcp_connect_timeout` | seconds to wait when opening the upstream Google TLS leg.        |

Tunnel-specific tunables live as class attributes on `ProxyServer` in [src/proxy/proxy_server.py](src/proxy/proxy_server.py) — `_TUNNEL_UPLOAD_CHUNK`, `_TUNNEL_POLL_LONG_MS`, etc. Defaults are tuned for the free tier; you usually don't need to touch them.

---

## Troubleshooting

**`curl` works but the browser shows "connection closed".**
Almost always the TLS MITM CA isn't trusted, *or* you set the SOCKS5 proxy in the browser but DNS is still going through the system resolver (use **Proxy DNS when using SOCKS v5** in Firefox). Run `python main.py --install-cert` to install the local CA if you want HTTPS-MITM mode too.

**`{"error":"unauthorized"}` returned from Apps Script.**
The three `AUTH_KEY` values are not all identical. Re-check `Code.gs`, `wrangler_tcp.toml` (`[vars] AUTH_KEY`), and `config.json` (`auth_key`).

**`{"error":"cf_status_500"}` or `cf_status_401`.**
Apps Script reached the Worker but got a non-200 back. `401` = `AUTH_KEY` mismatch between Apps Script and Worker. `500` = the Worker logged an exception — check `wrangler tail` for the live error stream.

**Browser hangs on first page load, then loads on retry.**
The DO is cold-starting; subsequent requests hit a warm DO. If it persists, `wrangler tail` will show why.

**`UrlFetchApp` quota exceeded.**
You hit the daily cap on Apps Script. Wait until the next reset (midnight Pacific) or distribute load across multiple `script_id` values from different Google accounts.

---

## Acknowledgements

- Original project: [masterking32/MasterHttpRelayVPN](https://github.com/masterking32/MasterHttpRelayVPN). All HTTP-relay credit, the domain-fronting trick, and the Apps Script base belong to the upstream author.
- This fork adds the TCP data plane (Durable Object, action protocol, concurrent uploader/downloader, long-poll quota model).

---

## Disclaimer

This software is provided **AS IS**, for educational and research purposes only. You are solely responsible for complying with all applicable laws and with the terms of service of Google, Cloudflare, and any other third-party platforms you connect through this tool. Hitting Google Apps Script or Cloudflare quotas may trigger enforcement actions on your account; that risk is yours to evaluate and accept.
