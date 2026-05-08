/**
 * MasterHttpRelay — Google Apps Script
 *
 * DEPLOYMENT:
 *   1. Go to https://script.google.com → New project
 *   2. Delete the default code, paste THIS entire file
 *   3. Click Deploy → New deployment
 *   4. Type: Web app  |  Execute as: Me  |  Who has access: Anyone
 *   5. Copy the Deployment ID into config.json as "script_id"
 *
 * CHANGE THE AUTH KEY BELOW TO YOUR OWN SECRET!
 */

const AUTH_KEY = "CHANGE_ME_TO_A_STRONG_SECRET";

// Keep browser capability headers (sec-ch-ua*, sec-fetch-*) intact.
// Some modern apps, notably Google Meet, use them for browser gating.
// Headers that reveal the user's real IP are also stripped here as a
// second line of defence (the Python client strips them first).
const SKIP_HEADERS = {
  host: 1, connection: 1, "content-length": 1,
  "transfer-encoding": 1, "proxy-connection": 1, "proxy-authorization": 1,
  "priority": 1, te: 1,
  // IP-leaking / proxy-metadata headers
  "x-forwarded-for": 1, "x-forwarded-host": 1, "x-forwarded-proto": 1,
  "x-forwarded-port": 1, "x-real-ip": 1, "forwarded": 1, "via": 1,
};

// If fetchAll fails, only retry methods that are safe to replay.
const SAFE_REPLAY_METHODS = { GET: 1, HEAD: 1, OPTIONS: 1 };

// TCP Tunnel Registry: { tunnel_id: { target_host, target_port, buffer, last_activity } }
const TCP_TUNNEL_REGISTRY = {};
const TCP_TUNNEL_TIMEOUT = 10 * 60 * 1000;  // 10 minutes

function doPost(e) {
  try {
    var req = JSON.parse(e.postData.contents);
    if (req.k !== AUTH_KEY) return _json({ e: "unauthorized" });

    // TCP Tunnel mode: { k, tunnel_id, target_host, target_port, data }
    if (req.tunnel_id) {
      return _handleTCPTunnel(req);
    }

    // Batch mode: { k, q: [...] }
    if (Array.isArray(req.q)) return _doBatch(req.q);

    // Single mode
    return _doSingle(req);
  } catch (err) {
    return _json({ e: String(err) });
  }
}

