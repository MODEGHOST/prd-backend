import assert from "node:assert/strict";
import test from "node:test";
import { passwordPolicyErrors } from "../src/core/password-policy.js";

test("password policy accepts a strong non-Thai password", () => {
  assert.deepEqual(passwordPolicyErrors("ProjectHub!2026"), []);
});

test("password policy reports every missing requirement", () => {
  const errors = passwordPolicyErrors("password");

  assert.ok(errors.includes("รหัสผ่านต้องมีตัวพิมพ์ใหญ่อย่างน้อย 1 ตัว"));
  assert.ok(errors.includes("รหัสผ่านต้องมีอักขระพิเศษอย่างน้อย 1 ตัว"));
});

test("password policy rejects Thai characters", () => {
  assert.ok(
    passwordPolicyErrors("Projectฮับ!").includes("รหัสผ่านต้องไม่มีอักษรภาษาไทย"),
  );
});
