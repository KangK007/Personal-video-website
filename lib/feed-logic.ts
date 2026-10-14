import type { Creator, Platform, VideoItem } from "@/lib/feed-types";

export const VISIBLE_VIDEO_BATCH_SIZE = 48;
export const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export function parsePublishedAt(value?: string) {
  if (!value) return null;
  const dateOnly = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnly) {
    const [, year, month, day] = dateOnly;
    const localDate = new Date(Number(year), Number(month) - 1, Number(day));
    if (
      localDate.getFullYear() !== Number(year)
      || localDate.getMonth() !== Number(month) - 1
      || localDate.getDate() !== Number(day)
    ) return null;
    return localDate;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function isRecentVideo(video: VideoItem, now = Date.now()) {
  const published = parsePublishedAt(video.publishedAt)?.getTime();
  if (published === undefined || published === null) return false;
  return published <= now && published > now - RECENT_WINDOW_MS;
}

export function videoTimestamp(video: VideoItem) {
  return parsePublishedAt(video.publishedAt)?.getTime() ?? Number.NEGATIVE_INFINITY;
}

export function sortVideos(videos: VideoItem[]) {
  return videos
    .map((video, index) => ({
      video,
      index,
      publishedAt: videoTimestamp(video),
      createdAt: new Date(video.createdAt).getTime(),
    }))
    .sort((a, b) => {
      const publishedDiff = b.publishedAt - a.publishedAt;
      // Two unknown dates both yield -Infinity; -Infinity - -Infinity is NaN, which
      // would silently skip the createdAt tie-break.
      if (publishedDiff !== 0 && !Number.isNaN(publishedDiff)) return publishedDiff;
      const createdDiff = b.createdAt - a.createdAt;
      return createdDiff !== 0 ? createdDiff : a.index - b.index;
    })
    .map(({ video }) => video);
}

export function creatorVideos(creator: Creator, videos: VideoItem[]) {
  return sortVideos(videos.filter((video) => video.creatorId === creator.id));
}

export function creatorLatestTimestamp(creator: Creator, videos: VideoItem[]) {
  let latestValue: string | undefined;
  let latestTimestamp = Number.NEGATIVE_INFINITY;
  for (const video of videos) {
    if (video.creatorId !== creator.id) continue;
    const timestamp = videoTimestamp(video);
    if (timestamp > latestTimestamp) {
      latestTimestamp = timestamp;
      latestValue = video.publishedAt;
    }
  }
  return latestValue;
}

export function platformMatches(platform: "all" | Platform, value: Platform) {
  return platform === "all" || platform === value;
}
