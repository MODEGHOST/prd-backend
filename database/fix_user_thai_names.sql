USE lfbsmart_project;

UPDATE users SET name = 'ผู้ดูแลระบบ', first_name = 'ผู้ดูแลระบบ', last_name = '' WHERE id = 1;
UPDATE users SET name = 'สมชาย นักพัฒนา', first_name = 'สมชาย', last_name = 'นักพัฒนา' WHERE id = 2;
UPDATE users SET name = 'สุดา ทดสอบระบบ', first_name = 'สุดา', last_name = 'ทดสอบระบบ' WHERE id = 3;
UPDATE users SET name = 'วิภา พนักงานทั่วไป', first_name = 'วิภา', last_name = 'พนักงานทั่วไป' WHERE id = 4;
UPDATE users SET name = 'นภา ฝ่ายขาย', first_name = 'นภา', last_name = 'ฝ่ายขาย' WHERE id = 5;

SELECT id, name, first_name, last_name, email, HEX(LEFT(name, 3)) AS name_prefix_hex
FROM users
ORDER BY id;
