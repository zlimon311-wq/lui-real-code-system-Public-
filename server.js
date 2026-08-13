const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const url = require("url");

const PORT = process.env.PORT || 3000;
const ADMIN_TOKEN =
  process.env.ADMIN_TOKEN || "CHANGE_THIS_ADMIN_TOKEN";

const DB_FILE = path.join(__dirname, "data.json");
const PUBLIC_DIR = path.join(__dirname, "public");

let db;

try {
  db = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
} catch {
  db = { codes: {} };
}

function saveDB() {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function sendJSON(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*"
  });

  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", chunk => {
      body += chunk;
    });

    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
  });
}

function createCode() {
  return (
    "LUI-" +
    crypto.randomBytes(6).toString("hex").toUpperCase()
  );
}

function isAdmin(req) {
  return (
    req.headers.authorization ===
    `Bearer ${ADMIN_TOKEN}`
  );
}

function cleanupExpired() {
  const now = Date.now();

  for (const code in db.codes) {
    const item = db.codes[code];

    if (item.expiresAt <= now) {
      item.status = "expired";
    }
  }

  saveDB();
}

setInterval(cleanupExpired, 60000);

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);

  /* ADMIN: CREATE CODES */

  if (
    req.method === "POST" &&
    parsed.pathname === "/api/admin/create"
  ) {
    if (!isAdmin(req)) {
      return sendJSON(res, 401, {
        ok: false,
        error: "Unauthorized"
      });
    }

    let body;

    try {
      body = await readBody(req);
    } catch {
      return sendJSON(res, 400, {
        ok: false,
        error: "Invalid JSON"
      });
    }

    const count = Math.max(
      1,
      Math.min(500, Number(body.count) || 1)
    );

    const hours = Math.max(
      1,
      Math.min(720, Number(body.hours) || 24)
    );

    const codes = [];

    for (let i = 0; i < count; i++) {
      let code;

      do {
        code = createCode();
      } while (db.codes[code]);

      db.codes[code] = {
        createdAt: Date.now(),
        expiresAt:
          Date.now() + hours * 60 * 60 * 1000,
        status: "unused",
        deviceId: null,
        usedAt: null
      };

      codes.push(code);
    }

    saveDB();

    return sendJSON(res, 200, {
      ok: true,
      count: codes.length,
      validityHours: hours,
      codes
    });
  }

  /* ADMIN: LIST CODES */

  if (
    req.method === "GET" &&
    parsed.pathname === "/api/admin/list"
  ) {
    if (!isAdmin(req)) {
      return sendJSON(res, 401, {
        ok: false,
        error: "Unauthorized"
      });
    }

    return sendJSON(res, 200, {
      ok: true,
      codes: db.codes
    });
  }

  /* USER: REDEEM CODE */

  if (
    req.method === "POST" &&
    parsed.pathname === "/api/redeem"
  ) {
    let body;

    try {
      body = await readBody(req);
    } catch {
      return sendJSON(res, 400, {
        ok: false,
        error: "Invalid JSON"
      });
    }

    const code = String(body.code || "")
      .trim()
      .toUpperCase();

    const deviceId = String(body.deviceId || "")
      .trim();

    if (!code || !deviceId) {
      return sendJSON(res, 400, {
        ok: false,
        error: "Code and device ID are required"
      });
    }

    const item = db.codes[code];

    if (!item) {
      return sendJSON(res, 404, {
        ok: false,
        error: "Invalid code"
      });
    }

    if (Date.now() > item.expiresAt) {
      item.status = "expired";
      saveDB();

      return sendJSON(res, 410, {
        ok: false,
        error: "Code expired"
      });
    }

    if (
      item.status === "used" &&
      item.deviceId !== deviceId
    ) {
      return sendJSON(res, 409, {
        ok: false,
        error: "This code is locked to another device"
      });
    }

    if (
      item.status === "used" &&
      item.deviceId === deviceId
    ) {
      return sendJSON(res, 200, {
        ok: true,
        message: "Device already authorized",
        expiresAt: item.expiresAt
      });
    }

    item.status = "used";
    item.deviceId = deviceId;
    item.usedAt = Date.now();

    saveDB();

    return sendJSON(res, 200, {
      ok: true,
      message: "Code activated and locked to this device",
      expiresAt: item.expiresAt
    });
  }

  /* USER: STATUS */

  if (
    req.method === "GET" &&
    parsed.pathname === "/api/status"
  ) {
    const code = String(parsed.query.code || "")
      .trim()
      .toUpperCase();

    const deviceId = String(
      parsed.query.deviceId || ""
    ).trim();

    const item = db.codes[code];

    if (!item) {
      return sendJSON(res, 404, {
        ok: false,
        error: "Code not found"
      });
    }

    if (Date.now() > item.expiresAt) {
      item.status = "expired";
      saveDB();

      return sendJSON(res, 410, {
        ok: false,
        error: "Code expired"
      });
    }

    return sendJSON(res, 200, {
      ok: true,
      status: item.status,
      sameDevice:
        item.deviceId === deviceId,
      expiresAt: item.expiresAt
    });
  }

  /* STATIC FILES */

  let file;

  if (parsed.pathname === "/") {
    file = "index.html";
  } else if (parsed.pathname === "/admin") {
    file = "admin.html";
  } else {
    file = parsed.pathname.replace(/^\/+/, "");
  }

  const fullPath = path.normalize(
    path.join(PUBLIC_DIR, file)
  );

  if (!fullPath.startsWith(PUBLIC_DIR)) {
    return sendJSON(res, 403, {
      error: "Forbidden"
    });
  }

  fs.readFile(fullPath, (err, data) => {
    if (err) {
      return sendJSON(res, 404, {
        error: "Not found"
      });
    }

    const ext = path.extname(fullPath);

    const types = {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8"
    };

    res.writeHead(200, {
      "Content-Type":
        types[ext] ||
        "application/octet-stream"
    });

    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(
    `LUI server running on port ${PORT}`
  );
});
