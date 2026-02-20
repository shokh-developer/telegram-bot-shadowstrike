import express from 'express';
import bodyParser from 'body-parser';
import http from 'http';
import { WebSocketServer } from 'ws';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Make nodemailer optional so server can run without installing it.
let nodemailer = null;
try {
  nodemailer = (await import('nodemailer')).default;
  console.log('nodemailer loaded');
} catch (e) {
  console.warn('nodemailer not available; email sending disabled.');
}

const app = express();
app.use(bodyParser.json({ limit: '80mb' }));
app.use((err, _req, res, next) => {
  if (!err) return next();
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ ok: false, message: 'Receipt image too large' });
  }
  return res.status(400).json({ ok: false, message: 'Invalid request body' });
});
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,x-bot-api-key');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const USERS_DB_PATH = path.join(__dirname, 'users.json');
const TOPUPS_DB_PATH = path.join(__dirname, 'topups.json');
const CHARACTERS_DB_PATH = path.join(__dirname, 'characters.json');

async function loadDotenvIfPresent() {
  // Minimal .env loader (no dependency). Reads `server/.env`.
  // Does not override existing env vars.
  const envPath = path.join(__dirname, '.env');
  try {
    const raw = await fs.readFile(envPath, 'utf8');
    raw.split(/\r?\n/).forEach((line) => {
      const trimmed = String(line || '').trim();
      if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) return;
      const [k, ...rest] = trimmed.split('=');
      const key = String(k || '').trim();
      const val = rest.join('=').trim().replace(/^['"]|['"]$/g, '');
      if (!key) return;
      if (!process.env[key]) process.env[key] = val;
    });
  } catch {
    // ignore if missing/unreadable
  }
}

await loadDotenvIfPresent();

const BOT_API_KEY = process.env.BOT_API_KEY || '';
const BOT_ADMIN_USERNAME = 'shtursunov7';

async function ensureUsersDb() {
  try {
    await fs.access(USERS_DB_PATH);
  } catch {
    await fs.writeFile(USERS_DB_PATH, JSON.stringify({ users: [] }, null, 2), 'utf8');
  }
}

async function ensureTopupsDb() {
  try {
    await fs.access(TOPUPS_DB_PATH);
  } catch {
    await fs.writeFile(TOPUPS_DB_PATH, JSON.stringify({ requests: [] }, null, 2), 'utf8');
  }
}

async function readUsers() {
  await ensureUsersDb();
  const raw = await fs.readFile(USERS_DB_PATH, 'utf8');
  const parsed = JSON.parse(raw || '{"users":[]}');
  const users = Array.isArray(parsed.users) ? parsed.users : [];
  return users.map((u) => ({
    username: String(u.username || '').trim().toLowerCase(),
    userId: String(u.userId || '').trim().toUpperCase(),
    password: String(u.password || ''),
    friends: Array.isArray(u.friends) ? u.friends.map((f) => String(f || '').trim().toUpperCase()).filter(Boolean) : [],
    telegramUsername: u.telegramUsername ? String(u.telegramUsername).trim().toLowerCase() : null,
    blocked: Boolean(u.blocked),
    linkCode: u.linkCode || null,
    linkCodeExpiresAt: Number(u.linkCodeExpiresAt || 0),
    rating: Number(u.rating ?? 0),
    sukunaKills: Number(u.sukunaKills ?? 0),
    deaths: Number(u.deaths ?? u.losses ?? 0),
    trophies: Number(u.trophies ?? 0),
    wins: Number(u.wins ?? 0),
    losses: Number(u.losses ?? 0),
    matches: Number(u.matches ?? 0),
    profileImage: u.profileImage ? String(u.profileImage) : null,
    walletVersion: Number(u.walletVersion || 0),
    vales: Number(u.vales ?? 0),
    ownedCharacters: Array.isArray(u.ownedCharacters)
      ? u.ownedCharacters.map((c) => String(c || '').trim().toLowerCase()).filter(Boolean)
      : ['gojo'],
    videoRewardAt: Number(u.videoRewardAt || 0),
  }));
}

async function writeUsers(users) {
  await fs.writeFile(USERS_DB_PATH, JSON.stringify({ users }, null, 2), 'utf8');
}

async function readTopups() {
  await ensureTopupsDb();
  const raw = await fs.readFile(TOPUPS_DB_PATH, 'utf8');
  const parsed = JSON.parse(raw || '{"requests":[]}');
  return Array.isArray(parsed.requests) ? parsed.requests : [];
}

async function writeTopups(requests) {
  await fs.writeFile(TOPUPS_DB_PATH, JSON.stringify({ requests }, null, 2), 'utf8');
}

const DEFAULT_CHARACTERS = [
  {
    id: 'gojo',
    label: 'Gojo',
    price: 0,
    isDefault: true,
    modelPath: '/models/characters/gojo/model.glb',
    walkAnimPath: '/models/characters/gojo/anims/Walking%20(1).fbx',
    runAnimPath: '/models/gojo%20Running.fbx',
    idleAnimPath: '/models/characters/gojo/anims/Standing%20Idle.fbx',
    deathAnimPath: '/models/characters/gojo/anims/Standing%20React%20Death%20Backward.fbx',
    menuScale: 0.43,
    menuPosition: [1.55, -1.35, 0],
    gameScale: 0.025,
    gameModelOffset: [0, 0, 0],
    gameCameraOffset: [0, 0, 0],
  },
  {
    id: 'itadori',
    label: 'Itadori',
    price: 900,
    modelPath: '/models/characters/itadori/model.glb',
    walkAnimPath: '/models/characters/itadori/anims/Walking.fbx',
    runAnimPath: '/models/itadori%20Running.fbx',
    idleAnimPath: '/models/characters/itadori/anims/Standing%20Idle.fbx',
    deathAnimPath: '/models/characters/itadori/anims/Standing%20React%20Death%20Backward.fbx',
    menuScale: 13,
    menuPosition: [1.55, -1.0, 0],
    gameScale: 0.78,
    gameModelOffset: [0, 0.95, 0],
    gameCameraOffset: [0, 0.12, 0],
  },
];

const sanitizeCharacterId = (value) => String(value || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
const sanitizeFileName = (value, fallback) => {
  const raw = String(value || '').trim();
  const base = raw ? path.basename(raw) : fallback;
  return String(base).replace(/[^\w\s().-]/g, '_');
};
const decodeDataUrlToBuffer = (value) => {
  const raw = String(value || '').trim();
  const match = raw.match(/^data:([^;]+);base64,([a-z0-9+/=]+)$/i);
  if (!match) return null;
  return { mime: String(match[1] || '').toLowerCase(), buffer: Buffer.from(match[2], 'base64') };
};
const toPublicUrl = (...segments) => `/${segments.map((s) => encodeURIComponent(String(s || ''))).join('/')}`;

async function ensureCharactersDb() {
  try {
    await fs.access(CHARACTERS_DB_PATH);
  } catch {
    await fs.writeFile(CHARACTERS_DB_PATH, JSON.stringify({ characters: DEFAULT_CHARACTERS }, null, 2), 'utf8');
  }
}

async function readCharacters() {
  await ensureCharactersDb();
  const raw = await fs.readFile(CHARACTERS_DB_PATH, 'utf8');
  const parsed = JSON.parse(raw || '{"characters":[]}');
  const rows = Array.isArray(parsed.characters) ? parsed.characters : [];
  const byId = new Map();
  for (const item of DEFAULT_CHARACTERS.concat(rows)) {
    const id = sanitizeCharacterId(item?.id);
    if (!id) continue;
    byId.set(id, {
      id,
      label: String(item?.label || id),
      price: Math.max(0, Number(item?.price || 0)),
      isDefault: Boolean(item?.isDefault),
      modelPath: String(item?.modelPath || ''),
      walkAnimPath: String(item?.walkAnimPath || ''),
      runAnimPath: item?.runAnimPath ? String(item.runAnimPath) : undefined,
      idleAnimPath: String(item?.idleAnimPath || ''),
      deathAnimPath: String(item?.deathAnimPath || ''),
      menuScale: Number(item?.menuScale || 0.43),
      menuPosition: Array.isArray(item?.menuPosition) && item.menuPosition.length === 3 ? item.menuPosition : [1.55, -1.35, 0],
      gameScale: Number(item?.gameScale || 0.025),
      gameModelOffset: Array.isArray(item?.gameModelOffset) && item.gameModelOffset.length === 3 ? item.gameModelOffset : [0, 0, 0],
      gameCameraOffset: Array.isArray(item?.gameCameraOffset) && item.gameCameraOffset.length === 3 ? item.gameCameraOffset : [0, 0, 0],
    });
  }
  return Array.from(byId.values());
}

async function writeCharacters(characters) {
  await fs.writeFile(CHARACTERS_DB_PATH, JSON.stringify({ characters }, null, 2), 'utf8');
}

const createLinkCode = () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 8; i += 1) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
};

