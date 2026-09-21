const http = require("http");
const https = require("https");
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { URL } = require("url");
const qrcode = require("qrcode-terminal");
const { Bonjour } = require("bonjour-service");
const { WebSocketServer } = require("ws");
const selfsigned = require("selfsigned");

const PORT = Number(process.env.PORT) || 8080;
const HTTPS_PORT = Number(process.env.HTTPS_PORT) || 8443;
const HOST = process.env.HOST || "0.0.0.0";
const SHARED_DIR = path.join(__dirname, "shared");
const INDEX_FILE = path.join(__dirname, "public", "index.html");
const ACCESS_CODE = process.env.ACCESS_CODE || crypto.randomBytes(3).toString("hex").toUpperCase();
const MAX_FILE_SIZE = 5 * 1024 * 1024 * 1024;
const SESSION_MAX_AGE = 8 * 60 * 60 * 1000;
const HOTSPOT_ADDRESS = process.env.HOTSPOT_ADDRESS || "192.168.137.1";
const SERVICE_NAME = process.env.SERVICE_NAME || "Send-it-easy";
const HOSTNAME_BASE = process.env.LOCAL_HOSTNAME || os.hostname();
const LOCAL_HOSTNAME = `${HOSTNAME_BASE.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "") || "send-it-easy"}.local`;
const sessions = new Map();
const screenClients = new Map();
let screenHost = null;

fs.mkdirSync(SHARED_DIR, { recursive: true });

function getLocalAddresses() {
  const addresses = [];
  for (const interfaces of Object.values(os.networkInterfaces())) {
    for (const network of interfaces || []) {
      if (network.family === "IPv4" && !network.internal) {
        addresses.push(network.address);
      }
    }
  }
  return addresses;
}

function getNetworkSummary() {
  return Object.entries(os.networkInterfaces()).flatMap(([name, interfaces]) =>
    (interfaces || [])
      .filter((network) => network.family === "IPv4" && !network.internal)
      .map((network) => ({
        interface: name,
        address: network.address,
        netmask: network.netmask
      }))
  );
}

function printNetworkSummary() {
  console.log("\nNetwork interfaces:");
  const interfaces = getNetworkSummary();
  if (!interfaces.length) {
    console.log("  No non-loopback IPv4 interfaces detected.");
  } else {
    for (const network of interfaces) {
      console.log(`  ${describeAddress(network.address)} | ${network.interface} | ${network.address} | mask ${network.netmask}`);
    }
  }

  if (process.platform !== "win32") {
    console.log("\nConnected-device table: available through the operating system's network tools.");
    return;
  }
  try {
    const arpOutput = execFileSync("arp", ["-a"], { encoding: "utf8", windowsHide: true });
    console.log("\nDevices visible in Windows ARP table:");
    console.log(arpOutput.trim() || "  No devices are currently visible.");
  } catch (error) {
    console.error(`\nCould not read the Windows ARP table: ${error.message}`);
  }
}

function describeAddress(address) {
  if (address.startsWith("192.168.137.")) return "Windows hotspot";
  if (address.startsWith("192.168.")) return "Wi-Fi/LAN";
  return "Local network";
}

function printConnection(address, label) {
  const url = `http://${address}:${PORT}`;
  console.log(`${label}: ${url}`);
  qrcode.generate(url, { small: true });
}

function printSecureConnection(address, label) {
  const url = `https://${address}:${HTTPS_PORT}`;
  console.log(`Secure screen sharing: ${url}`);
  qrcode.generate(url, { small: true });
}

function printFriendlyConnection() {
  const url = `http://${LOCAL_HOSTNAME}:${PORT}`;
  console.log(`Friendly address (mDNS, if supported): ${url}`);
  qrcode.generate(url, { small: true });
}

if (process.argv.includes("--list-networks")) {
  printNetworkSummary();
  process.exit(0);
}

function getSession(request) {
  return Boolean(getSessionToken(request));
}

