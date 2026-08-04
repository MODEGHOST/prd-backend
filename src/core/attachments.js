import path from "node:path";
import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, mkdir, open, rename, unlink, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import multer from "multer";

export const INLINE_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

const ATTACHMENT_TYPES = new Map([
  ["image/jpeg", [".jpg", ".jpeg"]],
  ["image/png", [".png"]],
  ["image/gif", [".gif"]],
  ["image/webp", [".webp"]],
  ["application/pdf", [".pdf"]],
  ["text/plain", [".txt"]],
]);

export function safeDisplayName(value) {
  return path.basename(String(value || "attachment"))
    .replace(/[\u0000-\u001f\u007f"\\/:*?<>|]/g, "_")
    .slice(0, 255) || "attachment";
}

/** Detect MIME from file content signatures (magic bytes). */
export function sniffMimeType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    buffer[0] === 0x89
    && buffer[1] === 0x50
    && buffer[2] === 0x4e
    && buffer[3] === 0x47
  ) {
    return "image/png";
  }
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
    return "image/gif";
  }
  if (
    buffer.length >= 12
    && buffer[0] === 0x52
    && buffer[1] === 0x49
    && buffer[2] === 0x46
    && buffer[3] === 0x46
    && buffer[8] === 0x57
    && buffer[9] === 0x45
    && buffer[10] === 0x42
    && buffer[11] === 0x50
  ) {
    return "image/webp";
  }
  if (
    buffer[0] === 0x25
    && buffer[1] === 0x50
    && buffer[2] === 0x44
    && buffer[3] === 0x46
  ) {
    return "application/pdf";
  }
  const sample = buffer.subarray(0, Math.min(buffer.length, 512));
  if (sample.includes(0)) return null;
  let printable = 0;
  for (const byte of sample) {
    if (
      byte === 0x09
      || byte === 0x0a
      || byte === 0x0d
      || (byte >= 0x20 && byte <= 0x7e)
      || byte >= 0x80
    ) {
      printable += 1;
    }
  }
  if (printable / sample.length >= 0.95) return "text/plain";
  return null;
}

async function readFileHead(filePath, maxBytes = 512) {
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** Sync check for in-memory uploads (tests / legacy). Prefer validUploadedFile. */
export function validAttachment(file) {
  const sniffed = file.buffer ? sniffMimeType(file.buffer) : null;
  if (file.buffer && !sniffed) return false;
  if (sniffed && sniffed !== file.mimetype) return false;
  const mime = sniffed || file.mimetype;
  const extensions = ATTACHMENT_TYPES.get(mime);
  return Boolean(extensions?.includes(path.extname(file.originalname).toLowerCase()));
}

/** Validate multer file from diskStorage or memoryStorage. */
export async function validUploadedFile(file) {
  if (!file) return false;
  let sniffed = null;
  if (file.buffer) {
    sniffed = sniffMimeType(file.buffer);
  } else if (file.path) {
    try {
      sniffed = sniffMimeType(await readFileHead(file.path));
    } catch {
      return false;
    }
  } else {
    return false;
  }
  if (!sniffed) return false;
  if (sniffed !== file.mimetype) return false;
  const extensions = ATTACHMENT_TYPES.get(sniffed);
  return Boolean(extensions?.includes(path.extname(file.originalname).toLowerCase()));
}

export async function areUploadedFilesValid(files = []) {
  for (const file of files) {
    if (!(await validUploadedFile(file))) return false;
  }
  return true;
}

export function storagePath(root, storageName) {
  if (!/^[a-f0-9]{48}$/.test(String(storageName))) {
    throw Object.assign(new Error("invalid attachment storage identifier"), {
      code: "INVALID_ATTACHMENT_PATH",
    });
  }
  return path.join(root, storageName);
}

export function attachmentTempRoot(config) {
  return path.join(path.resolve(config.attachments.directory), ".tmp");
}

export function createAttachmentUpload(config) {
  const tempRoot = attachmentTempRoot(config);
  return multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => {
        mkdir(tempRoot, { recursive: true })
          .then(() => cb(null, tempRoot))
          .catch((error) => cb(error));
      },
      filename: (_req, _file, cb) => {
        cb(null, `${Date.now()}-${randomBytes(16).toString("hex")}`);
      },
    }),
    limits: {
      files: config.attachments.maxFiles,
      fileSize: config.attachments.maxBytes,
    },
  });
}

/** Move uploaded temp/memory file into the final attachment path. */
export async function commitUploadedFile(file, targetPath) {
  if (file?.buffer) {
    await writeFile(targetPath, file.buffer, { flag: "wx", mode: 0o600 });
    return;
  }
  if (!file?.path) {
    throw Object.assign(new Error("missing upload payload"), { code: "MISSING_UPLOAD" });
  }
  try {
    await rename(file.path, targetPath);
  } catch (error) {
    if (error.code !== "EXDEV") throw error;
    try {
      await copyFile(file.path, targetPath);
    } catch (copyError) {
      // Prefer exclusive create when available.
      if (copyError.code === "EEXIST") throw copyError;
      await new Promise((resolve, reject) => {
        const input = createReadStream(file.path);
        const output = createWriteStream(targetPath, { flags: "wx", mode: 0o600 });
        input.on("error", reject);
        output.on("error", reject);
        output.on("finish", resolve);
        input.pipe(output);
      });
    }
    await unlink(file.path).catch(() => {});
  }
  file.path = null;
}

export async function discardUploadedFiles(files = []) {
  await Promise.all(
    (files || []).map((file) => (
      file?.path ? unlink(file.path).catch(() => {}) : Promise.resolve()
    )),
  );
}

export function attachmentRoot(config, scope = "") {
  const root = path.resolve(config.attachments.directory);
  return scope ? path.join(root, scope) : root;
}