const createUserId = (taken) => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = '';
  do {
    id = 'P';
    for (let i = 0; i < 7; i += 1) id += chars[Math.floor(Math.random() * chars.length)];
  } while (taken.has(id));
  return id;
};

const ensureUserIdsAndFriends = (users) => {
  const taken = new Set(users.map((u) => String(u.userId || '').trim().toUpperCase()).filter(Boolean));
  let changed = false;
  users.forEach((u) => {
    if (!u.userId) {
      u.userId = createUserId(taken);
      taken.add(u.userId);
      changed = true;
    }
    if (!Array.isArray(u.friends)) {
      u.friends = [];
      changed = true;
    }
    if (!Number.isFinite(Number(u.vales))) {
      u.vales = 0;
      changed = true;
    }
    if (Number(u.walletVersion || 0) < 2) {
      if (Number(u.vales || 0) === 1200) {
        u.vales = 0;
      }
      u.walletVersion = 2;
      changed = true;
    }
    if (!Array.isArray(u.ownedCharacters)) {
      u.ownedCharacters = ['gojo'];
      changed = true;
    } else if (!u.ownedCharacters.includes('gojo')) {
      u.ownedCharacters = ['gojo', ...u.ownedCharacters];
      changed = true;
    }
    if (!Number.isFinite(Number(u.videoRewardAt))) {
      u.videoRewardAt = 0;
      changed = true;
    }
  });
  return changed;
};

const resolveRankTier = (rating) => {
  if (rating >= 2400) return 'Conqueror';
  if (rating >= 1800) return 'Ace';
  if (rating >= 1300) return 'Crown';
  if (rating >= 900) return 'Diamond';
  if (rating >= 500) return 'Platinum';
  if (rating >= 250) return 'Gold';
  if (rating >= 100) return 'Silver';
  return 'Bronze';
};

const calculateKdRating = (kills, deaths) => {
  const safeKills = Math.max(0, Number(kills || 0));
  const safeDeaths = Math.max(0, Number(deaths || 0));
  const kd = safeDeaths > 0 ? (safeKills / safeDeaths) : safeKills;
  const ratingRaw = Math.round((safeKills * 35) + (kd * 120) - (safeDeaths * 15));
  const rating = Math.max(0, ratingRaw);
  return { rating, kd };
};

