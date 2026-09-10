// Works out what a pasted link actually is, so a YouTube clip plays in place, a
// picture is shown as a picture, and everything else gets a tidy link card.
//
// Embed addresses are always rebuilt from the id we extracted, never from the
// address that was pasted: that way nothing a visitor types can end up inside
// an iframe src as-is.

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const IMAGE_EXT = /\.(jpe?g|png|gif|webp|avif|bmp|svg)$/i;
const VIDEO_EXT = /\.(mp4|webm|ogv|ogg|mov|m4v)$/i;

const stripWww = (host) => host.replace(/^www\./, "");

// "1m30s", "90s" and "90" all mean the same thing to YouTube; seconds is what
// the embed player wants.
function youtubeStart(params) {
  const raw = params.get("t") || params.get("start");
  if (!raw) return 0;
  if (/^\d+$/.test(raw)) return Number(raw);
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(raw.trim());
  if (!match || !match.slice(1).some(Boolean)) return 0;
  const [, h, m, s] = match;
  return Number(h || 0) * 3600 + Number(m || 0) * 60 + Number(s || 0);
}

export function parseUrl(raw) {
  const trimmed = (raw || "").trim();
  if (!trimmed) return null;

  let url;
  try {
    // A pasted address often arrives without a scheme.
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!url.hostname.includes(".")) return null;

  const host = stripWww(url.hostname.toLowerCase());
  const parts = url.pathname.split("/").filter(Boolean);
  const base = { url: url.href, host, kind: "link", provider: "link" };

  // --- YouTube -------------------------------------------------------------
  if (host === "youtu.be" || /(^|\.)youtube(-nocookie)?\.com$/.test(host)) {
    let id = null;
    if (host === "youtu.be") id = parts[0];
    else if (url.searchParams.get("v")) id = url.searchParams.get("v");
    else if (["shorts", "embed", "live", "v"].includes(parts[0])) id = parts[1];

    if (id && YOUTUBE_ID.test(id)) {
      const start = youtubeStart(url.searchParams);
      return {
        ...base,
        kind: "video",
        provider: "youtube",
        // nocookie keeps YouTube from setting tracking cookies on visitors who
        // never press play.
        embedUrl:
          `https://www.youtube-nocookie.com/embed/${id}` +
          (start ? `?start=${start}` : ""),
        thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
        ratio: "16 / 9",
      };
    }
  }

  // --- Vimeo ---------------------------------------------------------------
  if (/(^|\.)vimeo\.com$/.test(host)) {
    const id = parts.find((part) => /^\d{6,}$/.test(part));
    if (id) {
      return {
        ...base,
        kind: "video",
        provider: "vimeo",
        embedUrl: `https://player.vimeo.com/video/${id}`,
        ratio: "16 / 9",
      };
    }
  }

  // --- TikTok --------------------------------------------------------------
  if (/(^|\.)tiktok\.com$/.test(host)) {
    const index = parts.indexOf("video");
    const id = index >= 0 ? parts[index + 1] : null;
    if (id && /^\d{6,}$/.test(id)) {
      return {
        ...base,
        kind: "video",
        provider: "tiktok",
        embedUrl: `https://www.tiktok.com/embed/v2/${id}`,
        ratio: "9 / 16",
      };
    }
  }

  // --- Instagram -----------------------------------------------------------
  if (/(^|\.)instagram\.com$/.test(host)) {
    const type = ["p", "reel", "reels", "tv"].includes(parts[0]) ? parts[0] : null;
    const code = type ? parts[1] : null;
    if (code && /^[A-Za-z0-9_-]{5,20}$/.test(code)) {
      const path = type === "reels" ? "reel" : type;
      return {
        ...base,
        kind: "video",
        provider: "instagram",
        embedUrl: `https://www.instagram.com/${path}/${code}/embed`,
        ratio: "4 / 5",
      };
    }
  }

  // --- Streamable ----------------------------------------------------------
  if (/(^|\.)streamable\.com$/.test(host)) {
    const id = parts[0] === "e" ? parts[1] : parts[0];
    if (id && /^[A-Za-z0-9]{3,12}$/.test(id)) {
      return {
        ...base,
        kind: "video",
        provider: "streamable",
        embedUrl: `https://streamable.com/e/${id}`,
        ratio: "16 / 9",
      };
    }
  }

  // --- Imgur albums and galleries ------------------------------------------
  if (/(^|\.)imgur\.com$/.test(host) && !IMAGE_EXT.test(url.pathname)) {
    const id = ["a", "gallery", "t"].includes(parts[0])
      ? parts[parts.length - 1]
      : null;
    if (id && /^[A-Za-z0-9]{5,12}$/.test(id)) {
      return {
        ...base,
        kind: "video",
        provider: "imgur",
        embedUrl: `https://imgur.com/a/${id}/embed?pub=true`,
        ratio: "4 / 3",
      };
    }
  }

  // --- A file that is itself the funny thing --------------------------------
  if (IMAGE_EXT.test(url.pathname)) {
    return { ...base, kind: "image", provider: "image", src: url.href };
  }
  if (VIDEO_EXT.test(url.pathname)) {
    return { ...base, kind: "video", provider: "file", src: url.href };
  }

  // --- Anything else ---------------------------------------------------------
  // X and Reddit among them: their embeds need a script from their own domain,
  // which a link card avoids without losing anything but the preview.
  if (/(^|\.)(twitter\.com|x\.com)$/.test(host)) {
    return { ...base, provider: "x" };
  }
  return base;
}

// What the post is filed as. A link that turned out to be a picture is a
// picture; a post without a link is a joke someone typed out.
export function kindOf(media) {
  if (!media) return "joke";
  if (media.kind === "image") return "image";
  if (media.kind === "video") return "clip";
  return "link";
}
