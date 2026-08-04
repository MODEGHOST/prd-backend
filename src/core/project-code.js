/**
 * Project codes: PRJ-DDMMYYSSS
 * - DDMM = day/month in Asia/Bangkok
 * - YY = Buddhist Era year (AD + 543), last 2 digits
 * - SSS = daily sequence per company (001–999)
 * Example: PRJ-040869001 = 4 Aug 2569, first project that day
 */

function bangkokDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Bangkok",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).formatToParts(date);
  const read = (type) => parts.find((part) => part.type === type)?.value || "00";
  const day = read("day");
  const month = read("month");
  const adYear = Number(read("year"));
  const beYY = String(adYear + 543).slice(-2);
  return { day, month, beYY };
}

export function projectCodeDatePrefix(date = new Date()) {
  const { day, month, beYY } = bangkokDateParts(date);
  return `PRJ-${day}${month}${beYY}`;
}

export function formatProjectCode(prefix, sequence) {
  const seq = Number(sequence);
  if (!Number.isInteger(seq) || seq < 1 || seq > 999) {
    throw Object.assign(new Error("project sequence out of range"), {
      code: "PROJECT_CODE_SEQUENCE",
    });
  }
  return `${prefix}${String(seq).padStart(3, "0")}`;
}

const CODE_TAIL = /^PRJ-\d{6}(\d{3})$/;

/** Allocate next PRJ-DDMMYYSSS for the company. */
export async function allocateProjectCode(db, companyId, date = new Date()) {
  const prefix = projectCodeDatePrefix(date);
  // SQL LIKE: underscore matches exactly one character → 3-digit sequence.
  const [[row]] = await db.execute(
    `SELECT code
     FROM projects
     WHERE company_id = ? AND code LIKE ?
     ORDER BY code DESC
     LIMIT 1`,
    [companyId, `${prefix}___`],
  );

  let nextSeq = 1;
  const match = row?.code ? String(row.code).toUpperCase().match(CODE_TAIL) : null;
  if (match && String(row.code).toUpperCase().startsWith(prefix)) {
    nextSeq = Number(match[1]) + 1;
  }
  return formatProjectCode(prefix, nextSeq);
}