const getRankSnapshot = (user) => {
  const kills = Math.max(0, Number(user.sukunaKills || 0));
  const deaths = Math.max(0, Number(user.deaths ?? user.losses ?? 0));
  const wins = Math.max(0, Number(user.wins || 0));
  const { kd } = calculateKdRating(kills, deaths);
  const ratingByWins = wins * 10;
  return {
    rating: ratingByWins,
    kd,
    deaths,
    tier: resolveRankTier(ratingByWins),
  };
};

const normalizeProfileImage = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return null;
  // allow only png/jpeg/webp data URLs and keep payload bounded
  const isAllowed = /^data:image\/(png|jpeg|jpg|webp);base64,[a-z0-9+/=]+$/i.test(raw);
  if (!isAllowed) return null;
  if (raw.length > 2_000_000) return null;
  return raw;
};

// In-memory store for demo purposes
const pending = new Map(); // email -> { code, password }

// Configure transporter via env vars if nodemailer is available
let transporter;
if (nodemailer) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.example.com',
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER || 'user',
      pass: process.env.SMTP_PASS || 'pass',
    }
  });
} else {
  transporter = {
    sendMail: async () => { throw new Error('nodemailer not available'); }
  };
}

app.post('/api/register', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.json({ ok: false, message: 'Missing fields' });
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  pending.set(email, { code, password });
  try {
    await transporter.sendMail({
      from: process.env.FROM_EMAIL || 'no-reply@example.com',
      to: email,
      subject: 'Your verification code',
      text: `Your verification code is: ${code}`,
    });
    return res.json({ ok: true });
  } catch (e) {
    console.error('mail error', e);
    return res.json({ ok: false, message: 'Failed to send email' });
  }
});

app.post('/api/verify', (req, res) => {
  const { email, code } = req.body || {};
  const entry = pending.get(email);
  if (!entry) return res.json({ ok: false, message: 'No pending registration' });
  if (entry.code !== String(code)) return res.json({ ok: false, message: 'Invalid code' });
  // In a real app persist user to DB. Here we just remove pending and return success.
  pending.delete(email);
  return res.json({ ok: true });
});

app.post('/api/login', (req, res) => {
  const { email, password } = req.body || {};
  // In this demo there is no DB; accept login if no pending entry and simple check
  // For a production app, check hashed password from DB
  if (!email || !password) return res.json({ ok: false, message: 'Missing fields' });
  // If user had a pending entry it's still not verified (fail)
  if (pending.has(email)) return res.json({ ok: false, message: 'Email not verified' });
  // Demo: accept any password after verification
  return res.json({ ok: true });
});

