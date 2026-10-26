import * as jose from 'jose';

export const DEMO_HUB_URL = 'https://demos.alexisreyes.com';
export const DEMO_AUDIENCE = 'do-anatomy-demo';
export const DEMO_ISSUER = 'demos.alexisreyes.com';
export const DEMO_SESSION_COOKIE = 'demo_session';
const SESSION_TTL_SEC = 12 * 60 * 60;

/**
 * @param {Record<string, string|undefined>} env
 * @param {{ handoffGate?: boolean, nodeEnv?: string }} [options]
 */
export function handoffConfig(env = process.env, options = {}) {
  const secret = String(env.DEMO_HANDOFF_SECRET || '');
  const nodeEnv = options.nodeEnv ?? env.NODE_ENV ?? '';
  const production = nodeEnv === 'production';
  const gate =
    options.handoffGate !== undefined
      ? options.handoffGate
      : env.DEMO_HANDOFF_GATE === 'false'
        ? false
        : production || secret.length > 0;
  return {
    secret,
    /** Secret is configured (handoff + session JWTs work). */
    enabled: secret.length > 0,
    /** Requests are blocked without a valid demo_session (fail closed in production even with no secret). */
    gate,
    hubUrl: env.DEMO_HUB_URL || DEMO_HUB_URL,
    audience: env.DEMO_AUDIENCE || DEMO_AUDIENCE,
    issuer: env.DEMO_ISSUER || DEMO_ISSUER,
  };
}

function secretKey(secret) {
  return new TextEncoder().encode(secret);
}

/** HS256 handoff JWT from the demos hub (short-lived). */
export async function verifyHandoffToken(token, cfg) {
  if (!cfg.enabled || !token) return { ok: false, reason: 'disabled' };
  try {
    const { payload } = await jose.jwtVerify(token, secretKey(cfg.secret), {
      algorithms: ['HS256'],
      issuer: cfg.issuer,
      audience: cfg.audience,
    });
    if (!payload.jti) return { ok: false, reason: 'missing jti' };
    return { ok: true, payload };
  } catch (err) {
    return { ok: false, reason: err?.code || err?.message || 'invalid' };
  }
}

/** Session cookie JWT (~12h). */
export async function signSessionToken(cfg, { jti } = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new jose.SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setAudience(cfg.audience)
    .setIssuedAt(now)
    .setExpirationTime(now + SESSION_TTL_SEC)
    .setJti(jti || crypto.randomUUID())
    .sign(secretKey(cfg.secret));
}

export async function verifySessionToken(token, cfg) {
  if (!cfg.enabled || !token) return { ok: false };
  try {
    const { payload } = await jose.jwtVerify(token, secretKey(cfg.secret), {
      algorithms: ['HS256'],
      audience: cfg.audience,
    });
    return { ok: true, payload };
  } catch {
    return { ok: false };
  }
}

export function sessionCookieOptions(env = process.env) {
  const secure = env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL_SEC * 1000,
  };
}

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    const key = part.slice(0, i).trim();
    const val = part.slice(i + 1).trim();
    if (key) out[key] = decodeURIComponent(val);
  }
  return out;
}

export function robotsHeaders() {
  return { 'X-Robots-Tag': 'noindex, nofollow' };
}

/** Mint a handoff JWT for local testing (same shape the hub sends). */
export async function mintHandoffToken(cfg, { ttlSec = 60, jti } = {}) {
  if (!cfg.secret) throw new Error('DEMO_HANDOFF_SECRET is not set');
  const now = Math.floor(Date.now() / 1000);
  return new jose.SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(cfg.issuer)
    .setAudience(cfg.audience)
    .setIssuedAt(now)
    .setExpirationTime(now + ttlSec)
    .setJti(jti || crypto.randomUUID())
    .sign(secretKey(cfg.secret));
}

function setSessionCookie(res, name, value, opts) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', `SameSite=${opts.sameSite || 'Lax'}`];
  if (opts.maxAge) parts.push(`Max-Age=${Math.floor(opts.maxAge / 1000)}`);
  if (opts.secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

export function registerHandoffRoutes(app, cfg, env = process.env) {
  app.get('/auth/handoff', async (req, res) => {
    Object.entries(robotsHeaders()).forEach(([k, v]) => res.setHeader(k, v));
    if (!cfg.enabled) return res.redirect(302, cfg.hubUrl);

    const token = String(req.query.token || '');
    const verified = await verifyHandoffToken(token, cfg);
    if (!verified.ok) return res.redirect(302, cfg.hubUrl);

    const sessionJwt = await signSessionToken(cfg, { jti: verified.payload.jti });
    setSessionCookie(res, DEMO_SESSION_COOKIE, sessionJwt, sessionCookieOptions(env));
    return res.redirect(302, '/');
  });
}

/**
 * @param {{ isApiRequest?: (req: import('express').Request) => boolean, isPublic?: (req: import('express').Request) => boolean, allowRequest?: (req: import('express').Request) => boolean | Promise<boolean> }} [opts]
 */
export function createHandoffMiddleware(cfg, opts = {}) {
  const api = opts.isApiRequest || ((req) => req.path.startsWith('/api/'));
  const open = opts.isPublic || (() => false);
  const allowRequest = opts.allowRequest || (async () => false);

  return async (req, res, next) => {
    Object.entries(robotsHeaders()).forEach(([k, v]) => res.setHeader(k, v));
    if (!cfg.gate || open(req)) return next();

    if (await allowRequest(req)) return next();

    const cookies = parseCookies(req.get('cookie'));
    const session = await verifySessionToken(cookies[DEMO_SESSION_COOKIE], cfg);
    if (session.ok) return next();

    if (api(req)) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
    return res.redirect(302, cfg.hubUrl);
  };
}
