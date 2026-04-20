import { createServer } from "node:http";
import { createHmac, createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual, verify as verifySignature } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, createReadStream } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = normalize(join(__filename, ".."));

loadEnv(join(__dirname, ".env"));

const config = {
  port: Number(process.env.PORT || 3000),
  baseUrl: process.env.APP_BASE_URL || "http://localhost:3000",
  googleClientId: process.env.GOOGLE_CLIENT_ID || "",
  dataEncryptionKey: process.env.DATA_ENCRYPTION_KEY || "",
  sessionSecret: process.env.SESSION_SECRET || "",
  adminUsername: process.env.ADMIN_USERNAME || "admin",
  adminPassword: process.env.ADMIN_PASSWORD || "ChangeThisNow123!",
  secureCookies: String(process.env.APP_BASE_URL || "").startsWith("https://")
};

validateConfig(config);

const dataDir = join(__dirname, "data");
const publicDir = join(__dirname, "public");
const dbPath = join(dataDir, "db.json");

mkdirSync(dataDir, { recursive: true });

const initialDb = {
  users: {},
  applications: {},
  references: {}
};

if (!existsSync(dbPath)) {
  writeFileSync(dbPath, JSON.stringify(initialDb, null, 2), "utf8");
}

const borrowersStreams = new Map();
const adminsStreams = new Set();
const googleCertCache = {
  expiry: 0,
  certs: {}
};

createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", config.baseUrl);
    const method = req.method || "GET";
    const cookies = parseCookies(req.headers.cookie || "");
    const borrowerSession = verifySession(cookies.borrower_session, "borrower");
    const adminSession = verifySession(cookies.admin_session, "admin");

    if (method === "GET" && url.pathname === "/api/config") {
      return json(res, 200, { googleClientId: config.googleClientId });
    }

    if (method === "POST" && url.pathname === "/api/auth/google") {
      const body = await readJson(req);
      const payload = await verifyGoogleIdToken(body.credential);
      if (!payload.email || !payload.email_verified) {
        return json(res, 401, { error: "Google email verification is required." });
      }
      if (!String(payload.email).toLowerCase().endsWith("@gmail.com")) {
        return json(res, 401, { error: "Only Gmail accounts are allowed for borrower login." });
      }

      const email = String(payload.email).toLowerCase();
      const db = readDb();
      db.users[email] = {
        email,
        name: payload.name || payload.given_name || "Borrower",
        picture: payload.picture || "",
        lastLoginAt: new Date().toISOString()
      };
      writeDb(db);

      setCookie(res, "borrower_session", signSession({ role: "borrower", email }), {
        httpOnly: true,
        sameSite: "Lax",
        secure: config.secureCookies,
        path: "/",
        maxAge: 60 * 60 * 24 * 7
      });

      const application = getApplicationByEmail(db, email);
      return json(res, 200, {
        user: db.users[email],
        application: sanitizeBorrowerApplication(application)
      });
    }

    if (method === "POST" && url.pathname === "/api/auth/logout") {
      clearCookie(res, "borrower_session");
      return json(res, 200, { ok: true });
    }

    if (method === "GET" && url.pathname === "/api/me") {
      if (!borrowerSession) {
        return json(res, 401, { error: "Unauthorized" });
      }
      const db = readDb();
      const user = db.users[borrowerSession.email] || { email: borrowerSession.email, name: "Borrower", picture: "" };
      const application = getApplicationByEmail(db, borrowerSession.email);
      return json(res, 200, {
        user,
        application: sanitizeBorrowerApplication(application)
      });
    }

    if (method === "POST" && url.pathname === "/api/application/save") {
      if (!borrowerSession) {
        return json(res, 401, { error: "Unauthorized" });
      }
      const body = await readJson(req);
      const db = readDb();
      const saved = saveBorrowerApplication(db, borrowerSession.email, body);
      writeDb(db);
      broadcastBorrower(saved.email, sanitizeBorrowerApplication(saved));
      broadcastAdmins({ type: "refresh" });
      return json(res, 200, { application: sanitizeBorrowerApplication(saved) });
    }

    if (method === "POST" && url.pathname === "/api/application/submit") {
      if (!borrowerSession) {
        return json(res, 401, { error: "Unauthorized" });
      }
      const body = await readJson(req);
      const db = readDb();
      const application = saveBorrowerApplication(db, borrowerSession.email, body);

      if (!application.personal?.fullName || !application.personal?.email || !application.personal?.dateOfBirth || !application.personal?.panNumber || !application.personal?.aadhaarNumber) {
        return json(res, 400, { error: "Complete personal details before submitting." });
      }
      if (!application.bank?.bankName || !application.bank?.accountNumber || !application.bank?.ifscCode || !application.bank?.selfieImage || !application.bank?.eMandateConsent) {
        return json(res, 400, { error: "Complete bank details, selfie capture, and e-mandate consent before submitting." });
      }

      if (!application.referenceNumber) {
        application.referenceNumber = generateReference(db);
        db.references[application.referenceNumber] = borrowerSession.email;
      }

      application.status = application.status || "Pending";
      application.submittedAt = application.submittedAt || new Date().toISOString();
      application.lastCompletedStep = 3;
      application.updatedAt = new Date().toISOString();
      writeDb(db);

      const sanitized = sanitizeBorrowerApplication(application);
      broadcastBorrower(application.email, sanitized);
      broadcastAdmins({ type: "refresh" });
      return json(res, 200, { application: sanitized });
    }

    if (method === "GET" && url.pathname === "/api/application/stream") {
      if (!borrowerSession) {
        res.writeHead(401);
        res.end("Unauthorized");
        return;
      }
      return openEventStream(res, borrowersStreams, borrowerSession.email);
    }

    if (method === "GET" && url.pathname === "/api/track") {
      const reference = String(url.searchParams.get("reference") || "").trim().toUpperCase();
      if (!reference) {
        return json(res, 400, { error: "Reference number is required." });
      }
      const db = readDb();
      const email = db.references[reference];
      if (!email) {
        return json(res, 404, { error: "Reference number not found." });
      }
      const application = db.applications[email];
      return json(res, 200, {
        referenceNumber: reference,
        status: application.status || "Pending",
        submittedAt: application.submittedAt || null,
        name: application.personal?.fullName || ""
      });
    }

    if (method === "POST" && url.pathname === "/api/admin/login") {
      const body = await readJson(req);
      const validUsername = String(body.username || "") === config.adminUsername;
      const validPassword = safeEqualHash(String(body.password || ""), config.adminPassword);
      if (!validUsername || !validPassword) {
        return json(res, 401, { error: "Invalid admin credentials." });
      }
      setCookie(res, "admin_session", signSession({ role: "admin", username: config.adminUsername }), {
        httpOnly: true,
        sameSite: "Lax",
        secure: config.secureCookies,
        path: "/",
        maxAge: 60 * 60 * 8
      });
      return json(res, 200, { ok: true });
    }

    if (method === "POST" && url.pathname === "/api/admin/logout") {
      clearCookie(res, "admin_session");
      return json(res, 200, { ok: true });
    }

    if (method === "GET" && url.pathname === "/api/admin/me") {
      if (!adminSession) {
        return json(res, 401, { error: "Unauthorized" });
      }
      return json(res, 200, { username: config.adminUsername });
    }

    if (method === "GET" && url.pathname === "/api/admin/applications") {
      if (!adminSession) {
        return json(res, 401, { error: "Unauthorized" });
      }
      const query = String(url.searchParams.get("q") || "").trim().toLowerCase();
      const db = readDb();
      const applications = Object.values(db.applications)
        .map((app) => sanitizeAdminApplication(app))
        .filter((app) => {
          if (!query) {
            return true;
          }
          return [app.personal?.fullName, app.personal?.email, app.referenceNumber]
            .filter(Boolean)
            .some((value) => String(value).toLowerCase().includes(query));
        })
        .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
      return json(res, 200, { applications });
    }

    if (method === "GET" && url.pathname === "/api/admin/stream") {
      if (!adminSession) {
        res.writeHead(401);
        res.end("Unauthorized");
        return;
      }
      return openEventStream(res, adminsStreams);
    }

    if (method === "POST" && url.pathname === "/api/admin/status") {
      if (!adminSession) {
        return json(res, 401, { error: "Unauthorized" });
      }
      const body = await readJson(req);
      const referenceNumber = String(body.referenceNumber || "").trim().toUpperCase();
      const status = String(body.status || "").trim();
      if (!["Pending", "Approved", "Rejected"].includes(status)) {
        return json(res, 400, { error: "Invalid status." });
      }
      const db = readDb();
      const email = db.references[referenceNumber];
      if (!email || !db.applications[email]) {
        return json(res, 404, { error: "Application not found." });
      }
      db.applications[email].status = status;
      db.applications[email].updatedAt = new Date().toISOString();
      writeDb(db);
      const borrowerView = sanitizeBorrowerApplication(db.applications[email]);
      broadcastBorrower(email, borrowerView);
      broadcastAdmins({ type: "refresh" });
      return json(res, 200, { application: sanitizeAdminApplication(db.applications[email]) });
    }

    if (method === "GET" && (url.pathname === "/" || url.pathname === "/privacy")) {
      return serveStatic(res, join(publicDir, url.pathname === "/" ? "index.html" : "privacy.html"));
    }

    if (method === "GET" && url.pathname.startsWith("/")) {
      const filePath = join(publicDir, url.pathname);
      if (filePath.startsWith(publicDir) && existsSync(filePath)) {
        return serveStatic(res, filePath);
      }
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  } catch (error) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: error.message || "Server error" }));
  }
}).listen(config.port, () => {
  console.log(`DIGITAL CGF CUSTOMER GROWTH FUND running on ${config.baseUrl}`);
});

