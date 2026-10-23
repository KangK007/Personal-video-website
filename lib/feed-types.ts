export type Platform = "douyin" | "bilibili";

export type NameSource = "manual" | "fallback" | "platform";

export type Creator = {
  id: string;
  platform: Platform;
  profileUrl: string;
  name: string;
  nameSource?: NameSource;
  avatarUrl?: string;
  enabled: boolean;
  lastSyncAt?: string;
  syncError?: string;
  /** Consecutive empty-but-complete snapshots; the second one clears cached videos. */
  emptySnapshotCount?: number;
};

export type VideoSource = "public-metadata" | "manual" | "sample" | "feed-sync";

export type VideoItem = {
  id: string;
  platform: Platform;
  videoUrl: string;
  creatorId: string;
  title: string;
  coverUrl?: string;
  publishedAt?: string;
  duration?: string;
  source: VideoSource;
  createdAt: string;
};

export type FeedState = {
  version: 2;
  creators: Creator[];
  videos: VideoItem[];
};
