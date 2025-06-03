import { z } from "zod";

export const schema = z.object({
  query: z.string().min(1, "Search query is required").max(100, "Query too long"),
  genre: z.string().optional(),
  maxResults: z.number().int().min(1).max(50).default(10)
});

export type InputType = z.infer<typeof schema>;

export type OutputType = {
  videos: Array<{
    videoId: string;
    title: string;
    channelTitle: string;
    description: string;
    thumbnails: {
      default: { url: string };
      medium: { url: string };
      high: { url: string };
    };
    publishedAt: string;
    source: string;
  }>;
  metadata: {
    query: string;
    genre: string | null;
    maxResults: number;
    actualResults: number;
    fallbackUsed: string | null;
    cacheHit: boolean;
    quotaStatus: {
      used: number;
      limit: number;
      percentage: number;
      warningLevel: string;
    } | null;
    timestamp: string;
  };
};

export const postYoutubeSearch = async (body: z.infer<typeof schema>, init?: RequestInit): Promise<OutputType> => {
  const validatedInput = schema.parse(body);
  const result = await fetch(`/_api/youtube/search`, {
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