function saveBorrowerApplication(db, email, payload) {
  const existing = db.applications[email] || {
    email,
    status: "Pending",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastCompletedStep: 0
  };

  const personal = payload.personal ? sanitizePersonal(payload.personal, existing.personal) : existing.personal;
  const bank = payload.bank ? sanitizeBank(payload.bank, existing.bank) : existing.bank;
  const eligibility = buildEligibility(personal);

  const next = {
    ...existing,
    email,
    personal: personal || existing.personal,
    bank: bank || existing.bank,
    eligibility: personal ? eligibility : existing.eligibility,
    lastCompletedStep: Math.max(existing.lastCompletedStep || 0, Number(payload.lastCompletedStep || existing.lastCompletedStep || 0)),
    updatedAt: new Date().toISOString()
  };

  db.applications[email] = next;
  return next;
}

function sanitizePersonal(personal, existing = {}) {
  const panRaw = String(personal.panNumber || "").trim().toUpperCase();
  const aadhaarRaw = String(personal.aadhaarNumber || "").replace(/\s+/g, "");
  const email = String(personal.email || "").trim().toLowerCase();
  const dateOfBirth = String(personal.dateOfBirth || "").trim();
  const age = calculateAge(dateOfBirth);
  const ageEligible = age >= 18;
  return {
    fullName: String(personal.fullName || "").trim(),
    email,
    dateOfBirth,
    age,
    ageEligible,
    panNumber: panRaw ? encryptField(panRaw) : existing.panNumber || "",
    panMasked: panRaw ? maskPan(panRaw) : existing.panMasked || "",
    aadhaarNumber: aadhaarRaw ? encryptField(aadhaarRaw) : existing.aadhaarNumber || "",
    aadhaarMasked: aadhaarRaw ? maskAadhaar(aadhaarRaw) : existing.aadhaarMasked || "",
    employmentType: String(personal.employmentType || "").trim(),
    monthlySalary: Number(personal.monthlySalary || 0)
  };
}

function sanitizeBank(bank, existing = {}) {
  const accountRaw = String(bank.accountNumber || "").trim();
  return {
    bankName: String(bank.bankName || "").trim(),
    accountNumber: accountRaw ? encryptField(accountRaw) : existing.accountNumber || "",
    accountMasked: accountRaw ? maskAccount(accountRaw) : existing.accountMasked || "",
    ifscCode: String(bank.ifscCode || "").trim().toUpperCase(),
    selfieImage: String(bank.selfieImage || "").trim() || existing.selfieImage || "",
    eMandateConsent: bank.eMandateConsent === undefined ? Boolean(existing.eMandateConsent) : Boolean(bank.eMandateConsent)
  };
}

function buildEligibility(personal) {
  const age = Number(personal?.age || 0);
  const salary = Number(personal?.monthlySalary || 0);
  const employmentType = String(personal?.employmentType || "").toLowerCase();
  const ageEligible = age >= 18;

  let floor = 5000;
  let cap = age >= 21 ? 50000 : 25000;

  if (salary >= 25000) {
    cap = Math.min(cap, cap);
  } else if (salary >= 18000) {
    cap = Math.min(cap, cap - 5000);
  } else if (salary >= 12000) {
    cap = Math.min(cap, cap - 10000);
  } else if (salary > 0) {
    cap = Math.min(cap, 15000);
  } else {
    cap = 0;
  }

  if (employmentType.includes("self") || employmentType.includes("freel")) {
    cap = Math.max(floor, cap - 5000);
  }

  if (!ageEligible) {
    floor = 0;
    cap = 0;
  }

  return {
    ageEligible,
    profileBand: inferCreditProfile(age, salary, employmentType),
    minimumOffer: floor,
    maximumOffer: Math.max(0, cap),
    message: ageEligible
      ? `Estimated facilitation range: ${formatInr(floor)} to ${formatInr(Math.max(0, cap))}`
      : "Applicant must be at least 18 years old."
  };
}

