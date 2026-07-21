-- ProjectHub Mock Data
-- Import ไฟล์นี้หลัง schema แล้ว (ฐานข้อมูล: prdproject)
-- รหัสผ่านทุกบัญชี: Password123!

USE prdproject;

-- ล้างข้อมูลเก่า (ถ้าต้องการเริ่มใหม่)
SET FOREIGN_KEY_CHECKS = 0;
TRUNCATE TABLE notifications;
TRUNCATE TABLE comments;
TRUNCATE TABLE tasks;
TRUNCATE TABLE issue_activities;
TRUNCATE TABLE issue_members;
TRUNCATE TABLE issues;
TRUNCATE TABLE project_messages;
TRUNCATE TABLE weekly_plans;
TRUNCATE TABLE project_members;
TRUNCATE TABLE projects;
TRUNCATE TABLE users;
SET FOREIGN_KEY_CHECKS = 1;

-- ผู้ใช้ (password = Password123!)
INSERT INTO users (id, name, email, username, password_hash, role, department) VALUES
(1, 'ผู้ดูแลระบบ', 'admin@projecthub.local', 'admin', '$2b$10$V4jdn9p6oG21IYaGagOenOrKqN/hmI6zY6UCockAQDipdaGblDHEG', 'admin', 'IT'),
(2, 'สมชาย นักพัฒนา', 'developer@projecthub.local', 'developer', '$2b$10$V4jdn9p6oG21IYaGagOenOrKqN/hmI6zY6UCockAQDipdaGblDHEG', 'member', 'Development'),
(3, 'สุดา ทดสอบระบบ', 'qa@projecthub.local', 'qa', '$2b$10$V4jdn9p6oG21IYaGagOenOrKqN/hmI6zY6UCockAQDipdaGblDHEG', 'member', 'QA'),
(4, 'วิภา พนักงานทั่วไป', 'requester@projecthub.local', 'requester', '$2b$10$V4jdn9p6oG21IYaGagOenOrKqN/hmI6zY6UCockAQDipdaGblDHEG', 'requester', 'Operations'),
(5, 'นภา ฝ่ายขาย', 'sales@projecthub.local', 'sales', '$2b$10$V4jdn9p6oG21IYaGagOenOrKqN/hmI6zY6UCockAQDipdaGblDHEG', 'requester', 'Sales');

-- โครงการ (owner_id = main owner, created_by = creator)
INSERT INTO projects (id, name, code, description, prd, status, start_date, end_date, owner_id, approved_by, created_by, budget, currency) VALUES
(1, 'ระบบแจ้งปัญหาภายใน', 'ISSUE-01', 'แพลตฟอร์มรวมศูนย์สำหรับแจ้งปัญหาและติดตามสถานะ', 'ผู้ใช้ทั่วไปแจ้งปัญหาได้ง่าย ทีม IT รับงานและอัปเดตสถานะได้แบบ real-time', 'active', '2026-06-01', '2026-09-30', 1, 1, 1, 250000.00, 'THB'),
(2, 'เว็บไซต์องค์กร', 'WEB-02', 'รีดีไซน์เว็บไซต์องค์กรและหน้า Landing', 'รองรับมือถือ โหลดเร็ว และมีระบบจัดการเนื้อหาเบื้องต้น', 'active', '2026-05-15', '2026-08-31', 1, 1, 1, 180000.00, 'THB'),
(3, 'แอปจองห้องประชุม', 'MEET-03', 'ระบบจองห้องประชุมและอุปกรณ์', 'ปฏิทินจองห้อง แจ้งเตือน และอนุมัติโดยแอดมิน', 'pending', '2026-07-01', '2026-10-15', 2, NULL, 2, 95000.00, 'THB');

INSERT INTO project_members (project_id, user_id, responsibility, joined_at) VALUES
(1, 1, 'Project owner / IT lead', '2026-06-01 09:00:00'),
(1, 2, 'Backend development', '2026-06-01 09:00:00'),
(1, 3, 'QA and regression testing', '2026-06-02 10:00:00'),
(1, 4, 'User acceptance testing and feedback', '2026-06-03 09:30:00'),
(2, 1, 'Project owner', '2026-05-15 09:00:00'),
(2, 2, 'Frontend implementation', '2026-05-16 11:00:00'),
(2, 3, 'Dashboard / QA support', '2026-05-17 10:00:00'),
(2, 5, 'Sales content and user acceptance testing', '2026-05-18 13:00:00'),
(3, 2, 'Creator and project owner', '2026-07-01 09:00:00'),
(3, 3, 'Requirements and QA', '2026-07-02 14:00:00');

