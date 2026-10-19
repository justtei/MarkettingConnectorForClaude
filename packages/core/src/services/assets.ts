import { audited } from "../audit.js";
import type { CoreContext } from "../context.js";
import { UserInputError } from "../guards.js";

const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
const MAX_VIDEO_UPLOAD_BYTES = 100 * 1024 * 1024; // larger videos: give a public URL instead

export interface UploadImageInput {
  url?: string;
  base64?: string;
  name?: string;
}

/** Downloads an image URL or decodes base64/data-URL into raw bytes. */
async function loadImageBytes(input: UploadImageInput): Promise<{ bytes: Buffer; name: string }> {
  if (input.base64) {
    const m = /^data:([^;]+);base64,(.*)$/s.exec(input.base64);
    const b64 = m ? m[2]! : input.base64;
    if (m && !m[1]!.startsWith("image/")) throw new UserInputError(`Expected an image, got ${m[1]}.`);
    const bytes = Buffer.from(b64, "base64");
    if (bytes.length === 0) throw new UserInputError("The image data is empty.");
    if (bytes.length > MAX_IMAGE_BYTES) throw new UserInputError("Images must be under 30 MB.");
    return { bytes, name: input.name ?? `upload-${Date.now()}.jpg` };
  }
  if (!input.url) throw new UserInputError("Give an image url or base64 data.");
  const url = new URL(input.url);
  if (!/^https?:$/.test(url.protocol)) throw new UserInputError("Image URL must be http(s).");
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000), redirect: "follow" });
  if (!res.ok) throw new UserInputError(`Could not download the image (HTTP ${res.status}).`);
  const type = res.headers.get("content-type") ?? "";
  if (type && !type.startsWith("image/") && !type.startsWith("application/octet-stream")) {
    throw new UserInputError(`The URL is not an image (content-type ${type}).`);
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length === 0) throw new UserInputError("The downloaded image is empty.");
  if (bytes.length > MAX_IMAGE_BYTES) throw new UserInputError("Images must be under 30 MB.");
  const name = input.name ?? (decodeURIComponent(url.pathname.split("/").pop() || "") || `image-${Date.now()}.jpg`);
  return { bytes, name };
}

export async function uploadImage(ctx: CoreContext, input: UploadImageInput) {
  const { bytes, name } = await loadImageBytes(input);
  return audited(ctx, "upload_image", { request: { url: input.url, name, size: bytes.length } }, async () => {
    const res = await ctx.meta.post<{ images: Record<string, { hash: string; url?: string }> }>(
      `${ctx.config.META_AD_ACCOUNT_ID}/adimages`,
      { bytes: bytes.toString("base64"), name },
    );
    const img = Object.values(res.images ?? {})[0];
    if (!img?.hash) throw new Error("Meta did not return an image hash.");
    await ctx.db.asset.upsert({
      where: { metaRef: img.hash },
      create: { type: "image", metaRef: img.hash, name, sourceUrl: input.url ?? null, previewUrl: img.url ?? null },
      update: { name, previewUrl: img.url ?? undefined, archived: false },
    });
    return { image_hash: img.hash, url: img.url ?? null, name };
  }, (r) => r.image_hash);
}

export interface UploadVideoInput {
  url?: string;
  base64?: string;
  name?: string;
  wait_until_ready?: boolean;
}