function inferCreditProfile(age, salary, employmentType) {
  if (age >= 25 && salary >= 25000 && employmentType.includes("salar")) {
    return "Strong";
  }
  if (age >= 21 && salary >= 15000) {
    return "Moderate";
  }
  return "Developing";
}

function calculateAge(dateOfBirth) {
  if (!dateOfBirth) {
    return 0;
  }
  const dob = new Date(dateOfBirth);
  if (Number.isNaN(dob.getTime())) {
    return 0;
  }
  const today = new Date();
  let age = today.getFullYear() - dob.getFullYear();
  const monthDiff = today.getMonth() - dob.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < dob.getDate())) {
    age -= 1;
  }
  return age;
}

function generateReference(db) {
  let reference = "";
  do {
    reference = `CGF2026${Math.floor(1000 + Math.random() * 9000)}`;
  } while (db.references[reference]);
  return reference;
}

function sanitizeBorrowerApplication(application) {
  if (!application) {
    return null;
  }
  return {
    email: application.email,
    personal: application.personal
      ? {
          ...application.personal,
          panNumber: undefined,
          aadhaarNumber: undefined
        }
      : null,
    bank: application.bank
      ? {
          ...application.bank,
          accountNumber: undefined
        }
      : null,
    eligibility: application.eligibility || null,
    referenceNumber: application.referenceNumber || "",
    status: application.status || "Pending",
    createdAt: application.createdAt || null,
    updatedAt: application.updatedAt || null,
    submittedAt: application.submittedAt || null,
    lastCompletedStep: application.lastCompletedStep || 0
  };
}

function sanitizeAdminApplication(application) {
  return {
    ...application,
    personal: application.personal
      ? {
          ...application.personal,
          panNumber: decryptField(application.personal.panNumber),
          aadhaarNumber: decryptField(application.personal.aadhaarNumber)
        }
      : null,
    bank: application.bank
      ? {
          ...application.bank,
          accountNumber: decryptField(application.bank.accountNumber)
        }
      : null
  };
}

function getApplicationByEmail(db, email) {
  return db.applications[email] || null;
}

