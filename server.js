// Servidor do Labirinto 3D: arquivos do jogo + API de contas.
// Sem dependências: usa o SQLite embutido no Node (node:sqlite) e scrypt (node:crypto).
import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import { scrypt, randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { readFile, mkdir } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { extname, dirname } from "node:path";

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "127.0.0.1";
const DB_PATH = process.env.DB_PATH || fileURLToPath(new URL("./data/labirinto.db", import.meta.url));
const SESSION_DAYS = 30;
const here = (file) => fileURLToPath(new URL(file, import.meta.url));
const scryptAsync = promisify(scrypt);

/* ---------- Banco de dados ---------- */
await mkdir(dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY,
    email         TEXT    NOT NULL UNIQUE,
    password_hash TEXT    NOT NULL,
    created_at    INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT    PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS records (
    user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    best       INTEGER NOT NULL,
    level      INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);
db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(Date.now());

/* ---------- Senhas (scrypt + salt aleatório) ---------- */
async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, 64);
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}

async function verifyPassword(password, stored) {
  const [, salt, key] = stored.split("$");
  const candidate = await scryptAsync(password, Buffer.from(salt, "hex"), 64);
  return timingSafeEqual(candidate, Buffer.from(key, "hex"));
}

// Hash falso usado quando o email não existe, para o tempo de resposta não revelar quem tem conta.
const DUMMY_HASH = await hashPassword(randomBytes(16).toString("hex"));

/* ---------- Sessões (token aleatório no cookie HttpOnly; no banco só o hash) ---------- */
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const readToken = (req) => /(?:^|;\s*)sid=([\w-]+)/.exec(req.headers.cookie || "")?.[1];

function startSession(res, userId) {
  const token = randomBytes(32).toString("base64url");
  db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
    .run(sha256(token), userId, Date.now() + SESSION_DAYS * 864e5);
  res.setHeader("Set-Cookie", `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_DAYS * 86400}`);
}

function currentUser(req) {
  const token = readToken(req);
  if (!token) return null;
  return db.prepare(`
    SELECT users.id, users.email FROM sessions JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ?`).get(sha256(token), Date.now()) ?? null;
}

/* ---------- Validação e limites ---------- */
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function credentials(body) {
  const email = String(body?.email ?? "").trim().toLowerCase();
  const password = String(body?.password ?? "");
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, "Informe um email válido.");
  if (password.length < 8 || password.length > 128) throw new HttpError(400, "A senha precisa ter entre 8 e 128 caracteres.");
  return { email, password };
}

// Até 20 tentativas de login/cadastro a cada 15 minutos por IP (contra força bruta).
const attempts = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const entry = attempts.get(ip);
  if (!entry || entry.reset < now) { attempts.set(ip, { count: 1, reset: now + 15 * 60e3 }); return false; }
  return ++entry.count > 20;
}

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 10_000) throw new HttpError(413, "Requisição muito grande.");
  }
  try { return JSON.parse(raw || "{}"); } catch { throw new HttpError(400, "JSON inválido."); }
}

