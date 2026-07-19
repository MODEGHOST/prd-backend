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

export function validAttachment(file) {
  const extensions = ATTACHMENT_TYPES.get(file.mimetype);
  return extensions?.includes(path.extname(file.originalname).toLowerCase());
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