function encryptField(value) {
  if (!value) {
    return "";
  }
  const iv = randomBytes(12);
  const key = Buffer.from(config.dataEncryptionKey, "hex");
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

function decryptField(value) {
  if (!value) {
    return "";
  }
  const raw = Buffer.from(value, "base64");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const encrypted = raw.subarray(28);
  const key = Buffer.from(config.dataEncryptionKey, "hex");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

function readDb() {
  return JSON.parse(readFileSync(dbPath, "utf8"));
}

function writeDb(db) {
  writeFileSync(dbPath, JSON.stringify(db, null, 2), "utf8");
}

function signSession(payload) {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", config.sessionSecret).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

function verifySession(token, expectedRole) {
  if (!token) {
    return null;
  }
  const [encoded, signature] = token.split(".");
  if (!encoded || !signature) {
    return null;
  }
  const expected = createHmac("sha256", config.sessionSecret).update(encoded).digest("base64url");
  if (!safeEqual(signature, expected)) {
    return null;
  }
  const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  if (payload.role !== expectedRole) {
    return null;
  }
  return payload;
}

function safeEqual(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (aa.length !== bb.length) {
    return false;
  }
  return timingSafeEqual(aa, bb);
}

function safeEqualHash(input, secret) {
  return safeEqual(createHash("sha256").update(input).digest("hex"), createHash("sha256").update(secret).digest("hex"));
}

function parseCookies(cookieHeader) {
  return cookieHeader.split(";").reduce((acc, part) => {
    const [name, ...rest] = part.trim().split("=");
    if (name) {
      acc[name] = decodeURIComponent(rest.join("="));
    }
    return acc;
  }, {});
}

function setCookie(res, name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (options.httpOnly) {
    parts.push("HttpOnly");
  }
  if (options.sameSite) {
    parts.push(`SameSite=${options.sameSite}`);
  }
  if (options.path) {
    parts.push(`Path=${options.path}`);
  }
  if (options.maxAge) {
    parts.push(`Max-Age=${options.maxAge}`);
  }
  res.setHeader("Set-Cookie", parts.join("; "));
}

function clearCookie(res, name) {
  res.setHeader("Set-Cookie", `${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

function json(res, statusCode, body) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(body));
}

function serveStatic(res, filePath) {
  const type = mimeType(extname(filePath));
  res.writeHead(200, { "Content-Type": type });
  createReadStream(filePath).pipe(res);
}

function mimeType(extension) {
  return {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".svg": "image/svg+xml"
  }[extension] || "application/octet-stream";
}

function formatInr(amount) {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(amount);
}

function maskPan(value) {
  if (value.length < 4) {
    return value;
  }
  return `${value.slice(0, 3)}XXXXX${value.slice(-2)}`;
}

function maskAadhaar(value) {
  if (value.length < 4) {
    return value;
  }
  return `XXXX XXXX ${value.slice(-4)}`;
}

function maskAccount(value) {
  if (value.length < 4) {
    return value;
  }
  return `XXXXXX${value.slice(-4)}`;
}

function loadEnv(envPath) {
  if (!existsSync(envPath)) {
    return;
  }
  const lines = readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    if (!line || line.trim().startsWith("#")) {
      continue;
    }
    const index = line.indexOf("=");
    if (index === -1) {
      continue;
    }
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

function validateConfig(currentConfig) {
  if (!/^[a-fA-F0-9]{64}$/.test(currentConfig.dataEncryptionKey)) {
    throw new Error("DATA_ENCRYPTION_KEY must be a 64-character hexadecimal string.");
  }
  if (!currentConfig.sessionSecret || currentConfig.sessionSecret.length < 16) {
    throw new Error("SESSION_SECRET must be at least 16 characters.");
  }
}

function openEventStream(res, streamCollection, key) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive"
  });
  res.write("\n");

  if (streamCollection instanceof Map) {
    const current = streamCollection.get(key) || new Set();
    current.add(res);
    streamCollection.set(key, current);
    res.on("close", () => {
      current.delete(res);
      if (!current.size) {
        streamCollection.delete(key);
      }
    });
  } else {
    streamCollection.add(res);
    res.on("close", () => {
      streamCollection.delete(res);
    });
  }
}

function broadcastBorrower(email, payload) {
  const streams = borrowersStreams.get(email);
  if (!streams) {
    return;
  }
  for (const stream of streams) {
    stream.write(`data: ${JSON.stringify(payload)}\n\n`);
  }
}

function broadcastAdmins(payload) {
  for (const stream of adminsStreams) {
    stream.write(`data: ${JSON.stringify(payload)}\n\n`);
  }
}

async function verifyGoogleIdToken(credential) {
  if (!credential) {
    throw new Error("Missing Google credential.");
  }

  const [headerEncoded, payloadEncoded, signatureEncoded] = String(credential).split(".");
  if (!headerEncoded || !payloadEncoded || !signatureEncoded) {
    throw new Error("Invalid Google token format.");
  }

  const header = JSON.parse(Buffer.from(headerEncoded, "base64url").toString("utf8"));
  const payload = JSON.parse(Buffer.from(payloadEncoded, "base64url").toString("utf8"));
  const certs = await getGoogleCerts();
  const pem = certs[header.kid];
  if (!pem) {
    throw new Error("Unable to match Google signing key.");
  }

  const verified = verifySignature(
    "RSA-SHA256",
    Buffer.from(`${headerEncoded}.${payloadEncoded}`),
    pem,
    Buffer.from(signatureEncoded, "base64url")
  );

  if (!verified) {
    throw new Error("Invalid Google token signature.");
  }

  if (payload.aud !== config.googleClientId) {
    throw new Error("Google token audience mismatch.");
  }
  if (payload.iss !== "accounts.google.com" && payload.iss !== "https://accounts.google.com") {
    throw new Error("Unexpected Google issuer.");
  }
  if (!payload.exp || payload.exp * 1000 < Date.now()) {
    throw new Error("Google token expired.");
  }
  return payload;
}

async function getGoogleCerts() {
  if (googleCertCache.expiry > Date.now() && Object.keys(googleCertCache.certs).length) {
    return googleCertCache.certs;
  }
  const response = await fetch("https://www.googleapis.com/oauth2/v1/certs");
  if (!response.ok) {
    throw new Error("Failed to fetch Google certificates.");
  }
  const cacheControl = response.headers.get("cache-control") || "";
  const maxAgeMatch = cacheControl.match(/max-age=(\d+)/);
  const maxAge = maxAgeMatch ? Number(maxAgeMatch[1]) : 3600;
  googleCertCache.certs = await response.json();
  googleCertCache.expiry = Date.now() + maxAge * 1000;
  return googleCertCache.certs;
}