-- Weekly plans
INSERT INTO weekly_plans (id, project_id, title, description, week_start, week_end, assignee_id, status, created_by) VALUES
(1, 1, 'Stabilize login and projects list', 'Fix hanging projects page and verify multi-role login', '2026-07-14', '2026-07-20', 2, 'in_progress', 1),
(2, 1, 'Attachment upload spike', 'Explore mobile image upload for issue reports', '2026-07-21', '2026-07-27', 3, 'planned', 1),
(3, 2, 'Mobile layout polish', 'Resolve sidebar/header overlap on small screens', '2026-07-14', '2026-07-20', 2, 'in_progress', 1),
(4, 3, 'Gather meeting-room requirements', 'Interview stakeholders and draft PRD', '2026-07-14', '2026-07-20', 2, 'planned', 2);

-- Project chat messages
INSERT INTO project_messages (project_id, user_id, body, created_at) VALUES
(1, 1, 'เริ่มสปรินต์นี้โฟกัสแก้หน้า Projects ค้างก่อน', '2026-07-14 09:15:00'),
(1, 2, 'รับทราบ กำลังไล่ useEffect และ Promise ในหน้า Projects', '2026-07-14 09:40:00'),
(2, 2, 'ปรับ sidebar ให้คงที่บน desktop แล้ว รอดูบนมือถืออีกครั้ง', '2026-07-15 11:20:00'),
(3, 2, 'นัดสัมภาษณ์ผู้ใช้ห้องประชุมวันพฤหัส', '2026-07-16 10:05:00');

-- Issues
INSERT INTO issues
  (id, ticket_no, title, description, type, priority, status, project_id, requester_id,
   assignee_id, board_status, estimated_completion_at, accepted_at, started_at, completed_at)
VALUES
(1, 'ISS-10000001', 'เข้าสู่ระบบแล้วหน้าค้าง', 'หลังจาก Login สำเร็จ กดเมนูโครงการแล้วหน้าจอค้าง ไม่แสดงข้อมูล', 'bug', 'high', 'in_progress', 1, 4, 2, 'doing', '2026-07-18 17:00:00', '2026-07-14 09:30:00', '2026-07-14 10:00:00', NULL),
(2, 'ISS-10000002', 'ต้องการแนบรูปตอนแจ้งปัญหา', 'อยากให้มีปุ่มแนบรูปจากมือถือตอนแจ้งปัญหาที่หน้างาน', 'feature', 'medium', 'open', 1, 5, NULL, NULL, NULL, NULL, NULL, NULL),
(3, 'ISS-10000003', 'ขอสิทธิ์เข้าใช้ระบบใหม่', 'พนักงานใหม่ต้องการบัญชีสำหรับแจ้งปัญหาและดูสถานะงาน', 'support', 'low', 'closed', 1, 4, 1, 'done', '2026-07-13 12:00:00', '2026-07-13 09:10:00', '2026-07-13 09:15:00', '2026-07-13 10:05:00'),
(4, 'ISS-10000004', 'เมนูมือถือซ้อนทับกัน', 'บนมือถือปุ่มเมนูกับ sidebar ทับกัน มองไม่ชัด', 'bug', 'urgent', 'accepted', 2, 5, 2, 'todo', NULL, '2026-07-16 08:45:00', NULL, NULL),
(5, 'ISS-10000005', 'อยากได้รายงานสรุปรายสัปดาห์', 'ขอหน้า Dashboard ที่สรุปจำนวน Issue ที่ปิดได้ในแต่ละสัปดาห์', 'feature', 'medium', 'accepted', 2, 4, 3, 'todo', NULL, '2026-07-16 14:20:00', NULL, NULL);

INSERT INTO issue_members (issue_id, user_id, added_by, joined_at) VALUES
(1, 3, 2, '2026-07-14 09:45:00');

INSERT INTO issue_activities (issue_id, actor_id, event_type, description, created_at) VALUES
(1, 4, 'created', 'เปิด Ticket', '2026-07-14 09:00:00'),
(1, 2, 'accepted', 'สมชาย นักพัฒนา รับเรื่องและเป็นผู้รับผิดชอบหลัก', '2026-07-14 09:30:00'),
(1, 2, 'members_updated', 'เพิ่ม สุดา ทดสอบระบบ เข้าร่วมงาน', '2026-07-14 09:45:00'),
(1, 2, 'started', 'สมชาย นักพัฒนา เริ่มดำเนินการ', '2026-07-14 10:00:00'),
(2, 5, 'created', 'เปิด Ticket', '2026-07-15 10:00:00'),
(3, 4, 'created', 'เปิด Ticket', '2026-07-13 09:00:00'),
(3, 1, 'accepted', 'ผู้ดูแลระบบ รับเรื่องและเป็นผู้รับผิดชอบหลัก', '2026-07-13 09:10:00'),
(3, 1, 'started', 'ผู้ดูแลระบบ เริ่มดำเนินการ', '2026-07-13 09:15:00'),
(3, 1, 'completed', 'ผู้ดูแลระบบ เสร็จสิ้นและปิด Ticket', '2026-07-13 10:05:00'),
(4, 5, 'created', 'เปิด Ticket', '2026-07-16 08:30:00'),
(4, 2, 'accepted', 'สมชาย นักพัฒนา รับเรื่องและเป็นผู้รับผิดชอบหลัก', '2026-07-16 08:45:00'),
(5, 4, 'created', 'เปิด Ticket', '2026-07-16 14:00:00'),
(5, 3, 'accepted', 'สุดา ทดสอบระบบ รับเรื่องและเป็นผู้รับผิดชอบหลัก', '2026-07-16 14:20:00');

