# ProjectHub Backend

REST API และระบบแจ้งเตือน พัฒนาด้วย Node.js, Express, MySQL และ Socket.IO

## เตรียมฐานข้อมูลด้วย XAMPP

1. Start MySQL ใน XAMPP
2. Import ตามลำดับใน phpMyAdmin:

### ติดตั้งใหม่ (แนะนำ)
- `database/prdproject.sql`
- `database/seed_mock.sql` (ข้อมูลตัวอย่าง)
- `database/migration_performance_indexes.sql`
- `database/migration_multi_company_rbac.sql`
- `database/migration_production_hardening.sql`
- `database/migration_p0_group_admin_project_approval.sql`
- `database/migration_p1_requester_attachments_invitations.sql`
- `database/migration_p2_chat_attachments.sql`
- `database/migration_p3_project_chat_attachments.sql`
- `database/migration_p4_chat_replies.sql`

### อัปเกรดฐานข้อมูลเดิม (มีข้อมูลอยู่แล้ว)
- สำรองฐานข้อมูลก่อนทุกครั้ง
- รันตามลำดับ: `migration_project_collaboration.sql`,
  `migration_issue_workflow.sql`, `migration_ticket_board.sql`,
  `migration_notification_center.sql`, `migration_performance_indexes.sql`,
  `migration_task_detail.sql`, `migration_multi_company_rbac.sql`,
  `migration_production_hardening.sql`,
  `migration_p0_group_admin_project_approval.sql`,
  `migration_p1_requester_attachments_invitations.sql`,
  `migration_p2_chat_attachments.sql`,
  `migration_p3_project_chat_attachments.sql`,
  `migration_p4_chat_replies.sql`
- migration รุ่นเก่าบางไฟล์เป็น run-once; ห้ามรันซ้ำโดยไม่มี backup
- `migration_performance_indexes.sql` และ `migration_production_hardening.sql`
  ตรวจการมีอยู่ของ object และทดสอบ rerun ใน CI
- `migration_p0_group_admin_project_approval.sql` เป็น idempotent และต้องรันแม้ฐานข้อมูล
  เคยใช้ RBAC migration รุ่นก่อนแล้ว
- `migration_p1_requester_attachments_invitations.sql` เป็น idempotent และต้องรันหลัง P0
- `migration_p2_chat_attachments.sql` เป็น idempotent บน MariaDB 10.4 และต้องรันหลัง P1
- `migration_p3_project_chat_attachments.sql` เป็น idempotent บน MariaDB 10.4 และต้องรันหลัง P2
- `migration_p4_chat_replies.sql` เป็น idempotent บน MariaDB 10.4 และต้องรันหลัง P3
- ห้าม import `seed_mock.sql` บนฐานที่มีข้อมูลจริง เพราะใช้สำหรับ demo/test เท่านั้น

3. สร้างไฟล์ Environment:

```powershell
copy .env.example .env
```

ค่าเริ่มต้นรองรับ MySQL ของ XAMPP และฐานข้อมูล `prdproject`

## เริ่มใช้งาน

```powershell
npm install
npm run dev
```

API: http://localhost:4000  
Health: http://localhost:4000/api/health

## ตรวจสอบก่อนส่งมอบ

```powershell
npm run check
npm test

# ต้องมี schema + seed สำหรับ integration test
npm run test:integration
```

`npm run check` ตรวจ syntax ของทุกไฟล์ใต้ `src` และ integration tests
จะสร้าง/ลบ fixture ของตัวเองโดยไม่ทิ้งข้อมูลทดสอบไว้

## Project collaboration (สรุป)

- สิทธิ์เข้าถึงโครงการ: admin หรือ creator (`created_by`) หรือ owner (`owner_id`) หรือสมาชิกใน `project_members`
- สิทธิ์จัดการโครงการ: admin หรือ creator หรือ owner
- API เพิ่ม: project detail/members, weekly plans, project messages
- Socket: `joinProject({ token, projectId })` เข้าร่วม room `project:{id}` สำหรับแชทโครงการ