function getSessionToken(request) {
  const cookie = request.headers.cookie || "";
  const token = cookie.split(";").map((part) => part.trim())
    .find((part) => part.startsWith("send_it_easy_session="))
    ?.split("=")[1];
  if (!token || !sessions.has(token)) return null;
  const expiresAt = sessions.get(token);
  if (expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  return token;
}

function isHostSession(request) {
  return getSession(request) && (request.headers.cookie || "").includes("send_it_easy_host=1");
}

function isLoopback(request) {
  return ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress);
}

function isLocalMachineRequest(request) {
  const remoteAddress = request.socket.remoteAddress?.replace(/^::ffff:/, "");
  return isLoopback(request) || getLocalAddresses().includes(remoteAddress);
}

function codesMatch(value) {
  const received = Buffer.from(String(value || ""));
  const expected = Buffer.from(ACCESS_CODE);
  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}

function sendJson(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store"
  });
  response.end(body);
}

function safeFileName(value) {
  const name = path.basename(String(value || "file"));
  const cleaned = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim();
  return cleaned || "file";
}

function uniquePath(fileName) {
  const extension = path.extname(fileName);
  const stem = path.basename(fileName, extension);
  let candidate = path.join(SHARED_DIR, fileName);
  let index = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(SHARED_DIR, `${stem} (${index})${extension}`);
    index += 1;
  }
  return candidate;
}

function listFiles() {
  return fs.readdirSync(SHARED_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name !== ".gitkeep")
    .map((entry) => {
      const filePath = path.join(SHARED_DIR, entry.name);
      const stats = fs.statSync(filePath);
      return {
        name: entry.name,
        size: stats.size,
        modified: stats.mtime.toISOString()
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function serveIndex(response) {
  fs.createReadStream(INDEX_FILE)
    .on("error", () => sendJson(response, 500, { error: "Unable to load the web interface." }))
    .once("open", () => {
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store"
      });
    })
    .pipe(response);
}

function handleUpload(request, response, url) {
  const requestedName = safeFileName(url.searchParams.get("filename"));
  const destination = uniquePath(requestedName);
  const writeStream = fs.createWriteStream(destination, { flags: "wx" });
  let bytes = 0;
  let failed = false;

  request.on("data", (chunk) => {
    bytes += chunk.length;
    if (bytes > MAX_FILE_SIZE && !failed) {
      failed = true;
      writeStream.destroy();
      request.resume();
      fs.rm(destination, { force: true }, () => {
        sendJson(response, 413, { error: "Files must be 5 GB or smaller." });
      });
      return;
    }
    if (!failed && !writeStream.write(chunk)) request.pause();
  });
  writeStream.on("drain", () => request.resume());
  request.on("end", () => {
    if (failed) return;
    writeStream.end(() => sendJson(response, 201, {
      name: path.basename(destination),
      size: bytes
    }));
  });
  request.on("error", () => {
    if (!failed) {
      failed = true;
      writeStream.destroy();
      fs.rm(destination, { force: true }, () => sendJson(response, 500, { error: "The upload was interrupted." }));
    }
  });
  writeStream.on("error", (error) => {
    if (!failed) {
      failed = true;
      request.destroy();
      fs.rm(destination, { force: true }, () => {
        const status = error.code === "ENOSPC" ? 507 : 500;
        sendJson(response, status, { error: "The file could not be saved." });
      });
    }
  });
}

function handleRequest(request, response) {
  const protocol = request.socket.encrypted ? "https" : "http";
  const url = new URL(request.url, `${protocol}://${request.headers.host || "localhost"}`);

  if (request.method === "GET" && url.pathname === "/") {
    serveIndex(response);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/login") {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      let payload;
      try {
        payload = JSON.parse(body);
      } catch {
        sendJson(response, 400, { error: "Invalid login request." });
        return;
      }
      if (!codesMatch(payload.code)) {
        sendJson(response, 401, { error: "That access code is incorrect." });
        return;
      }
      const token = crypto.randomBytes(32).toString("hex");
      sessions.set(token, Date.now() + SESSION_MAX_AGE);
      response.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Set-Cookie": `send_it_easy_session=${token}; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MAX_AGE / 1000}; Path=/`,
        "Cache-Control": "no-store"
      });
      response.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/logout") {
    const cookie = request.headers.cookie || "";
    const token = cookie.split(";").map((part) => part.trim())
      .find((part) => part.startsWith("send_it_easy_session="))
      ?.split("=")[1];
    if (token) sessions.delete(token);
    response.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Set-Cookie": "send_it_easy_session=; HttpOnly; SameSite=Strict; Max-Age=0; Path=/",
      "Cache-Control": "no-store"
    });
    response.end(JSON.stringify({ ok: true }));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/host-session") {
    if (!getSession(request) || !isLocalMachineRequest(request)) {
      sendJson(response, 403, { error: "Host controls are available only on the host computer." });
      return;
    }
    response.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Set-Cookie": "send_it_easy_host=1; HttpOnly; SameSite=Strict; Max-Age=28800; Path=/",
      "Cache-Control": "no-store"
    });
    response.end(JSON.stringify({ ok: true }));
    return;
  }

  if (!getSession(request)) {
    sendJson(response, 401, { error: "Enter the access code shown on the host computer." });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/files") {
    sendJson(response, 200, { files: listFiles() });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/upload") {
    handleUpload(request, response, url);
    return;
  }

  if (request.method === "GET" && url.pathname.startsWith("/download/")) {
    const requestedName = safeFileName(decodeURIComponent(url.pathname.slice("/download/".length)));
    const filePath = path.join(SHARED_DIR, requestedName);
    if (!filePath.startsWith(`${SHARED_DIR}${path.sep}`) || !fs.existsSync(filePath)) {
      sendJson(response, 404, { error: "File not found." });
      return;
    }
    response.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${requestedName.replace(/"/g, "")}"`,
      "Content-Length": fs.statSync(filePath).size
    });
    fs.createReadStream(filePath).pipe(response);
    return;
  }

  sendJson(response, 404, { error: "Not found." });
}

const server = http.createServer(handleRequest);
const certificate = selfsigned.generate(
  [{ name: "commonName", value: "send-it-easy.local" }],
  {
    days: 30,
    keySize: 2048,
    algorithm: "sha256",
    extensions: [
      { name: "basicConstraints", cA: false },
      { name: "subjectAltName", altNames: [
        { type: 2, value: "send-it-easy.local" },
        { type: 2, value: "localhost" },
        ...getLocalAddresses().map((address) => ({ type: 7, ip: address })),
        { type: 7, ip: HOTSPOT_ADDRESS }
      ] }
    ]
  }
);
const secureServer = https.createServer({ key: certificate.private, cert: certificate.cert }, handleRequest);
const screenWss = new WebSocketServer({ noServer: true });

function attachScreenWebSocket(targetServer) {
  targetServer.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url, `${request.socket.encrypted ? "https" : "http"}://${request.headers.host || "localhost"}`);
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    screenWss.handleUpgrade(request, socket, head, (websocket) => {
      screenWss.emit("connection", websocket, request);
    });
  });
}