export async function uploadVideo(ctx: CoreContext, input: UploadVideoInput) {
  const fromUrl = input.url ? decodeURIComponent(new URL(input.url).pathname.split("/").pop() || "") : "";
  const title = input.name || fromUrl || `video-${Date.now()}`;
  return audited(ctx, "upload_video", { request: { url: input.url, name: title } }, async () => {
    let res: { id: string };
    if (input.url) {
      if (!/^https?:\/\//.test(input.url)) throw new UserInputError("Video URL must be http(s).");
      res = await ctx.meta.post(`${ctx.config.META_AD_ACCOUNT_ID}/advideos`, { file_url: input.url, name: title });
    } else if (input.base64) {
      const m = /^data:([^;]+);base64,(.*)$/s.exec(input.base64);
      const bytes = Buffer.from(m ? m[2]! : input.base64, "base64");
      if (bytes.length === 0) throw new UserInputError("The video data is empty.");
      if (bytes.length > MAX_VIDEO_UPLOAD_BYTES) {
        throw new UserInputError("Videos over 100 MB must be uploaded by public URL.");
      }
      const blob = new Blob([bytes], { type: m?.[1] ?? "video/mp4" });
      res = await ctx.meta.postMultipart(`${ctx.config.META_AD_ACCOUNT_ID}/advideos`, {
        source: new File([blob], title, { type: blob.type }),
        name: title,
      });
    } else {
      throw new UserInputError("Give a public video URL or base64 data.");
    }
    if (!res?.id) throw new Error("Meta did not return a video ID.");
    await ctx.db.asset.upsert({
      where: { metaRef: res.id },
      create: { type: "video", metaRef: res.id, name: title, sourceUrl: input.url ?? null },
      update: { name: title, archived: false },
    });
    let status: string | null = null;
    if (input.wait_until_ready) status = await waitForVideoReady(ctx, res.id);
    return { video_id: res.id, name: title, status: status ?? "processing" };
  }, (r) => r.video_id);
}

/** Polls until Meta has processed the video. Returns the final status. */
export async function waitForVideoReady(ctx: CoreContext, videoId: string, timeoutMs = ctx.config.META_VIDEO_READY_TIMEOUT_MS): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let delay = 2000;
  for (;;) {
    const v = await ctx.meta.get<{ status?: { video_status?: string; processing_progress?: number } }>(videoId, {
      fields: "status",
    });
    const s = v.status?.video_status ?? "unknown";
    if (s === "ready") return s;
    if (s === "error") throw new UserInputError(`Meta could not process video ${videoId}. Upload it again or use another file.`);
    if (Date.now() + delay > deadline) {
      throw new UserInputError(
        `Video ${videoId} is still processing (${v.status?.processing_progress ?? 0}%). Try again in a minute.`,
      );
    }
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 1.5, 10_000);
  }
}

/** Preferred thumbnail URL for a video (used when no thumbnail was supplied). */
export async function getVideoThumbnail(ctx: CoreContext, videoId: string): Promise<string | null> {
  try {
    const res = await ctx.meta.get<{ data: { uri: string; is_preferred?: boolean }[] }>(`${videoId}/thumbnails`);
    const list = res.data ?? [];
    return (list.find((t) => t.is_preferred) ?? list[0])?.uri ?? null;
  } catch (err) {
    ctx.log.warn({ err: String(err), videoId }, "Could not read video thumbnails");
    const v = await ctx.meta.get<{ picture?: string }>(videoId, { fields: "picture" }).catch(() => ({ picture: undefined }));
    return v.picture ?? null;
  }
}

export async function listAssets(ctx: CoreContext, type: "image" | "video" | "all" = "all", includeArchived = false) {
  const archived = new Set(
    (await ctx.db.asset.findMany({ where: { archived: true }, select: { metaRef: true } })).map((a) => a.metaRef),
  );
  const out: { images?: any[]; videos?: any[] } = {};
  if (type === "image" || type === "all") {
    const images = await ctx.meta.getAll<any>(`${ctx.config.META_AD_ACCOUNT_ID}/adimages`, {
      fields: "hash,name,url,permalink_url,width,height,created_time,status",
    }, 200);
    out.images = images
      .map((i) => ({
        image_hash: i.hash,
        name: i.name ?? null,
        url: i.url ?? i.permalink_url ?? null,
        width: i.width ?? null,
        height: i.height ?? null,
        created_time: i.created_time ?? null,
        archived: archived.has(i.hash),
      }))
      .filter((i) => includeArchived || !i.archived);
  }
  if (type === "video" || type === "all") {
    const videos = await ctx.meta.getAll<any>(`${ctx.config.META_AD_ACCOUNT_ID}/advideos`, {
      fields: "id,title,picture,length,created_time,status",
    }, 200);
    out.videos = videos
      .map((v) => ({
        video_id: v.id,
        title: v.title ?? null,
        picture: v.picture ?? null,
        length_seconds: v.length ?? null,
        status: v.status?.video_status ?? null,
        created_time: v.created_time ?? null,
        archived: archived.has(v.id),
      }))
      .filter((v) => includeArchived || !v.archived);
  }
  return out;
}

/** Archive hides a media file in the dashboard (Meta keeps it; there is no delete). */
export async function setAssetArchived(ctx: CoreContext, metaRef: string, archivedFlag: boolean) {
  return audited(ctx, archivedFlag ? "archive_asset" : "unarchive_asset", { objectId: metaRef, request: { metaRef } }, async () => {
    const isVideo = /^\d+$/.test(metaRef);
    const row = await ctx.db.asset.upsert({
      where: { metaRef },
      create: { metaRef, type: isVideo ? "video" : "image", archived: archivedFlag },
      update: { archived: archivedFlag },
    });
    return { metaRef: row.metaRef, archived: row.archived };
  });
}
