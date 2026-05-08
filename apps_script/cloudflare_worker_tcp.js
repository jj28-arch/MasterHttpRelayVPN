/**
 * Cloudflare Worker - TCP Relay with WebSocket Support
 * 
 * Deploy to: https://dash.cloudflare.com/
 * 
 * This worker:
 * 1. Accepts WebSocket connections from local proxy
 * 2. Relays TCP data to target servers
 * 3. Handles multiple concurrent tunnels
 * 4. Routes back through Google Apps Script if needed
 * 
 * Environment Variables (set in Cloudflare Dashboard):
 * - APPS_SCRIPT_DEPLOYMENT_URL: Google Apps Script deployment URL
 * - AUTH_TOKEN: Authentication token for requests
 * - PSK: Pre-shared key for security
 */

const AUTH_TOKEN = "your-auth-token-here";
const PSK = "your-psk-here";
const APPS_SCRIPT_URL = "https://script.google.com/macros/d/YOUR_DEPLOYMENT_ID/usercallback";

// Tunnel registry: Map of tunnel_id -> {ws, target_host, target_port, tcp_buffer}
const activeTunnels = new Map();


// ─────────────────────────────────────────────────────────────────────────────
// Main Worker Handler
// ─────────────────────────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    // Handle WebSocket upgrades
    if (request.headers.get("Upgrade") === "websocket") {
      return handleWebSocket(request, env, ctx);
    }
    
    // Handle HTTP POST for Apps Script relay (fallback)
    if (request.method === "POST") {
      return handleAppScriptRelay(request, env, ctx);
    }
    
    // Health check
    return new Response(JSON.stringify({
      status: "healthy",
      activeTunnels: activeTunnels.size
    }), {
      headers: { "Content-Type": "application/json" }
    });
  }
};


// ─────────────────────────────────────────────────────────────────────────────
// WebSocket Handler
// ─────────────────────────────────────────────────────────────────────────────

