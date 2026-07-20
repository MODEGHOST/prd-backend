import path from "node:path";
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

export function validAttachment(file) {
  const sniffed = file.buffer ? sniffMimeType(file.buffer) : null;
  if (file.buffer && !sniffed) return false;
  if (sniffed && sniffed !== file.mimetype) return false;
  const mime = sniffed || file.mimetype;
  const extensions = ATTACHMENT_TYPES.get(mime);
  return Boolean(extensions?.includes(path.extname(file.originalname).toLowerCase()));
}

export function storagePath(root, storageName) {
  if (!/^[a-f0-9]{48}$/.test(String(storageName))) {
    throw Object.assign(new Error("invalid attachment storage identifier"), {
      code: "INVALID_ATTACHMENT_PATH",
    });
  }
  return path.join(root, storageName);
}

export function createAttachmentUpload(config) {
  return multer({
    storage: multer.memoryStorage(),
    limits: {
      files: config.attachments.maxFiles,
      fileSize: config.attachments.maxBytes,
    },
  });
}

export function attachmentRoot(config, scope = "") {
  const root = path.resolve(config.attachments.directory);
  return scope ? path.join(root, scope) : root;
}
