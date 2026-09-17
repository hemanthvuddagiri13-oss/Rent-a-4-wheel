import { randomUUID } from "crypto";
import { mkdir, readFile, writeFile, unlink } from "fs/promises";
import path from "path";
import { v2 as cloudinary } from "cloudinary";

const LOCAL_STORAGE_ROOT = path.join(process.cwd(), "private-storage", "documents");

export async function deletePrivateDocument(storageKey: string) {
  if (storageKey.startsWith("cloudinary:")) {
    const result = await cloudinary.uploader.destroy(storageKey.slice(11), { resource_type: "image", type: "authenticated", invalidate: true });
    if (!["ok", "not found"].includes(result.result)) throw new Error("PRIVATE_DELETE_NOT_ACCEPTED");
    return;
  }
  if (!storageKey.startsWith("local:")) throw new Error("INVALID_PRIVATE_STORAGE_KEY");
  const filename = storageKey.slice(6);
  if (path.basename(filename) !== filename || !/^[a-zA-Z0-9-]+\.[a-zA-Z0-9]+$/.test(filename)) throw new Error("INVALID_PRIVATE_STORAGE_KEY");
  const target = path.resolve(LOCAL_STORAGE_ROOT, filename);
  if (path.dirname(target) !== path.resolve(LOCAL_STORAGE_ROOT)) throw new Error("INVALID_PRIVATE_STORAGE_KEY");
  await unlink(target).catch(error => { if (error.code !== "ENOENT") throw error; });
}

const cloudinaryConfigured = Boolean(
  process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET
);

if (cloudinaryConfigured) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true,
  });
}

export interface StoredDocument {
  storageKey: string;
}

/**
 * Stores a private document (driver's license, ownership/lease docs, etc).
 *
 * When Cloudinary credentials are configured, files upload to a private,
 * `authenticated`-delivery-type Cloudinary folder (never publicly
 * browsable — retrieval requires a signed URL generated server-side).
 *
 * Without credentials (local development), files are written to
 * `private-storage/` on disk, which is git-ignored and only ever read by
 * the authenticated `/api/documents/[id]` route — never served from
 * `/public`.
 */
export function planPrivateDocument(mimeType: string, stableId: string): StoredDocument {
  if (!/^[a-zA-Z0-9-]+$/.test(stableId)) throw new Error("INVALID_PRIVATE_STORAGE_ID");
  return { storageKey: cloudinaryConfigured ? `cloudinary:rent-a-4wheel/documents/${stableId}` : `local:${stableId}.${mimeType.split("/")[1] || "bin"}` };
}

export async function storePrivateDocument(buffer: Buffer, mimeType: string, stableId?: string): Promise<StoredDocument> {
  if (stableId) planPrivateDocument(mimeType, stableId);
  if (cloudinaryConfigured) {
    const upload = await new Promise<{ public_id: string }>((resolve, reject) => {
      cloudinary.uploader
        .upload_stream({ resource_type: "auto", type: "authenticated", folder: "rent-a-4wheel/documents", ...(stableId ? { public_id: stableId, overwrite: false } : {}) }, (err, result) => {
          if (err || !result) return reject(err);
          resolve(result);
        })
        .end(buffer);
    });
    return { storageKey: `cloudinary:${upload.public_id}` };
  }

  await mkdir(LOCAL_STORAGE_ROOT, { recursive: true });
  const ext = mimeType.split("/")[1] || "bin";
  const filename = `${stableId ?? randomUUID()}.${ext}`;
  await writeFile(path.join(LOCAL_STORAGE_ROOT, filename), buffer);
  return { storageKey: `local:${filename}` };
}

export async function readPrivateDocument(storageKey: string): Promise<{ buffer: Buffer; url?: string }> {
  if (storageKey.startsWith("cloudinary:")) {
    const publicId = storageKey.replace("cloudinary:", "");
    const url = cloudinary.utils.private_download_url(publicId, "", {
      resource_type: "image",
      type: "authenticated",
      expires_at: Math.floor(Date.now() / 1000) + 300,
    });
    const res = await fetch(url);
    const arrayBuffer = await res.arrayBuffer();
    return { buffer: Buffer.from(arrayBuffer), url };
  }

  const filename = storageKey.replace("local:", "");
  const buffer = await readFile(path.join(LOCAL_STORAGE_ROOT, filename));
  return { buffer };
}
