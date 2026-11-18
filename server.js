// Servidor do Labirinto 3D: arquivos do jogo + API de contas.
// Banco: Turso (SQLite na nuvem) quando TURSO_DATABASE_URL está definido; senão, arquivo local data/labirinto.db.
// Senhas com scrypt (node:crypto).
import http from "node:http";
import { createClient } from "@libsql/client";
import { scrypt, randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { readFile, mkdir } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { extname, dirname } from "node:path";

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "127.0.0.1";
const DB_PATH = process.env.DB_PATH || fileURLToPath(new URL("./data/labirinto.db", import.meta.url));
const TURSO_URL = process.env.TURSO_DATABASE_URL;
// Atrás de um proxy (Render), o IP do visitante e o "https" chegam em cabeçalhos X-Forwarded-*.
const TRUST_PROXY = process.env.TRUST_PROXY === "1";
const SESSION_DAYS = 30;
const here = (file) => fileURLToPath(new URL(file, import.meta.url));
const scryptAsync = promisify(scrypt);

/* ---------- Banco de dados ---------- */
let db;
if (TURSO_URL) {
  db = createClient({ url: TURSO_URL, authToken: process.env.TURSO_AUTH_TOKEN });
} else {
  if (process.env.RENDER) console.warn("⚠ TURSO_DATABASE_URL não definido: no Render o arquivo local é apagado a cada reinício!");
  await mkdir(dirname(DB_PATH), { recursive: true });
  db = createClient({ url: pathToFileURL(DB_PATH).href });
}
const run = (sql, ...args) => db.execute({ sql, args });
const one = async (sql, ...args) => (await run(sql, ...args)).rows[0] ?? null;
const all = async (sql, ...args) => (await run(sql, ...args)).rows;

await db.executeMultiple(`
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
  CREATE TABLE IF NOT EXISTS achievements (
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code        TEXT    NOT NULL,
    unlocked_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, code)
  );
`);

// Lista fechada de conquistas aceitas (o catálogo com nomes e ícones fica em achievements.js).
const ACHIEVEMENTS = new Set([
  "primeira_fuga", "explorador", "mestre", "intocavel", "colecionador",
  "em_chamas", "esmagador", "sem_medo", "relampago",
]);
await run("DELETE FROM sessions WHERE expires_at <= ?", Date.now());

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

// Em HTTPS (produção) o cookie ganha "Secure": nunca trafega sem criptografia.
const isHttps = (req) => TRUST_PROXY && req.headers["x-forwarded-proto"] === "https";
function setSessionCookie(req, res, value, maxAge) {
  res.setHeader("Set-Cookie", `sid=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${isHttps(req) ? "; Secure" : ""}`);
}

async function startSession(req, res, userId) {
  const token = randomBytes(32).toString("base64url");
  await run("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)",
    sha256(token), userId, Date.now() + SESSION_DAYS * 864e5);
  setSessionCookie(req, res, token, SESSION_DAYS * 86400);
}

async function currentUser(req) {
  const token = readToken(req);
  if (!token) return null;
  return one(`
    SELECT users.id, users.email FROM sessions JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ?`, sha256(token), Date.now());
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

// Até 20 tentativas de login/cadastro a cada 15 minutos por IP e também por email (contra força bruta).
// O limite por email vale mesmo se alguém falsificar o cabeçalho X-Forwarded-For para trocar de "IP".
const attempts = new Map();
const clientIp = (req) =>
  (TRUST_PROXY && String(req.headers["x-forwarded-for"] || "").split(",")[0].trim()) || req.socket.remoteAddress;
function rateLimited(key) {
  const now = Date.now();
  if (attempts.size > 10_000) for (const [k, v] of attempts) if (v.reset < now) attempts.delete(k); // limpeza
  const entry = attempts.get(key);
  if (!entry || entry.reset < now) { attempts.set(key, { count: 1, reset: now + 15 * 60e3 }); return false; }
  return ++entry.count > 20;
}
function checkLimit(key) {
  if (rateLimited(key)) throw new HttpError(429, "Muitas tentativas. Aguarde alguns minutos.");
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
      result = await run("INSERT INTO users (email, password_hash, created_at) VALUES (?, ?, ?)", email, hash, Date.now());
    } catch (err) {
      if (/UNIQUE/.test(err.message)) throw new HttpError(409, "Este email já tem uma conta. Use “Já tenho uma conta” para entrar.");
      throw err;
    }
    const id = Number(result.lastInsertRowid);
    await startSession(req, res, id);
    return profile({ id, email });
  },

  "POST /api/login": async (req, res, body) => {
    const { email, password } = credentials(body);
    checkLimit("email:" + email);
    const user = await one("SELECT id, email, password_hash FROM users WHERE email = ?", email);
    const ok = await verifyPassword(password, user?.password_hash ?? DUMMY_HASH);
    if (!user || !ok) throw new HttpError(401, "Email ou senha incorretos.");
    await startSession(req, res, user.id);
    return profile(user);
  },

  "POST /api/logout": async (req, res) => {
    const token = readToken(req);
    if (token) await run("DELETE FROM sessions WHERE token_hash = ?", sha256(token));
    setSessionCookie(req, res, "", 0);
    return { ok: true };
  },

  "GET /api/me": async (req) => profile(await requireUser(req)),

  // Guarda a pontuação só se for maior que o recorde atual do jogador.
  "POST /api/score": async (req, res, body) => {
    const user = await requireUser(req);
    const score = Number(body?.score);
    const level = Number(body?.level);
    const valid = Number.isSafeInteger(score) && Number.isSafeInteger(level) &&
      level >= 1 && level <= 1000 && score >= 0 && score <= level * 12000; // teto plausível por nível (com combo)
    if (!valid) throw new HttpError(400, "Pontuação inválida.");
    await run(`
      INSERT INTO records (user_id, best, level, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET best = excluded.best, level = excluded.level, updated_at = excluded.updated_at
      WHERE excluded.best > records.best`, user.id, score, level, Date.now());
    return profile(user);
  },

  // Pódio público: 3 melhores recordes. Empate: quem chegou primeiro fica na frente.
  // O email não é exposto; só um apelido derivado dele (ex.: "mar•••").
  "GET /api/podium": async (req) => {
    const me = await currentUser(req);
    return (await all(`
      SELECT users.id, users.email, records.best, records.level FROM records
      JOIN users ON users.id = records.user_id
      WHERE records.best > 0
      ORDER BY records.best DESC, records.updated_at ASC LIMIT 3`))
      .map((row) => ({ name: nickname(row.email), best: row.best, level: row.level, you: row.id === me?.id }));
  },

  // Desbloqueia uma conquista do jogador logado (repetir não duplica).
  "POST /api/achievements": async (req, res, body) => {
    const user = await requireUser(req);
    const code = String(body?.code ?? "");
    if (!ACHIEVEMENTS.has(code)) throw new HttpError(400, "Conquista desconhecida.");
    await run("INSERT OR IGNORE INTO achievements (user_id, code, unlocked_at) VALUES (?, ?, ?)", user.id, code, Date.now());
    return profile(user);
  },
};

const nickname = (email) => email.split("@")[0].slice(0, 3) + "•••";

async function requireUser(req) {
  const user = await currentUser(req);
  if (!user) throw new HttpError(401, "Não autenticado.");
  return user;
}

async function profile(user) {
  const [record, rows] = await Promise.all([
    one("SELECT best, level FROM records WHERE user_id = ?", user.id),
    all("SELECT code FROM achievements WHERE user_id = ? ORDER BY unlocked_at", user.id),
  ]);
  const achievements = rows.map((a) => a.code);
  return { email: user.email, best: record?.best ?? 0, level: record?.level ?? 0, achievements };
}

/* ---------- Arquivos do jogo (lista fechada: nunca serve o banco nem o código do servidor) ---------- */
const STATIC = { "/": "index.html", "/index.html": "index.html", "/style.css": "style.css", "/game.js": "game.js", "/account.js": "account.js", "/audio.js": "audio.js", "/achievements.js": "achievements.js", "/podium.js": "podium.js" };
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
        if (/register|login/.test(pathname)) checkLimit("ip:" + clientIp(req));
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
