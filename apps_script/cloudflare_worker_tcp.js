// MasterHttpRelay TCP exit node — Cloudflare Worker + Durable Object.
//
// One Durable Object instance per tunnel_id holds a real TCP socket open
// across multiple HTTP requests. A background reader pumps target-server
// bytes into a recv buffer; "send" requests write to the socket and
// "poll" requests long-poll the buffer. This is what lets a browser's
// TLS handshake (multi-roundtrip, stateful) survive the relay.
//
// Protocol — JSON POST to the worker URL:
//   { k, tunnel_id, action: "open"|"send"|"poll"|"close",
//     target_host, target_port,         // open
//     data: "<base64>",                 // send (optional)
//     wait_ms, max_bytes }              // send / poll
//
// Response:
//   { tunnel_id, data: "<base64>", more: bool, closed: bool, error: string|null }

import { connect } from "cloudflare:sockets";

const MAX_RECV_BUFFER = 4 * 1024 * 1024; // 4 MiB cap per tunnel
const DEFAULT_MAX_BYTES = 256 * 1024;
const POLL_TICK_MS = 20;

function bytesToB64(bytes) {
  let s = "";
  // chunk to keep String.fromCharCode arg list small
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export class TcpTunnel {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.socket = null;
    this.writer = null;
    this.reader = null;
    this.recvChunks = [];
    this.recvTotal = 0;
    this.closed = false;
    this.error = null;
    this.target = null;
    this.openedAt = 0;
    this.lastActivity = Date.now();
  }

  _setError(e) {
    if (!this.error) this.error = String(e && e.message ? e.message : e);
    this.closed = true;
  }

  async _open(host, port) {
    if (this.socket || this.closed) return;
    this.target = `${host}:${port}`;
    this.openedAt = Date.now();
    try {
      this.socket = connect(
        { hostname: host, port: Number(port) },
        { allowHalfOpen: false, secureTransport: "off" }
      );
      this.writer = this.socket.writable.getWriter();
      this.reader = this.socket.readable.getReader();
      // Detached background pump — never await.
      this._readLoop();
      // Surface socket-level closure (e.g. RST, peer FIN) into our state.
      this.socket.closed
        .then(() => { this.closed = true; })
        .catch((e) => this._setError(e));
    } catch (e) {
      this._setError(e);
    }
  }

  async _readLoop() {
    try {
      while (!this.closed) {
        const { value, done } = await this.reader.read();
        if (done) { this.closed = true; break; }
        if (!value || value.length === 0) continue;
        // Backpressure: if recv buffer is full, drop the oldest chunk
        // would corrupt the stream — instead, stop pulling and let
        // TCP backpressure naturally apply by NOT calling read() until
        // the buffer drains.
        while (!this.closed && this.recvTotal + value.length > MAX_RECV_BUFFER) {
          await new Promise((r) => setTimeout(r, 25));
        }
        if (this.closed) break;
        this.recvChunks.push(value);
        this.recvTotal += value.length;
      }
    } catch (e) {
      this._setError(e);
    }
  }

  _drain(maxBytes) {
    const limit = maxBytes || DEFAULT_MAX_BYTES;
    if (this.recvChunks.length === 0) return new Uint8Array(0);
    let total = 0;
    const taken = [];
    while (this.recvChunks.length > 0 && total < limit) {
      const head = this.recvChunks[0];
      if (total + head.length <= limit) {
        taken.push(head);
        total += head.length;
        this.recvChunks.shift();
      } else {
        const need = limit - total;
        taken.push(head.subarray(0, need));
        this.recvChunks[0] = head.subarray(need);
        total += need;
        break;
      }
    }
    this.recvTotal -= total;
    if (taken.length === 1) return taken[0];
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of taken) { out.set(c, off); off += c.length; }
    return out;
  }

  async _waitForData(waitMs) {
    if (this.recvChunks.length > 0 || this.closed) return;
    const deadline = Date.now() + Math.max(0, waitMs | 0);
    while (
      Date.now() < deadline &&
      this.recvChunks.length === 0 &&
      !this.closed
    ) {
      const remaining = deadline - Date.now();
      await new Promise((r) =>
        setTimeout(r, Math.min(POLL_TICK_MS, Math.max(1, remaining)))
      );
    }
  }

  async _close() {
    this.closed = true;
    try { await this.writer?.close(); } catch {}
    try { await this.reader?.cancel(); } catch {}
    try { await this.socket?.close(); } catch {}
    this.writer = null;
    this.reader = null;
    this.socket = null;
  }

  _reply(extra = {}) {
    return Response.json({
      tunnel_id: this.state.id.toString(),
      target: this.target,
      closed: this.closed,
      error: this.error,
      buffered: this.recvTotal,
      more: this.recvChunks.length > 0,
      ...extra,
    });
  }

  async fetch(request) {
    let body;
    try { body = await request.json(); }
    catch { return Response.json({ error: "bad_json" }, { status: 400 }); }

    const action = String(body.action || "send");
    const waitMs = Math.min(50000, Math.max(0, Number(body.wait_ms) || 0));
    const maxBytes = Math.min(
      MAX_RECV_BUFFER, Math.max(1024, Number(body.max_bytes) || DEFAULT_MAX_BYTES)
    );
    this.lastActivity = Date.now();

    try {
      if (action === "open") {
        if (!body.target_host || !body.target_port) {
          return Response.json({ error: "missing target" }, { status: 400 });
        }
        await this._open(String(body.target_host), Number(body.target_port));
        // If initial data piggybacks the open, write it immediately.
        if (!this.closed && body.data) {
          try {
            await this.writer.write(b64ToBytes(body.data));
          } catch (e) { this._setError(e); }
        }
        if (waitMs > 0) await this._waitForData(waitMs);
        const out = this._drain(maxBytes);
        return this._reply({ data: out.length ? bytesToB64(out) : "" });
      }

      if (action === "send") {
        if (this.closed && !this.socket) {
          return this._reply({ data: "" });
        }
        if (body.data && this.writer) {
          try { await this.writer.write(b64ToBytes(body.data)); }
          catch (e) { this._setError(e); }
        }
        if (waitMs > 0) await this._waitForData(waitMs);
        const out = this._drain(maxBytes);
        return this._reply({ data: out.length ? bytesToB64(out) : "" });
      }

      if (action === "poll") {
        if (waitMs > 0) await this._waitForData(waitMs);
        const out = this._drain(maxBytes);
        return this._reply({ data: out.length ? bytesToB64(out) : "" });
      }

      if (action === "close") {
        await this._close();
        return this._reply({ data: "" });
      }

      return Response.json({ error: `unknown action: ${action}` }, { status: 400 });
    } catch (e) {
      this._setError(e);
      return this._reply({ data: "" });
    }
  }
}

export default {
  async fetch(request, env) {
    if (request.method === "GET") {
      return Response.json({ ok: true, status: "healthy", role: "tcp_tunnel" });
    }
    if (request.method !== "POST") {
      return Response.json({ error: "method_not_allowed" }, { status: 405 });
    }

    let body;
    try { body = await request.clone().json(); }
    catch { return Response.json({ error: "bad_json" }, { status: 400 }); }

    const expected = env.AUTH_KEY;
    if (expected && body.k !== expected) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    if (!body.tunnel_id) {
      return Response.json({ error: "missing tunnel_id" }, { status: 400 });
    }

    const id = env.TCP_TUNNEL.idFromName(String(body.tunnel_id));
    const stub = env.TCP_TUNNEL.get(id);
    return stub.fetch(request);
  },
};