async function handleWebSocket(request, env, ctx) {
  // Validate authentication
  const authHeader = request.headers.get("Authorization");
  if (authHeader !== `Bearer ${AUTH_TOKEN}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  
  // Extract tunnel parameters from query string
  const url = new URL(request.url);
  const tunnelId = url.searchParams.get("tunnel_id");
  const targetHost = url.searchParams.get("host");
  const targetPort = parseInt(url.searchParams.get("port") || "22");
  
  if (!tunnelId || !targetHost) {
    return new Response("Missing tunnel_id or host", { status: 400 });
  }
  
  // Upgrade connection to WebSocket
  const pair = new WebSocketPair();
  const client = pair[1];
  const server = pair[0];
  
  // Accept the connection
  server.accept();
  
  // Register tunnel
  const tunnel = {
    id: tunnelId,
    target_host: targetHost,
    target_port: targetPort,
    ws: server,
    created_at: Date.now(),
    last_activity: Date.now(),
    bytes_sent: 0,
    bytes_received: 0,
    closed: false
  };
  
  activeTunnels.set(tunnelId, tunnel);
  
  console.log(`[${tunnelId}] WebSocket connected - Target: ${targetHost}:${targetPort}`);
  
  // Handle WebSocket messages
  server.addEventListener("message", async (event) => {
    try {
      await handleWebSocketMessage(tunnelId, event.data, env);
    } catch (err) {
      console.error(`[${tunnelId}] Message handler error:`, err);
      server.close(1011, err.message);
    }
  });
  
  server.addEventListener("close", () => {
    console.log(`[${tunnelId}] WebSocket closed`);
    activeTunnels.delete(tunnelId);
  });
  
  server.addEventListener("error", (event) => {
    console.error(`[${tunnelId}] WebSocket error:`, event);
    activeTunnels.delete(tunnelId);
  });
  
  return new Response(client, { status: 101, statusText: "Switching Protocols" });
}


// ─────────────────────────────────────────────────────────────────────────────
// WebSocket Message Handler
// ─────────────────────────────────────────────────────────────────────────────

async function handleWebSocketMessage(tunnelId, data, env) {
  const tunnel = activeTunnels.get(tunnelId);
  if (!tunnel) {
    console.warn(`[${tunnelId}] Tunnel not found`);
    return;
  }
  
  tunnel.last_activity = Date.now();
  
  // Handle different message types
  if (typeof data === "string") {
    // JSON control message
    const msg = JSON.parse(data);
    
    if (msg.type === "ping") {
      tunnel.ws.send(JSON.stringify({ type: "pong" }));
    } else if (msg.type === "close") {
      tunnel.ws.close(1000, "Client closed");
      activeTunnels.delete(tunnelId);
    } else if (msg.type === "stats") {
      tunnel.ws.send(JSON.stringify({
        type: "stats",
        bytes_sent: tunnel.bytes_sent,
        bytes_received: tunnel.bytes_received,
        uptime_ms: Date.now() - tunnel.created_at
      }));
    }
  } else {
    // Binary data - relay to target server
    await relayToTarget(tunnelId, data, env);
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// Target Server Relay
// ─────────────────────────────────────────────────────────────────────────────

async function relayToTarget(tunnelId, data, env) {
  const tunnel = activeTunnels.get(tunnelId);
  if (!tunnel) return;
  
  try {
    // Use Cloudflare's durable objects for persistent TCP connections
    // Or fallback to Apps Script for actual TCP relay
    
    const response = await relayViaAppsScript(tunnelId, tunnel, data, env);
    
    if (response) {
      tunnel.bytes_sent += data.byteLength;
      tunnel.bytes_received += response.byteLength;
      
      // Send response back to client
      tunnel.ws.send(response);
    }
  } catch (err) {
    console.error(`[${tunnelId}] Relay error:`, err);
    tunnel.ws.send(JSON.stringify({
      type: "error",
      message: err.message
    }));
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// Apps Script Relay (for actual TCP connection)
// ─────────────────────────────────────────────────────────────────────────────

async function relayViaAppsScript(tunnelId, tunnel, data, env) {
  const payload = {
    k: env.AUTH_KEY,  // Must match Apps Script AUTH_KEY
    tunnel_id: tunnelId,
    target_host: tunnel.target_host,
    target_port: tunnel.target_port,
    data: btoa(String.fromCharCode(...new Uint8Array(data)))  // Base64 encode
  };
  
  try {
    const response = await fetch(APPS_SCRIPT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Cloudflare-Worker/1.0"
      },
      body: JSON.stringify(payload),
      timeout: 10000
    });
    
    if (!response.ok) {
      throw new Error(`Apps Script error: ${response.status}`);
    }
    
    const result = await response.json();
    
    if (result.error) {
      throw new Error(result.error);
    }
    
    // Decode base64 response
    if (result.data) {
      const binaryString = atob(result.data);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      return bytes;
    }
    
    return null;
  } catch (err) {
    console.error(`[${tunnelId}] Apps Script relay error:`, err);
    throw err;
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// HTTP POST Handler (for polling-based clients)
// ─────────────────────────────────────────────────────────────────────────────

async function handleAppScriptRelay(request, env, ctx) {
  try {
    const payload = await request.json();
    
    // Validate auth
    if (payload.k !== env.AUTH_KEY) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" }
      });
    }
    
    const tunnelId = payload.tunnel_id;
    const data = Uint8Array.from(atob(payload.data), c => c.charCodeAt(0));
    
    // Get or create tunnel entry
    let tunnel = activeTunnels.get(tunnelId);
    if (!tunnel) {
      tunnel = {
        id: tunnelId,
        target_host: payload.target_host,
        target_port: payload.target_port,
        ws: null,
        created_at: Date.now(),
        last_activity: Date.now(),
        buffer: [],
        closed: false
      };
      activeTunnels.set(tunnelId, tunnel);
    }
    
    tunnel.last_activity = Date.now();
    
    // Buffer incoming data
    if (data.length > 0) {
      tunnel.buffer.push(data);
    }
    
    // Relay via Apps Script
    const response = await relayViaAppsScript(tunnelId, tunnel, data, env);
    
    return new Response(JSON.stringify({
      tunnel_id: tunnelId,
      status: "ok",
      data: response ? btoa(String.fromCharCode(...response)) : ""
    }), {
      headers: { "Content-Type": "application/json" }
    });
  
  } catch (err) {
    console.error("Handler error:", err);
    return new Response(JSON.stringify({
      error: err.message
    }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// Durable Object for persistent TCP connections (Advanced)
// ─────────────────────────────────────────────────────────────────────────────

export class TCPConnectionDurable {
  /**
   * Durable Object to maintain persistent TCP connections.
   * 
   * This is optional but recommended for better performance.
   * Allows Cloudflare to keep connections alive longer.
   */
  
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.target_host = null;
    this.target_port = null;
    this.connected = false;
  }
  
  async fetch(request) {
    const url = new URL(request.url);
    
    if (url.pathname === "/connect") {
      return this.handleConnect(request);
    } else if (url.pathname === "/relay") {
      return this.handleRelay(request);
    } else if (url.pathname === "/close") {
      return this.handleClose(request);
    }
    
    return new Response("Not found", { status: 404 });
  }
  
  async handleConnect(request) {
    const { target_host, target_port } = await request.json();
    
    this.target_host = target_host;
    this.target_port = target_port;
    this.connected = true;
    
    console.log(`[Durable] Connecting to ${target_host}:${target_port}`);
    
    return new Response(JSON.stringify({
      status: "connected",
      target: `${target_host}:${target_port}`
    }), {
      headers: { "Content-Type": "application/json" }
    });
  }
  
  async handleRelay(request) {
    if (!this.connected) {
      return new Response(JSON.stringify({ error: "Not connected" }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }
    
    const data = await request.arrayBuffer();
    
    // Relay through Apps Script
    const response = await fetch(APPS_SCRIPT_URL, {
      method: "POST",
      body: JSON.stringify({
        k: this.env.AUTH_KEY,
        target_host: this.target_host,
        target_port: this.target_port,
        data: btoa(String.fromCharCode(...new Uint8Array(data)))
      })
    });
    
    const result = await response.json();
    
    return new Response(JSON.stringify({
      status: "ok",
      data: result.data || ""
    }), {
      headers: { "Content-Type": "application/json" }
    });
  }
  
  async handleClose(request) {
    this.connected = false;
    return new Response(JSON.stringify({
      status: "closed"
    }), {
      headers: { "Content-Type": "application/json" }
    });
  }
}
