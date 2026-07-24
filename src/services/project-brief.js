const DESCRIPTION_SECTIONS = [
  { key: "objective", label: "วัตถุประสงค์" },
  { key: "problem", label: "ปัญหาเดิม" },
  { key: "expectedOutcome", label: "ผลลัพธ์ที่คาดหวัง" },
  { key: "extraDetails", label: "รายละเอียดเพิ่มเติม" },
];

const PRD_SECTIONS = [
  { key: "mainRequirements", label: "ฟีเจอร์/ความต้องการหลัก" },
  { key: "businessRules", label: "เงื่อนไข/กฎทางธุรกิจ" },
];

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function emptyToNull(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function composeSections(sections, values = {}) {
  return sections
    .map(({ key, label }) => {
      const text = String(values[key] || "").trim();
      if (!text) return null;
      return `${label}:\n${text}`;
    })
    .filter(Boolean)
    .join("\n\n") || null;
}

function parseSections(sections, text, fallbackKey) {
  const result = Object.fromEntries(sections.map((section) => [section.key, ""]));
  const raw = String(text || "").trim();
  if (!raw) return result;

  const labelToKey = Object.fromEntries(sections.map((section) => [section.label, section.key]));
  const labelPattern = sections.map((section) => escapeRegex(section.label)).join("|");
  const splitter = new RegExp(`(?:^|\\n)(${labelPattern}):\\s*`, "g");
  const matches = [...raw.matchAll(splitter)];

  if (!matches.length) {
    const key = fallbackKey || sections.at(-1)?.key;
    if (key) result[key] = raw;
    return result;
  }

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const key = labelToKey[match[1]];
    if (!key) continue;
    const contentStart = match.index + match[0].length;
    const contentEnd = index + 1 < matches.length ? matches[index + 1].index : raw.length;
    result[key] = raw.slice(contentStart, contentEnd).trim();
  }

  return result;
}

export function composeDescription(values) {
  return composeSections(DESCRIPTION_SECTIONS, values);
}

export function composePrd(values) {
  return composeSections(PRD_SECTIONS, values);
}

export function parseDescription(text) {
  return parseSections(DESCRIPTION_SECTIONS, text, "extraDetails");
}

export function parsePrd(text) {
  return parseSections(PRD_SECTIONS, text, "mainRequirements");
}

export function readProjectBrief(body = {}) {
  const hasStructured =
    body.objective !== undefined
    || body.problem !== undefined
    || body.expectedOutcome !== undefined
    || body.extraDetails !== undefined
    || body.mainRequirements !== undefined
    || body.businessRules !== undefined;

  if (hasStructured) {
    return {
      objective: emptyToNull(body.objective),
      problem: emptyToNull(body.problem),
      expectedOutcome: emptyToNull(body.expectedOutcome),
      extraDetails: emptyToNull(body.extraDetails),
      mainRequirements: emptyToNull(body.mainRequirements),
      businessRules: emptyToNull(body.businessRules),
    };
  }

  const descriptionParts = parseDescription(body.description);
  const prdParts = parsePrd(body.prd);
  return {
    objective: emptyToNull(descriptionParts.objective),
    problem: emptyToNull(descriptionParts.problem),
    expectedOutcome: emptyToNull(descriptionParts.expectedOutcome),
    extraDetails: emptyToNull(descriptionParts.extraDetails),
    mainRequirements: emptyToNull(prdParts.mainRequirements),
    businessRules: emptyToNull(prdParts.businessRules),
  };
}

export function validateProjectBrief(brief, { required = true } = {}) {
  if (!required) return null;
  if (!brief.objective) return "กรุณากรอกวัตถุประสงค์";
  if (!brief.problem) return "กรุณากรอกปัญหาเดิม";
  if (!brief.expectedOutcome) return "กรุณากรอกผลลัพธ์ที่คาดหวัง";
  if (!brief.mainRequirements) return "กรุณากรอกฟีเจอร์/ความต้องการหลัก";
  return null;
}

export function briefToDbColumns(brief) {
  return {
    objective: brief.objective,
    problem: brief.problem,
    expected_outcome: brief.expectedOutcome,
    extra_details: brief.extraDetails,
    main_requirements: brief.mainRequirements,
    business_rules: brief.businessRules,
    description: composeDescription(brief),
    prd: composePrd(brief),
  };
}

export function hydrateProjectBrief(project) {
  if (!project) return project;

  const hasStructured = Boolean(
    project.objective
    || project.problem
    || project.expected_outcome
    || project.extra_details
    || project.main_requirements
    || project.business_rules,
  );

  if (!hasStructured) {
    const descriptionParts = parseDescription(project.description);
    const prdParts = parsePrd(project.prd);
    return {
      ...project,
      objective: emptyToNull(descriptionParts.objective),
      problem: emptyToNull(descriptionParts.problem),
      expected_outcome: emptyToNull(descriptionParts.expectedOutcome),
      extra_details: emptyToNull(descriptionParts.extraDetails),
      main_requirements: emptyToNull(prdParts.mainRequirements),
      business_rules: emptyToNull(prdParts.businessRules),
    };
  }

  return {
    ...project,
    objective: emptyToNull(project.objective),
    problem: emptyToNull(project.problem),
    expected_outcome: emptyToNull(project.expected_outcome),
    extra_details: emptyToNull(project.extra_details),
    main_requirements: emptyToNull(project.main_requirements),
    business_rules: emptyToNull(project.business_rules),
  };
}