function sendSocket(socket, message) {
  if (socket.readyState === 1) socket.send(JSON.stringify(message));
}

function closeScreenClient(socket) {
  const client = screenClients.get(socket);
  if (!client) return;
  screenClients.delete(socket);
  if (client.role === "viewer" && screenHost) {
    sendSocket(screenHost, { type: "viewer-disconnected", viewerId: client.id });
  }
  if (client.role === "host" && screenHost === socket) {
    screenHost = null;
    for (const viewer of screenClients.values()) {
      if (viewer.role === "viewer") sendSocket(viewer.socket, { type: "screen-ended" });
    }
  }
}

screenWss.on("connection", (socket, request) => {
  const token = getSessionToken(request);
  if (!token) {
    socket.close(1008, "Login required");
    return;
  }
  const role = isHostSession(request) ? "host" : "viewer";
  const client = { socket, role, id: crypto.randomBytes(6).toString("hex") };
  screenClients.set(socket, client);
  if (role === "host") screenHost = socket;
  sendSocket(socket, { type: "connected", role, id: client.id });
  if (role === "viewer" && screenHost && screenHost !== socket) {
    sendSocket(screenHost, { type: "viewer-connected", viewerId: client.id });
  } else if (role === "host") {
    for (const existing of screenClients.values()) {
      if (existing.role === "viewer") sendSocket(socket, { type: "viewer-connected", viewerId: existing.id });
    }
  }

  socket.on("message", (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (message.type === "request-viewer" && role === "viewer" && screenHost) {
      sendSocket(screenHost, { type: "viewer-request", viewerId: client.id });
      return;
    }
    if (message.type === "request-viewer-screen" && role === "host") {
      const viewer = [...screenClients.values()].find((item) => item.id === message.viewerId && item.role === "viewer");
      if (viewer) sendSocket(viewer.socket, { type: "host-screen-request", viewerId: viewer.id });
      return;
    }
    if (message.type === "viewer-screen-approved" && role === "viewer" && screenHost) {
      sendSocket(screenHost, { type: "viewer-screen-approved", viewerId: client.id });
      return;
    }
    if (message.type === "viewer-screen-denied" && role === "viewer" && screenHost) {
      sendSocket(screenHost, { type: "viewer-screen-denied", viewerId: client.id });
      return;
    }
    if (message.type === "approve-viewer" && role === "host") {
      const viewer = [...screenClients.values()].find((item) => item.id === message.viewerId && item.role === "viewer");
      if (viewer) sendSocket(viewer.socket, { type: "viewer-approved" });
      return;
    }
    if (message.type === "deny-viewer" && role === "host") {
      const viewer = [...screenClients.values()].find((item) => item.id === message.viewerId && item.role === "viewer");
      if (viewer) sendSocket(viewer.socket, { type: "viewer-denied" });
      return;
    }
    if (message.type === "signal" && (role === "host" || role === "viewer")) {
      if (role === "viewer" && screenHost) {
        sendSocket(screenHost, { type: "signal", viewerId: client.id, channel: message.channel || "host-screen", data: message.data });
      } else if (role === "host") {
        const viewer = [...screenClients.values()].find((item) => item.id === message.viewerId);
        if (viewer) sendSocket(viewer.socket, { type: "signal", channel: message.channel || "host-screen", data: message.data });
      }
      return;
    }
    if (message.type === "screen-ended" && role === "host") {
      for (const viewer of screenClients.values()) {
        if (viewer.role === "viewer") sendSocket(viewer.socket, { type: "screen-ended" });
      }
    }
    if (message.type === "screen-ended" && role === "viewer" && screenHost) {
      sendSocket(screenHost, { type: "reverse-screen-ended", viewerId: client.id });
    }
  });
  socket.on("close", () => closeScreenClient(socket));
  socket.on("error", () => closeScreenClient(socket));
});