-- Tasks
INSERT INTO tasks (id, project_id, issue_id, title, description, status, priority, assignee_id, start_date, due_date, position) VALUES
(1, 1, 1, 'ตรวจสอบ useEffect หน้า Projects', 'แก้ปัญหา Promise ที่ถูก return จาก useEffect', 'doing', 'high', 2, '2026-07-10', '2026-07-18', 1),
(2, 1, 1, 'ทดสอบ Login หลาย Role', 'ทดสอบ admin / member / requester', 'todo', 'medium', 3, '2026-07-12', '2026-07-20', 1),
(3, 1, 2, 'ออกแบบ UI แนบไฟล์', 'Wireframe สำหรับ upload รูปและ drag-drop', 'review', 'medium', 2, '2026-07-08', '2026-07-17', 1),
(4, 1, NULL, 'เตรียม SQL Mock Data', 'สร้างข้อมูลตัวอย่างสำหรับทดสอบระบบ', 'done', 'low', 1, '2026-07-05', '2026-07-12', 1),
(5, 2, 4, 'ปรับ Layout Sidebar + Header', 'ซ่อน hamburger บน desktop และจัด spacing ใหม่', 'doing', 'urgent', 2, '2026-07-14', '2026-07-19', 1),
(6, 2, 5, 'ออกแบบการ์ดสถิติ Dashboard', 'ใช้ Ant Design Statistic + Tailwind', 'todo', 'medium', 3, '2026-07-15', '2026-07-22', 1),
(7, 2, NULL, 'ตั้งค่า Vite Proxy API', 'proxy /api และ /socket.io ไปยังพอร์ต 4000', 'done', 'high', 2, '2026-07-01', '2026-07-05', 1),
(8, 3, NULL, 'เก็บ Requirement ห้องประชุม', 'สัมภาษณ์ผู้ใช้งานและสรุป PRD', 'todo', 'medium', 2, '2026-07-16', '2026-07-25', 1),
(9, 1, NULL, 'ทดสอบการใช้งานกับพนักงาน', 'ทดลอง workflow แจ้งปัญหาและรวบรวม feedback', 'todo', 'low', 4, '2026-07-21', '2026-07-25', 2),
(10, 2, NULL, 'ตรวจสอบเนื้อหาฝ่ายขาย', 'ตรวจข้อความและข้อมูลผลิตภัณฑ์ก่อนเผยแพร่', 'review', 'medium', 5, '2026-07-18', '2026-07-23', 2);

-- Comments
INSERT INTO comments (issue_id, user_id, body) VALUES
(1, 2, 'รับเรื่องแล้ว กำลังไล่เช็ค useEffect ในหน้า Projects และ Board'),
(1, 4, 'ขอบคุณครับ ตอนนี้ยังเจอบน Firefox'),
(2, 1, 'ฟีเจอร์นี้วางไว้ในเฟสถัดไป แต่รับไว้ใน backlog แล้ว'),
(4, 2, 'กำลังปรับ layout ให้ sidebar คงที่ และ hamburger โชว์เฉพาะมือถือ');

-- Notifications
INSERT INTO notifications (user_id, title, message, is_read) VALUES
(1, 'มี Issue ใหม่', 'ISS-10000004: เมนูมือถือซ้อนทับกัน', 0),
(1, 'มี Issue ใหม่', 'ISS-10000005: อยากได้รายงานสรุปรายสัปดาห์', 0),
(2, 'ได้รับมอบหมายงานใหม่', 'ปรับ Layout Sidebar + Header', 0),
(2, 'Issue มีการอัปเดต', 'ISS-10000001 ถูกอัปเดตแล้ว', 1),
(4, 'Issue มีการอัปเดต', 'ISS-10000001 ถูกอัปเดตแล้ว', 0);

SELECT 'Mock data imported successfully' AS result;
