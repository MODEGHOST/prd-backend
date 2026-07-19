-- Give Company Admin complete functional access while keeping role hierarchy
-- enforcement in the application layer.
INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.name = 'company_admin' AND r.company_id IS NULL;

-- Custom roles must not become hidden company administrators.
DELETE rp
FROM role_permissions rp
JOIN roles r ON r.id = rp.role_id
JOIN permissions p ON p.id = rp.permission_id
WHERE r.is_system = FALSE
  AND p.code IN ('company.manage', 'members.manage', 'roles.manage');

UPDATE permissions
SET description = CASE code
  WHEN 'company.manage' THEN 'จัดการการตั้งค่าบริษัท'
  WHEN 'company.switch' THEN 'สลับบริษัทที่ใช้งาน'
  WHEN 'members.read' THEN 'ดูรายชื่อสมาชิกบริษัท'
  WHEN 'members.manage' THEN 'อนุมัติและจัดการสมาชิกบริษัท'
  WHEN 'roles.manage' THEN 'จัดการและมอบหมายบทบาท'
  WHEN 'projects.read_all' THEN 'ดูทุกโครงการในบริษัท'
  WHEN 'projects.manage_all' THEN 'จัดการทุกโครงการในบริษัท'
  WHEN 'projects.create' THEN 'สร้างโครงการ'
  WHEN 'projects.update' THEN 'แก้ไขโครงการที่เข้าถึงได้'
  WHEN 'projects.members.manage' THEN 'จัดการสมาชิกโครงการ'
  WHEN 'projects.status.update' THEN 'เปลี่ยนสถานะโครงการ'
  WHEN 'projects.plan.manage' THEN 'จัดการแผนงานรายสัปดาห์'
  WHEN 'projects.chat' THEN 'ส่งข้อความในแชทโครงการ'
  WHEN 'issues.read_all' THEN 'ดูทุก Ticket และแชทในบริษัท'
  WHEN 'issues.manage_all' THEN 'จัดการทุก Ticket ในบริษัท'
  WHEN 'issues.create' THEN 'สร้าง Ticket'
  WHEN 'issues.accept' THEN 'รับ Ticket เพื่อดำเนินการ'
  WHEN 'issues.assign' THEN 'มอบหมายผู้รับผิดชอบ Ticket'
  WHEN 'issues.update' THEN 'แก้ไขรายละเอียด Ticket'
  WHEN 'issues.transition' THEN 'เปลี่ยนสถานะขั้นตอน Ticket'
  WHEN 'issues.members.manage' THEN 'จัดการผู้เข้าร่วม Ticket'
  WHEN 'issues.comment' THEN 'แสดงความคิดเห็นใน Ticket'
  WHEN 'tasks.manage_all' THEN 'จัดการทุกงานในบริษัท'
  WHEN 'tasks.create' THEN 'สร้างงานในโครงการ'
  WHEN 'tasks.update' THEN 'แก้ไขงานที่ได้รับมอบหมายหรือดูแล'
  WHEN 'audit.read' THEN 'ดูบันทึกการตรวจสอบบริษัท'
  ELSE description
END;
