import { z } from "zod";

export const schema = z.object({
  videoIds: z.array(z.string().min(1, "Video ID cannot be empty")).min(1, "At least one video ID is required").max(50, "Maximum 50 video IDs per batch request")
});

export type InputType = z.infer<typeof schema>;

export type OutputType = {
  videos: Array<{
    videoId: string;
    title: string;
    channelTitle: string;
    description: string;
    duration: string;
    thumbnails: {
      default: { url: string };
      medium: { url: string };
      high: { url: string };
      maxres?: { url: string };
    };
    publishedAt: string;
    viewCount: string;
    likeCount?: string;
    tags?: string[];
    cachedAt: string;
    source: string;
  }>;
  metadata: {
    totalRequested: number;
    totalReturned: number;
    cacheHits: number;
    apiCalls: number;
    fallbackUsed: string | null;
    quotaStatus: {
      used: number;
      limit: number;
      percentage: number;
      warningLevel: string;
    };
    timestamp: string;
  };
};

export const postYoutubeBatch = async (body: z.infer<typeof schema>, init?: RequestInit): Promise<OutputType> => {
  const validatedInput = schema.parse(body);
  const result = await fetch(`/_api/youtube/batch`, {
    method: "POST",
    body: JSON.stringify(validatedInput),
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  
  if (!result.ok) {
    const errorData = await result.json();
    throw new Error(errorData.message || `HTTP ${result.status}`);
  }
  
  return result.json();
};