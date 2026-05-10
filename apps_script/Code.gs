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

// Cloudflare Worker that owns the persistent TCP socket per tunnel_id.
// Replace with YOUR worker URL.
const CF_ENDPOINT = "https://tcp-tunnel.jjj288708.workers.dev";

// UrlFetchApp hard-caps execution at ~60s, so a long-poll request to the
// CF Worker must request a wait shorter than that. The Apps Script wrapper
// clamps wait_ms below this ceiling to leave room for transport overhead.
const CF_WAIT_MS_CEILING = 45000;

function doPost(e) {
  var req = JSON.parse(e.postData.contents);
  if (req.k !== AUTH_KEY) return _json({ e: "unauthorized" });

  if (req.tunnel_id || req.action) {
    return _handleTCPTunnel(req);
  }

  if (Array.isArray(req.q)) return _doBatch(req.q);
  return _doSingle(req);
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
// TCP Tunnel Support — thin pass-through to the Cloudflare Worker DO.
//
// All state (the live TCP socket, recv buffer, close flag) lives inside the
// Cloudflare Durable Object keyed by tunnel_id. Apps Script execution is
// stateless across invocations, so it cannot itself hold a persistent socket.
// We forward the action-based JSON unchanged.
// ─────────────────────────────────────────────────────────────────────────────

function _handleTCPTunnel(req) {
  try {
    if (!req.tunnel_id) {
      return _json({ error: "missing tunnel_id" });
    }
    var action = req.action || "send";

    var forward = {
      k: AUTH_KEY,
      tunnel_id: req.tunnel_id,
      action: action,
      target_host: req.target_host,
      target_port: req.target_port,
      data: req.data || "",
      wait_ms: Math.min(CF_WAIT_MS_CEILING, Number(req.wait_ms) || 0),
      max_bytes: Number(req.max_bytes) || 65536,
    };

    var response = UrlFetchApp.fetch(CF_ENDPOINT, {
      method: "post",
      payload: JSON.stringify(forward),
      contentType: "application/json",
      muteHttpExceptions: true,
      followRedirects: true,
    });

    var code = response.getResponseCode();
    var text = response.getContentText();

    if (code !== 200) {
      return _json({
        tunnel_id: req.tunnel_id,
        error: "cf_status_" + code,
        body: text.substring(0, 256),
      });
    }

    // Forward the JSON the worker produced verbatim — it already matches
    // the protocol the Python client speaks.
    try {
      return _json(JSON.parse(text));
    } catch (parseErr) {
      return _json({
        tunnel_id: req.tunnel_id,
        error: "cf_bad_json",
        body: text.substring(0, 256),
      });
    }
  } catch (err) {
    return _json({
      tunnel_id: req.tunnel_id,
      error: String(err && err.message ? err.message : err),
    });
  }
}
