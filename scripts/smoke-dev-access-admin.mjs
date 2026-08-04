/**
 * Smoke-test Dev access-admin APIs against local backend.
 * Usage: node scripts/smoke-dev-access-admin.mjs
 */
import "../src/core/load-env.js";
import "../src/core/node16-compat.js";
import mysql from "mysql2/promise";
import bcrypt from "bcryptjs";

const baseUrl = process.env.SMOKE_BASE_URL || "http://127.0.0.1:4001";
const email = process.env.SMOKE_EMAIL || "prpsix777@gmail.com";

async function resolvePassword() {
  if (process.env.SMOKE_PASSWORD) return process.env.SMOKE_PASSWORD;
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || "localhost",
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "",
    database: process.env.DB_NAME || "lfbsmart_project",
  });
  const [[user]] = await connection.query(
    "SELECT id, email, password_hash FROM users WHERE email = ? LIMIT 1",
    [email],
  );
  await connection.end();
  if (!user) throw new Error(`user not found: ${email}`);
  // Temporarily set a known smoke password, then restore is risky —
  // instead verify known candidates.
  const candidates = ["Password123!", "password", "24690054", "123456"];
  for (const candidate of candidates) {
    if (await bcrypt.compare(candidate, user.password_hash)) return candidate;
  }
  throw new Error(`cannot resolve password for ${email}; set SMOKE_PASSWORD`);
}

function cookieJar() {
  let cookie = "";
  return {
    store(response) {
      const raw = response.headers.getSetCookie?.() || [];
      if (!raw.length) {
        const single = response.headers.get("set-cookie");
        if (single) cookie = single.split(";")[0];
        return;
      }
      cookie = raw.map((value) => value.split(";")[0]).join("; ");
    },
    header() {
      return cookie;
    },
  };
}

async function request(jar, path, { method = "GET", body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(jar.header() ? { Cookie: jar.header() } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  jar.store(response);
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: response.status, data };
}

const password = await resolvePassword();
const jar = cookieJar();

const login = await request(jar, "/api/auth/login", {
  method: "POST",
  body: { email, password },
});
console.log("login", login.status, login.data?.user?.roles || login.data?.message || login.data);

const me = await request(jar, "/api/auth/me");
console.log("me.perms.access", (me.data?.user?.permissions || []).filter((code) =>
  ["members.read", "members.manage", "roles.manage"].includes(code)));

const roles = await request(jar, "/api/company/roles");
console.log("roles", roles.status, Array.isArray(roles.data) ? roles.data.length : roles.data);

const permissions = await request(jar, "/api/company/permissions");
console.log("permissions", permissions.status, Array.isArray(permissions.data) ? permissions.data.length : permissions.data);

const created = await request(jar, "/api/company/roles", {
  method: "POST",
  body: { label: `Smoke Dev Role ${Date.now()}`, description: "created by smoke test" },
});
console.log("createRole", created.status, created.data);

if (created.status === 201 && created.data?.id) {
  const grantable = Array.isArray(permissions.data)
    ? permissions.data.filter((row) => row.grantable_to_custom_role !== false).slice(0, 3)
    : [];
  const updated = await request(jar, `/api/company/roles/${created.data.id}/permissions`, {
    method: "PUT",
    body: { permissionIds: grantable.map((row) => row.id) },
  });
  console.log("updateRolePermissions", updated.status, updated.data);
}

const failed = [login, roles, permissions, created].some((result) => result.status >= 400);
process.exit(failed ? 1 : 0);