function _doSingle(req) {
  if (!req.u || typeof req.u !== "string" || !req.u.match(/^https?:\/\//i)) {
    return _json({ e: "bad url" });
  }
  var opts = _buildOpts(req);
  var resp = UrlFetchApp.fetch(req.u, opts);
  return _json({
    s: resp.getResponseCode(),
    h: _respHeaders(resp),
    b: Utilities.base64Encode(resp.getContent()),
  });
}

function _doBatch(items) {
  var fetchArgs = [];
  var fetchIndex = [];
  var fetchMethods = [];
  var errorMap = {};

  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    if (!item || typeof item !== "object") {
      errorMap[i] = "bad item";
      continue;
    }
    if (!item.u || typeof item.u !== "string" || !item.u.match(/^https?:\/\//i)) {
      errorMap[i] = "bad url";
      continue;
    }
    try {
      var opts = _buildOpts(item);
      opts.url = item.u;
      fetchArgs.push(opts);
      fetchIndex.push(i);
      fetchMethods.push(String(item.m || "GET").toUpperCase());
    } catch (err) {
      errorMap[i] = String(err);
    }
  }

  // fetchAll() processes all requests in parallel inside Google
  var responses = [];
  if (fetchArgs.length > 0) {
    try {
      responses = UrlFetchApp.fetchAll(fetchArgs);
    } catch (err) {
      // If fetchAll fails as a whole, degrade to per-item fetch so one bad
      // request does not poison the full batch.
      responses = [];
      for (var j = 0; j < fetchArgs.length; j++) {
        try {
          if (!SAFE_REPLAY_METHODS[fetchMethods[j]]) {
            errorMap[fetchIndex[j]] = "batch fetchAll failed; unsafe method not replayed";
            responses[j] = null;
            continue;
          }
          var fallbackReq = fetchArgs[j];
          var fallbackUrl = fallbackReq.url;
          var fallbackOpts = {};
          for (var key in fallbackReq) {
            if (Object.prototype.hasOwnProperty.call(fallbackReq, key) && key !== "url") {
              fallbackOpts[key] = fallbackReq[key];
            }
          }
          responses[j] = UrlFetchApp.fetch(fallbackUrl, fallbackOpts);
        } catch (singleErr) {
          errorMap[fetchIndex[j]] = String(singleErr);
          responses[j] = null;
        }
      }
    }
  }

  var results = [];
  var rIdx = 0;
  for (var i = 0; i < items.length; i++) {
    if (Object.prototype.hasOwnProperty.call(errorMap, i)) {
      results.push({ e: errorMap[i] });
    } else {
      var resp = responses[rIdx++];
      if (!resp) {
        results.push({ e: "fetch failed" });
      } else {
        results.push({
          s: resp.getResponseCode(),
          h: _respHeaders(resp),
          b: Utilities.base64Encode(resp.getContent()),
        });
      }
    }
  }
  return _json({ q: results });
}

function _buildOpts(req) {
  var opts = {
    method: (req.m || "GET").toLowerCase(),
    muteHttpExceptions: true,
    followRedirects: req.r !== false,
    validateHttpsCertificates: true,
    escaping: false,
  };
  if (req.h && typeof req.h === "object") {
    var headers = {};
    for (var k in req.h) {
      if (req.h.hasOwnProperty(k) && !SKIP_HEADERS[k.toLowerCase()]) {
        headers[k] = req.h[k];
      }
    }
    opts.headers = headers;
  }
  if (req.b) {
    opts.payload = Utilities.base64Decode(req.b);
    if (req.ct) opts.contentType = req.ct;
  }
  return opts;
}

function _respHeaders(resp) {
  try {
    if (typeof resp.getAllHeaders === "function") {
      return resp.getAllHeaders();
    }
  } catch (err) {}
  return resp.getHeaders();
}

function doGet(e) {
  return HtmlService.createHtmlOutput(
    "<!DOCTYPE html><html><head><title>My App</title></head>" +
      '<body style="font-family:sans-serif;max-width:600px;margin:40px auto">' +
      "<h1>Welcome</h1><p>This application is running normally.</p>" +
      "</body></html>"
  );
}

function _json(obj) {
  // HtmlService responses can stay on script.google.com for /dev, while
  // ContentService commonly bounces through script.googleusercontent.com.
  // The Python client extracts the JSON payload from the body either way.
  return HtmlService.createHtmlOutput(JSON.stringify(obj)).setXFrameOptionsMode(
    HtmlService.XFrameOptionsMode.ALLOWALL
  );
}


// ─────────────────────────────────────────────────────────────────────────────
// TCP Tunnel Support
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Handle TCP tunnel relay requests.
 * 
 * Request format:
 * {
 *   k: AUTH_KEY,
 *   tunnel_id: "unique-tunnel-id",
 *   target_host: "example.com" or "ssh.example.com",
 *   target_port: 22,
 *   data: "base64-encoded-tcp-data"
 * }
 * 
 * Response format:
 * {
 *   tunnel_id: "...",
 *   status: "ok",
 *   data: "base64-encoded-response-data",
 *   error: "error message if failed"
 * }
 */
function _handleTCPTunnel(req) {
  try {
    const tunnel_id = req.tunnel_id;
    const target_host = req.target_host;
    const target_port = req.target_port || 22;
    const data = req.data ? Utilities.base64Decode(req.data) : [];
    
    if (!tunnel_id || !target_host) {
      return _json({
        tunnel_id: tunnel_id,
        error: "Missing tunnel_id or target_host"
      });
    }
    
    // Get or create tunnel entry
    let tunnel = TCP_TUNNEL_REGISTRY[tunnel_id];
    if (!tunnel) {
      tunnel = {
        target_host: target_host,
        target_port: target_port,
        created_at: new Date().getTime(),
        last_activity: new Date().getTime(),
        send_buffer: [],
        recv_buffer: [],
        bytes_sent: 0,
        bytes_received: 0
      };
      TCP_TUNNEL_REGISTRY[tunnel_id] = tunnel;
      Logger.log(`[TCP] Created tunnel ${tunnel_id} to ${target_host}:${target_port}`);
    }
    
    tunnel.last_activity = new Date().getTime();
    
    // Clean expired tunnels
    _cleanupExpiredTunnels();
    
    // If we have data to send, buffer it
    if (data && data.length > 0) {
      tunnel.send_buffer.push(data);
      tunnel.bytes_sent += data.length;
    }
    
    // Attempt to relay through exit node
    let response_data = _relayTCPData(tunnel_id, tunnel);
    
    // Response
    const response = {
      tunnel_id: tunnel_id,
      status: "ok",
      bytes_sent: tunnel.bytes_sent,
      bytes_received: tunnel.bytes_received,
      tunnel_uptime_ms: new Date().getTime() - tunnel.created_at
    };
    
    if (response_data && response_data.length > 0) {
      response.data = Utilities.base64Encode(response_data);
      tunnel.bytes_received += response_data.length;
    }
    
    return _json(response);
    
  } catch (err) {
    Logger.log(`[TCP] Error: ${err}`);
    return _json({
      tunnel_id: req.tunnel_id,
      error: String(err)
    });
  }
}


/**
 * Relay TCP data to target server.
 * This is where you'd implement the actual TCP connection logic.
 * For now, we'll use a VPS exit node via HTTP POST.
 */
function _relayTCPData(tunnel_id, tunnel) {
  try {
    // Get configuration
    const vps_endpoint = PropertiesService.getUserProperties().getProperty("VPS_EXIT_NODE_URL");
    const test_mode = PropertiesService.getUserProperties().getProperty("TCP_TUNNEL_TEST_MODE") === "true";
    
    // Test mode: echo back the data for testing
    if (test_mode && tunnel.target_host === "127.0.0.1" && tunnel.target_port === 22) {
      Logger.log(`[TCP] Test mode: echoing data back for ${tunnel.target_host}:${tunnel.target_port}`);
      if (tunnel.send_buffer.length > 0) {
        const data = tunnel.send_buffer[0];
        tunnel.send_buffer.shift();
        // Echo with a simple SSH banner prefix for testing
        return Utilities.base64Decode("U1NILTIuMC1PcGVuU1NI");  // "SSH-2.0-OpenSSH" in base64
      }
      return [];
    }
    
    if (vps_endpoint) {
      // Relay through VPS
      const payload = {
        tunnel_id: tunnel_id,
        target_host: tunnel.target_host,
        target_port: tunnel.target_port,
        data: tunnel.send_buffer.length > 0 ? Utilities.base64Encode(tunnel.send_buffer[0]) : ""
      };
      
      const options = {
        method: "post",
        payload: JSON.stringify(payload),
        contentType: "application/json",
        muteHttpExceptions: true,
        timeout: 5
      };
      
      const response = UrlFetchApp.fetch(vps_endpoint, options);
      
      if (response.getResponseCode() === 200) {
        const result = JSON.parse(response.getContentText());
        if (result.data) {
          tunnel.send_buffer.shift();  // Remove sent data
          return Utilities.base64Decode(result.data);
        }
      }
    }
    
    // No VPS configured and not in test mode - return empty
    Logger.log(`[TCP] No VPS endpoint configured for ${tunnel.target_host}:${tunnel.target_port}`);
    return [];
    
  } catch (err) {
    Logger.log(`[TCP] Relay error: ${err}`);
    return [];
  }
}


/**
 * Clean up expired TCP tunnels (idle for more than timeout period)
 */
function _cleanupExpiredTunnels() {
  try {
    const now = new Date().getTime();
    const expired = [];
    
    for (const tunnel_id in TCP_TUNNEL_REGISTRY) {
      const tunnel = TCP_TUNNEL_REGISTRY[tunnel_id];
      if (now - tunnel.last_activity > TCP_TUNNEL_TIMEOUT) {
        expired.push(tunnel_id);
      }
    }
    
    for (const tunnel_id of expired) {
      const tunnel = TCP_TUNNEL_REGISTRY[tunnel_id];
      Logger.log(`[TCP] Cleaning up tunnel ${tunnel_id} after ${new Date().getTime() - tunnel.created_at}ms`);
      delete TCP_TUNNEL_REGISTRY[tunnel_id];
    }
    
  } catch (err) {
    Logger.log(`[TCP] Cleanup error: ${err}`);
  }
}


/**
 * Get TCP tunnel statistics (for debugging)
 */
function _getTCPStats() {
  const stats = {
    active_tunnels: Object.keys(TCP_TUNNEL_REGISTRY).length,
    tunnels: {}
  };
  
  for (const tunnel_id in TCP_TUNNEL_REGISTRY) {
    const tunnel = TCP_TUNNEL_REGISTRY[tunnel_id];
    stats.tunnels[tunnel_id] = {
      target: `${tunnel.target_host}:${tunnel.target_port}`,
      uptime_ms: new Date().getTime() - tunnel.created_at,
      bytes_sent: tunnel.bytes_sent,
      bytes_received: tunnel.bytes_received
    };
  }
  
  return stats;
}

