export const SESSION_COOKIE_NAME = "projecthub_token";

function parseDurationMs(value) {
  const match = String(value || "8h").match(/^(\d+)(ms|s|m|h|d|w|y)$/);
  if (!match) return 8 * 60 * 60 * 1000;
  const amount = Number(match[1]);
  const unit = match[2];
  const multipliers = {
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 604_800_000,
    y: 31_536_000_000,
  };
  return amount * (multipliers[unit] || multipliers.h);
}

export function sessionCookieOptions(config) {
  return {
    httpOnly: true,
    secure: Boolean(config.cookie.secure),
    sameSite: config.cookie.sameSite,
    path: "/",
    maxAge: parseDurationMs(config.authTokenTtl),
    ...(config.cookie.domain ? { domain: config.cookie.domain } : {}),
  };
}

export function setSessionCookie(res, token, config) {
  res.cookie(SESSION_COOKIE_NAME, token, sessionCookieOptions(config));
}

export function clearSessionCookie(res, config) {
  res.clearCookie(SESSION_COOKIE_NAME, {
    ...sessionCookieOptions(config),
    maxAge: 0,
  });
}

export function readTokenFromRequest(req) {
  const header = req.headers?.authorization?.replace(/^Bearer\s+/i, "");
  if (header) return header;
  const cookieToken = req.cookies?.[SESSION_COOKIE_NAME];
  if (cookieToken) return cookieToken;
  return null;
}

export function parseCookieHeader(cookieHeader) {
  const out = {};
  for (const part of String(cookieHeader || "").split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

export function readTokenFromSocket(socket) {
  const handshakeAuth = socket.handshake?.auth?.token;
  if (handshakeAuth) return String(handshakeAuth);
  const cookies = parseCookieHeader(socket.handshake?.headers?.cookie);
  return cookies[SESSION_COOKIE_NAME] || null;
}