attachScreenWebSocket(server);
attachScreenWebSocket(secureServer);

server.listen(PORT, HOST);
secureServer.listen(HTTPS_PORT, HOST, () => {
  const addresses = getLocalAddresses();
  const bonjour = new Bonjour();
  const service = bonjour.publish({
    name: SERVICE_NAME,
    type: "https",
    port: HTTPS_PORT,
    host: LOCAL_HOSTNAME
  });
  service.on("error", (error) => {
    console.error(`mDNS discovery is unavailable: ${error.message}`);
  });
  console.log(`\nSend-it-easy is sharing: ${SHARED_DIR}`);
  console.log(`Access code: ${ACCESS_CODE}`);
  console.log(`This computer: http://localhost:${PORT}`);
  console.log(`Secure screen sharing: https://localhost:${HTTPS_PORT}`);
  printFriendlyConnection();
  if (process.platform === "win32" && !addresses.includes(HOTSPOT_ADDRESS)) {
    printConnection(HOTSPOT_ADDRESS, "Windows hotspot (when enabled)");
    printSecureConnection(HOTSPOT_ADDRESS, "Windows hotspot (when enabled)");
  }
  for (const address of addresses) {
    printConnection(address, describeAddress(address));
    printSecureConnection(address, describeAddress(address));
  }
  console.log("\nFor remote screen capture, use the HTTPS address. The browser will show a certificate warning for this local certificate; accept it on the connected device.");
  console.log("Press Ctrl+C to stop sharing. This disconnects all devices and stops the server.\n");
});