app.post('/api/profile/register', async (req, res) => {
  const username = String(req.body?.username || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  if (!username) return res.json({ ok: false, message: 'Username required' });
  if (password.length < 4) return res.json({ ok: false, message: 'Password min 4 chars' });
  const users = await readUsers();
  const preChanged = ensureUserIdsAndFriends(users);
  if (preChanged) await writeUsers(users);
  if (users.some((u) => u.username === username)) {
    return res.json({ ok: false, message: 'User already exists' });
  }
  const taken = new Set(users.map((u) => u.userId).filter(Boolean));
  const userId = createUserId(taken);
  users.push({
    username,
    userId,
    password,
    friends: [],
    walletVersion: 2,
    vales: 0,
    ownedCharacters: ['gojo'],
    videoRewardAt: 0,
    telegramUsername: null,
    blocked: false,
    linkCode: null,
    linkCodeExpiresAt: 0,
    rating: 0,
    sukunaKills: 0,
    deaths: 0,
    trophies: 0,
    wins: 0,
    losses: 0,
    matches: 0,
    profileImage: null,
  });
  await writeUsers(users);
  return res.json({ ok: true, userId });
});

app.post('/api/profile/login', async (req, res) => {
  const username = String(req.body?.username || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  if (!username || !password) return res.json({ ok: false, message: 'Missing fields' });
  const users = await readUsers();
  const changed = ensureUserIdsAndFriends(users);
  const found = users.find((u) => u.username === username);
  if (!found || found.password !== password) {
    return res.json({ ok: false, message: 'Login or password invalid' });
  }
  if (found.blocked) {
    return res.json({ ok: false, message: 'Account is blocked' });
  }
  if (changed) await writeUsers(users);
  return res.json({ ok: true, userId: found.userId });
});

app.post('/api/profile/rank/get', async (req, res) => {
  const username = String(req.body?.username || '').trim().toLowerCase();
  if (!username) return res.json({ ok: false, message: 'Username required' });
  const users = await readUsers();
  const changed = ensureUserIdsAndFriends(users);
  const user = users.find((u) => u.username === username);
  if (!user) return res.json({ ok: false, message: 'User not found' });
  const rank = getRankSnapshot(user);
  const ratingChanged = Number(user.rating ?? 0) !== Number(rank.rating ?? 0);
  user.rating = rank.rating;
  if (changed || ratingChanged) await writeUsers(users);
  return res.json({
    ok: true,
    username: user.username,
    userId: user.userId,
    rating: rank.rating,
    tier: rank.tier,
    kd: Number(rank.kd.toFixed(2)),
    sukunaKills: user.sukunaKills,
    deaths: rank.deaths,
    trophies: user.trophies,
    wins: user.wins,
    losses: user.losses,
    matches: user.matches,
    profileImage: user.profileImage,
    vales: Number(user.vales || 0),
  });
});

app.post('/api/profile/avatar/set', async (req, res) => {
  const username = String(req.body?.username || '').trim().toLowerCase();
  const profileImage = normalizeProfileImage(req.body?.profileImage);
  if (!username) return res.json({ ok: false, message: 'Username required' });
  const users = await readUsers();
  const idx = users.findIndex((u) => u.username === username);
  if (idx < 0) return res.json({ ok: false, message: 'User not found' });
  if (users[idx].blocked) return res.json({ ok: false, message: 'Account is blocked' });
  users[idx].profileImage = profileImage;
  await writeUsers(users);
  return res.json({ ok: true, profileImage: users[idx].profileImage });
});

app.post('/api/profile/rank/apply-match', async (req, res) => {
  const username = String(req.body?.username || '').trim().toLowerCase();
  const result = String(req.body?.result || '').trim().toLowerCase();
  const kills = Math.max(0, Number(req.body?.kills || 0));
  if (!username || !['win', 'lose'].includes(result)) {
    return res.json({ ok: false, message: 'Invalid fields' });
  }
  const users = await readUsers();
  const idx = users.findIndex((u) => u.username === username);
  if (idx < 0) return res.json({ ok: false, message: 'User not found' });
  if (users[idx].blocked) return res.json({ ok: false, message: 'Account is blocked' });

  const prevRank = getRankSnapshot(users[idx]);
  users[idx].matches = Number(users[idx].matches || 0) + 1;
  if (result === 'win') {
    users[idx].wins = Number(users[idx].wins || 0) + 1;
    users[idx].trophies = Number(users[idx].trophies || 0) + 5;
  } else {
    users[idx].losses = Number(users[idx].losses || 0) + 1;
    users[idx].deaths = Math.max(0, Number(users[idx].deaths || 0) + 1);
  }
  const nextRank = getRankSnapshot(users[idx]);
  users[idx].rating = nextRank.rating;
  const delta = nextRank.rating - prevRank.rating;
  await writeUsers(users);
  return res.json({
    ok: true,
    rating: nextRank.rating,
    tier: nextRank.tier,
    kd: Number(nextRank.kd.toFixed(2)),
    deaths: nextRank.deaths,
    sukunaKills: users[idx].sukunaKills,
    trophies: users[idx].trophies,
    wins: users[idx].wins,
    losses: users[idx].losses,
    matches: users[idx].matches,
    delta,
  });
});

app.post('/api/profile/rank/add-sukuna-kills', async (req, res) => {
  const username = String(req.body?.username || '').trim().toLowerCase();
  const count = Math.max(0, Math.floor(Number(req.body?.count || 0)));
  if (!username || count <= 0) return res.json({ ok: false, message: 'Invalid fields' });
  const users = await readUsers();
  const idx = users.findIndex((u) => u.username === username);
  if (idx < 0) return res.json({ ok: false, message: 'User not found' });
  if (users[idx].blocked) return res.json({ ok: false, message: 'Account is blocked' });
  users[idx].sukunaKills = Number(users[idx].sukunaKills || 0) + count;
  users[idx].trophies = Number(users[idx].trophies || 0) + count;
  const rank = getRankSnapshot(users[idx]);
  users[idx].rating = rank.rating;
  await writeUsers(users);
  return res.json({
    ok: true,
    sukunaKills: users[idx].sukunaKills,
    trophies: users[idx].trophies,
    rating: rank.rating,
    kd: Number(rank.kd.toFixed(2)),
    deaths: rank.deaths,
  });
});

app.post('/api/profile/rank/leaderboard', async (req, res) => {
  const limitRaw = Number(req.body?.limit || 100);
  const limit = Math.max(1, Math.min(100, Number.isFinite(limitRaw) ? Math.floor(limitRaw) : 100));
  const users = await readUsers();
  const rows = users
    .filter((u) => !u.blocked)
    .map((u) => {
      const rank = getRankSnapshot(u);
      return { ...u, rating: rank.rating, kd: rank.kd, deaths: rank.deaths, tier: rank.tier };
    })
    .sort((a, b) => {
      if (b.rating !== a.rating) return b.rating - a.rating;
      if (b.kd !== a.kd) return b.kd - a.kd;
      return b.sukunaKills - a.sukunaKills;
    })
    .slice(0, limit)
    .map((u, idx) => ({
      position: idx + 1,
      username: u.username,
      rating: u.rating,
      tier: u.tier,
      kd: Number(u.kd.toFixed(2)),
      sukunaKills: u.sukunaKills,
      deaths: u.deaths,
      trophies: u.trophies,
      wins: u.wins,
      losses: u.losses,
      matches: u.matches,
    }));
  return res.json({ ok: true, rows });
});

const SHOP_PACKAGES = [
  { id: 'vales_500', label: '500 Vales', vales: 500, priceUzs: 10000 },
  { id: 'vales_1200', label: '1200 Vales', vales: 1200, priceUzs: 24000 },
  { id: 'vales_2500', label: '2500 Vales', vales: 2500, priceUzs: 50000 },
];

const getCharacterPrices = async () => {
  const characters = await readCharacters();
  return Object.fromEntries(
    characters
      .filter((c) => Number(c.price || 0) > 0)
      .map((c) => [c.id, Number(c.price || 0)])
  );
};

app.post('/api/characters/catalog', async (_req, res) => {
  const characters = await readCharacters();
  return res.json({ ok: true, characters });
});

app.post('/api/admin/characters/create', async (req, res) => {
  const adminKey = String(req.body?.adminKey || '').trim();
  const expectedAdminKey = String(process.env.ADMIN_API_KEY || process.env.BOT_API_KEY || '').trim();
  if (!expectedAdminKey || adminKey !== expectedAdminKey) {
    return res.status(401).json({ ok: false, message: 'Unauthorized' });
  }
  const id = sanitizeCharacterId(req.body?.id);
  const label = String(req.body?.name || '').trim();
  const price = Math.max(0, Number(req.body?.price || 0));
  const files = req.body?.files || {};
  if (!id || !label) return res.json({ ok: false, message: 'Missing fields' });

  const modelRaw = decodeDataUrlToBuffer(files.modelGlb);
  const idleRaw = decodeDataUrlToBuffer(files.idleFbx);
  const deathRaw = decodeDataUrlToBuffer(files.deathFbx);
  const walkRaw = decodeDataUrlToBuffer(files.walkFbx);
  const runRaw = decodeDataUrlToBuffer(files.runFbx);
  if (!modelRaw || !idleRaw || !deathRaw || !walkRaw) {
    return res.json({ ok: false, message: 'model/idle/death/walk files are required' });
  }
  if (modelRaw.mime !== 'model/gltf-binary') return res.json({ ok: false, message: 'modelGlb must be glb' });
  for (const raw of [idleRaw, deathRaw, walkRaw, runRaw].filter(Boolean)) {
    if (raw.mime !== 'application/octet-stream' && raw.mime !== 'model/fbx') {
      return res.json({ ok: false, message: 'fbx files are invalid' });
    }
  }

  const modelFileName = sanitizeFileName(req.body?.modelFileName, `${id}.glb`);
  const idleFileName = sanitizeFileName(req.body?.idleFileName, 'odiy turish.fbx');
  const deathFileName = sanitizeFileName(req.body?.deathFileName, 'tugash olim.fbx');
  const walkFileName = sanitizeFileName(req.body?.walkFileName, 'yurish.fbx');
  const runFileName = sanitizeFileName(req.body?.runFileName, 'running.fbx');
  const baseDir = path.join(__dirname, '..', 'public', 'models', 'characters', id);
  const animsDir = path.join(baseDir, 'anims');
  await fs.mkdir(animsDir, { recursive: true });

  await fs.writeFile(path.join(baseDir, modelFileName), modelRaw.buffer);
  await fs.writeFile(path.join(animsDir, idleFileName), idleRaw.buffer);
  await fs.writeFile(path.join(animsDir, deathFileName), deathRaw.buffer);
  await fs.writeFile(path.join(animsDir, walkFileName), walkRaw.buffer);
  if (runRaw) {
    await fs.writeFile(path.join(animsDir, runFileName), runRaw.buffer);
  }

  const character = {
    id,
    label,
    price,
    modelPath: toPublicUrl('models', 'characters', id, modelFileName),
    walkAnimPath: toPublicUrl('models', 'characters', id, 'anims', walkFileName),
    runAnimPath: runRaw ? toPublicUrl('models', 'characters', id, 'anims', runFileName) : undefined,
    idleAnimPath: toPublicUrl('models', 'characters', id, 'anims', idleFileName),
    deathAnimPath: toPublicUrl('models', 'characters', id, 'anims', deathFileName),
    menuScale: Number(req.body?.tuning?.menuScale || 0.43),
    menuPosition: Array.isArray(req.body?.tuning?.menuPosition) && req.body.tuning.menuPosition.length === 3 ? req.body.tuning.menuPosition : [1.55, -1.35, 0],
    gameScale: Number(req.body?.tuning?.gameScale || 0.025),
    gameModelOffset: Array.isArray(req.body?.tuning?.gameModelOffset) && req.body.tuning.gameModelOffset.length === 3 ? req.body.tuning.gameModelOffset : [0, 0, 0],
    gameCameraOffset: Array.isArray(req.body?.tuning?.gameCameraOffset) && req.body.tuning.gameCameraOffset.length === 3 ? req.body.tuning.gameCameraOffset : [0, 0, 0],
  };

  const characters = await readCharacters();
  const next = characters.filter((c) => c.id !== id).concat(character);
  await writeCharacters(next);
  return res.json({ ok: true, character });
});

app.post('/api/wallet/get', async (req, res) => {
  const username = String(req.body?.username || '').trim().toLowerCase();
  if (!username) return res.json({ ok: false, message: 'Username required' });
  const users = await readUsers();
  const changed = ensureUserIdsAndFriends(users);
  const user = users.find((u) => u.username === username);
  if (!user) return res.json({ ok: false, message: 'User not found' });
  if (changed) await writeUsers(users);
  return res.json({
    ok: true,
    vales: Math.max(0, Number(user.vales || 0)),
    ownedCharacters: Array.isArray(user.ownedCharacters) ? user.ownedCharacters : ['gojo'],
  });
});

app.post('/api/wallet/shop/catalog', async (_req, res) => {
  const characterPrices = await getCharacterPrices();
  const characters = await readCharacters();
  return res.json({
    ok: true,
    packages: SHOP_PACKAGES,
    characterPrices,
    characters,
  });
});

app.post('/api/wallet/character/purchase', async (req, res) => {
  const username = String(req.body?.username || '').trim().toLowerCase();
  const characterId = String(req.body?.characterId || '').trim().toLowerCase();
  if (!username || !characterId) return res.json({ ok: false, message: 'Missing fields' });
  const characterPrices = await getCharacterPrices();
  const price = Number(characterPrices[characterId] || 0);
  if (price <= 0) return res.json({ ok: false, message: 'Character not purchasable' });
  const users = await readUsers();
  const changed = ensureUserIdsAndFriends(users);
  const idx = users.findIndex((u) => u.username === username);
  if (idx < 0) return res.json({ ok: false, message: 'User not found' });
  const owned = Array.isArray(users[idx].ownedCharacters) ? users[idx].ownedCharacters : ['gojo'];
  const vales = Math.max(0, Number(users[idx].vales || 0));
  if (owned.includes(characterId)) {
    if (changed) await writeUsers(users);
    return res.json({ ok: true, vales, ownedCharacters: owned });
  }
  if (vales < price) return res.json({ ok: false, message: 'Not enough vales', vales, ownedCharacters: owned });
  users[idx].vales = vales - price;
  users[idx].ownedCharacters = owned.concat(characterId);
  await writeUsers(users);
  return res.json({
    ok: true,
    vales: users[idx].vales,
    ownedCharacters: users[idx].ownedCharacters,
  });
});

app.post('/api/wallet/topup/request', async (req, res) => {
  const username = String(req.body?.username || '').trim().toLowerCase();
  const packageId = String(req.body?.packageId || '').trim();
  const receiptImage = String(req.body?.receiptImage || '').trim();
  if (!username || !packageId || !receiptImage) return res.json({ ok: false, message: 'Missing fields' });
  if (!/^data:image\/(png|jpeg|jpg|webp);base64,[a-z0-9+/=]+$/i.test(receiptImage)) {
    return res.json({ ok: false, message: 'Receipt image invalid' });
  }
  if (receiptImage.length > 2_000_000) return res.json({ ok: false, message: 'Receipt image too large' });
  const pack = SHOP_PACKAGES.find((p) => p.id === packageId);
  if (!pack) return res.json({ ok: false, message: 'Package not found' });

  const users = await readUsers();
  const idx = users.findIndex((u) => u.username === username);
  if (idx < 0) return res.json({ ok: false, message: 'User not found' });

  const requests = await readTopups();
  const activePending = requests.find((r) => r.username === username && r.status === 'pending');
  if (activePending) return res.json({ ok: false, message: 'Pending request already exists' });

  const id = `tp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  requests.unshift({
    id,
    username,
    packageId: pack.id,
    packageLabel: pack.label,
    vales: pack.vales,
    priceUzs: Number(pack.priceUzs || 0),
    receiptImage,
    status: 'pending',
    createdAt: Date.now(),
    reviewedAt: 0,
    reviewer: null,
    rejectReason: null,
  });
  await writeTopups(requests);
  return res.json({ ok: true, requestId: id, vales: pack.vales });
});

app.post('/api/wallet/reward/video', async (req, res) => {
  const username = String(req.body?.username || '').trim().toLowerCase();
  if (!username) return res.json({ ok: false, message: 'Username required' });
  const users = await readUsers();
  const idx = users.findIndex((u) => u.username === username);
  if (idx < 0) return res.json({ ok: false, message: 'User not found' });
  const now = Date.now();
  const lastAt = Number(users[idx].videoRewardAt || 0);
  const cooldownMs = 30 * 60 * 1000;
  if (lastAt > 0 && (now - lastAt) < cooldownMs) {
    const leftSec = Math.ceil((cooldownMs - (now - lastAt)) / 1000);
    return res.json({ ok: false, message: `Video reward cooldown: ${leftSec}s` });
  }
  const bonus = 30;
  users[idx].vales = Math.max(0, Number(users[idx].vales || 0)) + bonus;
  users[idx].videoRewardAt = now;
  await writeUsers(users);
  return res.json({ ok: true, bonus, vales: users[idx].vales, nextAt: now + cooldownMs });
});

app.post('/api/bot/topup/pending', async (req, res) => {
  const apiKey = String(req.headers['x-bot-api-key'] || '');
  if (!BOT_API_KEY || apiKey !== BOT_API_KEY) return res.status(401).json({ ok: false, message: 'Unauthorized' });
  const actor = String(req.body?.actorTelegramUsername || '').trim().toLowerCase();
  if (!BOT_ADMIN_USERNAME || actor !== BOT_ADMIN_USERNAME) return res.status(403).json({ ok: false, message: 'Forbidden' });
  const requests = await readTopups();
  const rows = requests.filter((r) => r.status === 'pending').slice(0, 20);
  return res.json({ ok: true, rows });
});

app.post('/api/bot/topup/resolve', async (req, res) => {
  const apiKey = String(req.headers['x-bot-api-key'] || '');
  if (!BOT_API_KEY || apiKey !== BOT_API_KEY) return res.status(401).json({ ok: false, message: 'Unauthorized' });
  const actor = String(req.body?.actorTelegramUsername || '').trim().toLowerCase();
  if (!BOT_ADMIN_USERNAME || actor !== BOT_ADMIN_USERNAME) return res.status(403).json({ ok: false, message: 'Forbidden' });
  const requestId = String(req.body?.requestId || '').trim();
  const action = String(req.body?.action || '').trim().toLowerCase();
  const rejectReason = String(req.body?.reason || '').trim();
  if (!requestId || !['approve', 'reject'].includes(action)) return res.json({ ok: false, message: 'Invalid fields' });

  const requests = await readTopups();
  const idx = requests.findIndex((r) => r.id === requestId);
  if (idx < 0) return res.json({ ok: false, message: 'Request not found' });
  if (requests[idx].status !== 'pending') return res.json({ ok: false, message: 'Request already resolved' });

  requests[idx].status = action === 'approve' ? 'approved' : 'rejected';
  requests[idx].reviewedAt = Date.now();
  requests[idx].reviewer = actor;
  requests[idx].rejectReason = action === 'reject' ? (rejectReason || 'rejected') : null;

  let userVales = null;
  if (action === 'approve') {
    const users = await readUsers();
    const uidx = users.findIndex((u) => u.username === requests[idx].username);
    if (uidx < 0) return res.json({ ok: false, message: 'User not found' });
    users[uidx].vales = Math.max(0, Number(users[uidx].vales || 0)) + Math.max(0, Number(requests[idx].vales || 0));
    userVales = users[uidx].vales;
    await writeUsers(users);
  }

  await writeTopups(requests);
  return res.json({ ok: true, request: requests[idx], userVales });
});

app.post('/api/profile/friends/list', async (req, res) => {
  const username = String(req.body?.username || '').trim().toLowerCase();
  if (!username) return res.json({ ok: false, message: 'Username required' });
  const users = await readUsers();
  const changed = ensureUserIdsAndFriends(users);
  const me = users.find((u) => u.username === username);
  if (!me) return res.json({ ok: false, message: 'User not found' });

  const rows = (me.friends || [])
    .map((fid) => users.find((u) => u.userId === fid))
    .filter(Boolean)
    .map((u) => ({ userId: u.userId, username: u.username }));

  if (changed) await writeUsers(users);
  return res.json({ ok: true, friends: rows, userId: me.userId, username: me.username });
});

app.post('/api/profile/friends/add-by-id', async (req, res) => {
  const username = String(req.body?.username || '').trim().toLowerCase();
  const friendUserId = String(req.body?.friendUserId || '').trim().toUpperCase();
  if (!username || !friendUserId) return res.json({ ok: false, message: 'Missing fields' });

  const users = await readUsers();
  ensureUserIdsAndFriends(users);

  const me = users.find((u) => u.username === username);
  if (!me) return res.json({ ok: false, message: 'User not found' });
  if (me.userId === friendUserId) return res.json({ ok: false, message: 'Cannot add yourself' });
  const friend = users.find((u) => u.userId === friendUserId);
  if (!friend) return res.json({ ok: false, message: 'Friend ID not found' });

  if (!me.friends.includes(friend.userId)) me.friends.push(friend.userId);
  if (!friend.friends.includes(me.userId)) friend.friends.push(me.userId);
  await writeUsers(users);

  const rows = (me.friends || [])
    .map((fid) => users.find((u) => u.userId === fid))
    .filter(Boolean)
    .map((u) => ({ userId: u.userId, username: u.username }));

  return res.json({
    ok: true,
    message: 'Friend added',
    friend: { userId: friend.userId, username: friend.username },
    friends: rows,
    userId: me.userId,
    username: me.username,
  });
});

app.post('/api/profile/change-password', async (req, res) => {
  const username = String(req.body?.username || '').trim().toLowerCase();
  const oldPassword = String(req.body?.oldPassword || '');
  const newPassword = String(req.body?.newPassword || '');
  if (!username || !oldPassword || !newPassword) return res.json({ ok: false, message: 'Missing fields' });
  if (newPassword.length < 4) return res.json({ ok: false, message: 'Password min 4 chars' });
  const users = await readUsers();
  const idx = users.findIndex((u) => u.username === username);
  if (idx < 0) return res.json({ ok: false, message: 'User not found' });
  if (users[idx].blocked) return res.json({ ok: false, message: 'Account is blocked' });
  if (users[idx].password !== oldPassword) return res.json({ ok: false, message: 'Old password invalid' });
  users[idx].password = newPassword;
  await writeUsers(users);
  return res.json({ ok: true });
});

app.post('/api/profile/link-telegram', async (req, res) => {
  const username = String(req.body?.username || '').trim().toLowerCase();
  const telegramUsername = String(req.body?.telegramUsername || '').trim().toLowerCase();
  if (!username || !telegramUsername) return res.json({ ok: false, message: 'Missing fields' });
  const users = await readUsers();
  const idx = users.findIndex((u) => u.username === username);
  if (idx < 0) return res.json({ ok: false, message: 'User not found' });
  if (users[idx].blocked) return res.json({ ok: false, message: 'Account is blocked' });
  users[idx].telegramUsername = telegramUsername;
  await writeUsers(users);
  return res.json({ ok: true });
});

app.post('/api/profile/link-code/create', async (req, res) => {
  const username = String(req.body?.username || '').trim().toLowerCase();
  if (!username) return res.json({ ok: false, message: 'Username required' });
  const users = await readUsers();
  const idx = users.findIndex((u) => u.username === username);
  if (idx < 0) return res.json({ ok: false, message: 'User not found' });
  if (users[idx].blocked) return res.json({ ok: false, message: 'Account is blocked' });
  const code = createLinkCode();
  users[idx].linkCode = code;
  users[idx].linkCodeExpiresAt = Date.now() + (10 * 60 * 1000);
  await writeUsers(users);
  return res.json({ ok: true, code, expiresInSec: 600 });
});

app.post('/api/profile/link-code/confirm', async (req, res) => {
  const apiKey = String(req.headers['x-bot-api-key'] || '');
  if (!BOT_API_KEY || apiKey !== BOT_API_KEY) {
    return res.status(401).json({ ok: false, message: 'Unauthorized' });
  }
  const code = String(req.body?.code || '').trim().toUpperCase();
  const telegramUsername = String(req.body?.telegramUsername || '').trim().toLowerCase();
  if (!code || !telegramUsername) return res.json({ ok: false, message: 'Missing fields' });
  const users = await readUsers();
  const idx = users.findIndex((u) => u.linkCode === code && Number(u.linkCodeExpiresAt || 0) > Date.now());
  if (idx < 0) return res.json({ ok: false, message: 'Code invalid or expired' });
  users[idx].telegramUsername = telegramUsername;
  users[idx].linkCode = null;
  users[idx].linkCodeExpiresAt = 0;
  await writeUsers(users);
  return res.json({ ok: true, username: users[idx].username });
});

app.post('/api/profile/reset-from-telegram', async (req, res) => {
  const apiKey = String(req.headers['x-bot-api-key'] || '');
  if (!BOT_API_KEY || apiKey !== BOT_API_KEY) {
    return res.status(401).json({ ok: false, message: 'Unauthorized' });
  }
  const username = String(req.body?.username || '').trim().toLowerCase();
  const telegramUsername = String(req.body?.telegramUsername || '').trim().toLowerCase();
  const newPassword = String(req.body?.newPassword || '');
  if (!username || !telegramUsername || !newPassword) {
    return res.json({ ok: false, message: 'Missing fields' });
  }
  if (newPassword.length < 4) return res.json({ ok: false, message: 'Password min 4 chars' });
  const users = await readUsers();
  const idx = users.findIndex((u) => u.username === username);
  if (idx < 0) return res.json({ ok: false, message: 'User not found' });
  if (users[idx].blocked) return res.json({ ok: false, message: 'Account is blocked' });
  if (!users[idx].telegramUsername || users[idx].telegramUsername !== telegramUsername) {
    return res.json({ ok: false, message: 'Telegram account is not linked' });
  }
  users[idx].password = newPassword;
  await writeUsers(users);
  return res.json({ ok: true });
});

app.post('/api/profile/reset-self-from-telegram', async (req, res) => {
  const apiKey = String(req.headers['x-bot-api-key'] || '');
  if (!BOT_API_KEY || apiKey !== BOT_API_KEY) {
    return res.status(401).json({ ok: false, message: 'Unauthorized' });
  }
  const telegramUsername = String(req.body?.telegramUsername || '').trim().toLowerCase();
  const newPassword = String(req.body?.newPassword || '');
  if (!telegramUsername || !newPassword) {
    return res.json({ ok: false, message: 'Missing fields' });
  }
  if (newPassword.length < 4) return res.json({ ok: false, message: 'Password min 4 chars' });
  const users = await readUsers();
  const idx = users.findIndex((u) => (u.telegramUsername || '') === telegramUsername);
  if (idx < 0) return res.json({ ok: false, message: 'Telegram account is not linked' });
  if (users[idx].blocked) return res.json({ ok: false, message: 'Account is blocked' });
  users[idx].password = newPassword;
  await writeUsers(users);
  return res.json({ ok: true, username: users[idx].username });
});

app.post('/api/profile/admin/block', async (req, res) => {
  const apiKey = String(req.headers['x-bot-api-key'] || '');
  const actor = String(req.body?.actorTelegramUsername || '').trim().toLowerCase();
  if (!BOT_API_KEY || apiKey !== BOT_API_KEY) {
    return res.status(401).json({ ok: false, message: 'Unauthorized' });
  }
  if (!BOT_ADMIN_USERNAME || actor !== BOT_ADMIN_USERNAME) {
    return res.status(403).json({ ok: false, message: 'Forbidden' });
  }
  const username = String(req.body?.username || '').trim().toLowerCase();
  const blocked = Boolean(req.body?.blocked);
  if (!username) return res.json({ ok: false, message: 'Username required' });
  const users = await readUsers();
  const idx = users.findIndex((u) => u.username === username);
  if (idx < 0) return res.json({ ok: false, message: 'User not found' });
  users[idx].blocked = blocked;
  await writeUsers(users);
  return res.json({ ok: true, blocked });
});

const port = Number(process.env.PORT || 3000);
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
// rooms: code -> { host: ws, clients: Set<ws> }
const rooms = new Map();

wss.on('connection', (ws) => {
  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      const { type, roomCode, name } = data;
      if (type === 'host') {
        if (!roomCode) return;
        rooms.set(roomCode, { host: ws, clients: new Set() });
        ws.roomCode = roomCode;
        ws.send(JSON.stringify({ type: 'host:ack', roomCode }));
      } else if (type === 'join') {
        const room = rooms.get(roomCode);
        if (!room) {
          ws.send(JSON.stringify({ type: 'join:fail', message: 'Room not found' }));
          return;
        }
        room.clients.add(ws);
        ws.roomCode = roomCode;
        // notify host
        if (room.host && room.host.readyState === 1) {
          room.host.send(JSON.stringify({ type: 'player:joined', name: name || 'Player' }));
        }
        ws.send(JSON.stringify({ type: 'join:ok', roomCode }));
      } else if (type === 'broadcast') {
        const room = rooms.get(roomCode);
        if (!room) return;
        // send to all clients and host
        const payload = JSON.stringify({ type: 'broadcast', from: name, payload: data.payload });
        room.clients.forEach((c) => { if (c.readyState === 1) c.send(payload); });
        if (room.host && room.host.readyState === 1) room.host.send(payload);
      }
    } catch (e) {
      console.error('ws parse error', e);
    }
  });

  ws.on('close', () => {
    const roomCode = ws.roomCode;
    if (!roomCode) return;
    const room = rooms.get(roomCode);
    if (!room) return;
    // remove from clients, if host closed remove whole room
    if (room.host === ws) {
      room.clients.forEach((c) => { if (c.readyState === 1) c.send(JSON.stringify({ type: 'room:closed' })); });
      rooms.delete(roomCode);
    } else {
      room.clients.delete(ws);
      if (room.host && room.host.readyState === 1) room.host.send(JSON.stringify({ type: 'player:left' }));
    }
  });
});

server.listen(port, () => {
  console.log('HTTP+WS server listening on', port);
});