/* ---------- Rotas da API ---------- */
const routes = {
  "POST /api/register": async (req, res, body) => {
    const { email, password } = credentials(body);
    const hash = await hashPassword(password);
    let result;
    try {
      result = db.prepare("INSERT INTO users (email, password_hash, created_at) VALUES (?, ?, ?)").run(email, hash, Date.now());
    } catch (err) {
      if (/UNIQUE/.test(err.message)) throw new HttpError(409, "Este email já tem uma conta. Use “Já tenho uma conta” para entrar.");
      throw err;
    }
    startSession(res, Number(result.lastInsertRowid));
    return profile({ id: Number(result.lastInsertRowid), email });
  },

  "POST /api/login": async (req, res, body) => {
    const { email, password } = credentials(body);
    const user = db.prepare("SELECT id, email, password_hash FROM users WHERE email = ?").get(email);
    const ok = await verifyPassword(password, user?.password_hash ?? DUMMY_HASH);
    if (!user || !ok) throw new HttpError(401, "Email ou senha incorretos.");
    startSession(res, user.id);
    return profile(user);
  },

  "POST /api/logout": (req, res) => {
    const token = readToken(req);
    if (token) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token));
    res.setHeader("Set-Cookie", "sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
    return { ok: true };
  },

  "GET /api/me": (req) => profile(requireUser(req)),

  // Guarda a pontuação só se for maior que o recorde atual do jogador.
  "POST /api/score": (req, res, body) => {
    const user = requireUser(req);
    const score = Number(body?.score);
    const level = Number(body?.level);
    const valid = Number.isSafeInteger(score) && Number.isSafeInteger(level) &&
      level >= 1 && level <= 1000 && score >= 0 && score <= level * 5000; // teto plausível por nível
    if (!valid) throw new HttpError(400, "Pontuação inválida.");
    db.prepare(`
      INSERT INTO records (user_id, best, level, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET best = excluded.best, level = excluded.level, updated_at = excluded.updated_at
      WHERE excluded.best > records.best`).run(user.id, score, level, Date.now());
    return profile(user);
  },

  // Pódio público: 3 melhores recordes. Empate: quem chegou primeiro fica na frente.
  // O email não é exposto; só um apelido derivado dele (ex.: "mar•••").
  "GET /api/podium": (req) => {
    const me = currentUser(req);
    return db.prepare(`
      SELECT users.id, users.email, records.best, records.level FROM records
      JOIN users ON users.id = records.user_id
      WHERE records.best > 0
      ORDER BY records.best DESC, records.updated_at ASC LIMIT 3`).all()
      .map((row) => ({ name: nickname(row.email), best: row.best, level: row.level, you: row.id === me?.id }));
  },
};

const nickname = (email) => email.split("@")[0].slice(0, 3) + "•••";

function requireUser(req) {
  const user = currentUser(req);
  if (!user) throw new HttpError(401, "Não autenticado.");
  return user;
}

function profile(user) {
  const record = db.prepare("SELECT best, level FROM records WHERE user_id = ?").get(user.id);
  return { email: user.email, best: record?.best ?? 0, level: record?.level ?? 0 };
}

/* ---------- Arquivos do jogo (lista fechada: nunca serve o banco nem o código do servidor) ---------- */
const STATIC = { "/": "index.html", "/index.html": "index.html", "/style.css": "style.css", "/game.js": "game.js", "/account.js": "account.js", "/podium.js": "podium.js" };
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8" };

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }).end(JSON.stringify(data));
}

http.createServer(async (req, res) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  const { pathname } = new URL(req.url, "http://localhost");

  try {
    const route = routes[`${req.method} ${pathname}`];
    if (route) {
      let body = null;
      if (req.method === "POST") {
        // Exigir JSON impede formulários de outros sites (CSRF); o cookie SameSite=Strict reforça isso.
        if (!req.headers["content-type"]?.startsWith("application/json")) throw new HttpError(415, "Envie JSON.");
        if (/register|login/.test(pathname) && rateLimited(req.socket.remoteAddress)) {
          throw new HttpError(429, "Muitas tentativas. Aguarde alguns minutos.");
        }
        body = await readJson(req);
      }
      return sendJson(res, 200, await route(req, res, body));
    }

    const file = STATIC[pathname];
    if (req.method !== "GET" || !file) return sendJson(res, 404, { error: "Não encontrado." });
    res.writeHead(200, { "Content-Type": TYPES[extname(file)], "Cache-Control": "no-cache" }).end(await readFile(here(file)));
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) console.error(err);
    sendJson(res, status, { error: status === 500 ? "Erro interno do servidor." : err.message });
  }
}).listen(PORT, HOST, () => console.log(`Labirinto 3D rodando em http://localhost:${PORT}`));
