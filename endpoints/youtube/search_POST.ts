import { schema } from "./search_POST.schema";
import { db } from "../../helpers/db";
import { getCachedSearchResults, setCachedSearchResults, updateSearchAnalytics } from "../../helpers/youTubeSearchCache";
import type { CachedVideoData } from "../../helpers/youTubeVideoCache";

interface YouTubeSearchResponse {
  items: Array<{
    id: {
      videoId: string;
    };
    snippet: {
      title: string;
      channelTitle: string;
      description: string;
      thumbnails: {
        default: { url: string };
        medium: { url: string };
        high: { url: string };
      };
      publishedAt: string;
    };
  }>;
}

interface QuotaUsage {
  used: number;
  limit: number;
  resetTime: number;
}

// Static fallback data for emergency situations
const EMERGENCY_TRACKS = [
  {
    videoId: "dQw4w9WgXcQ",
    title: "Rick Astley - Never Gonna Give You Up",
    channelTitle: "Rick Astley",
    description: "Classic pop hit from 1987",
    thumbnails: {
      default: { url: "https://i.ytimg.com/vi/dQw4w9WgXcQ/default.jpg" },
      medium: { url: "https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg" },
      high: { url: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg" }
    },
    publishedAt: "2009-10-25T06:57:33Z",
    source: "emergency"
  }
];

const CURATED_PLAYLISTS = {
  pop: [
    "dQw4w9WgXcQ", "9bZkp7q19f0", "fJ9rUzIMcZQ", "60ItHLz5WEA", "kJQP7kiw5Fk"
  ],
  rock: [
    "fJ9rUzIMcZQ", "9bZkp7q19f0", "dQw4w9WgXcQ", "60ItHLz5WEA", "kJQP7kiw5Fk"
  ],
  electronic: [
    "kJQP7kiw5Fk", "60ItHLz5WEA", "dQw4w9WgXcQ", "9bZkp7q19f0", "fJ9rUzIMcZQ"
  ],
  "hip-hop": [
    "60ItHLz5WEA", "kJQP7kiw5Fk", "fJ9rUzIMcZQ", "dQw4w9WgXcQ", "9bZkp7q19f0"
  ],
  jazz: [
    "9bZkp7q19f0", "fJ9rUzIMcZQ", "kJQP7kiw5Fk", "60ItHLz5WEA", "dQw4w9WgXcQ"
  ],
  classical: [
    "fJ9rUzIMcZQ", "kJQP7kiw5Fk", "9bZkp7q19f0", "dQw4w9WgXcQ", "60ItHLz5WEA"
  ]
};

const QUOTA_COST_PER_SEARCH = 100;
const QUOTA_WARNING_THRESHOLD = 0.8;
const QUOTA_CRITICAL_THRESHOLD = 0.95;

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getOrCreateTodaysQuota(): Promise<QuotaUsage> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  // Try to get today's quota record
  let quotaRecord = await db
    .selectFrom('youtube_quota_tracking')
    .selectAll()
    .where('date', '>=', today)
    .where('date', '<', new Date(today.getTime() + 24 * 60 * 60 * 1000))
    .executeTakeFirst();

  if (!quotaRecord) {
    // Create new record for today
    const resetTime = new Date();
    resetTime.setHours(24, 0, 0, 0); // Reset at midnight tomorrow
    
    quotaRecord = await db
      .insertInto('youtube_quota_tracking')
      .values({
        date: today,
        quota_used: 0,
        quota_limit: 10000,
        reset_time: resetTime,
        last_updated: new Date()
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  return {
    used: quotaRecord.quota_used,
    limit: quotaRecord.quota_limit,
    resetTime: quotaRecord.reset_time.getTime()
  };
}

async function updateQuotaUsage(newUsage: number): Promise<void> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  await db
    .updateTable('youtube_quota_tracking')
    .set({
      quota_used: newUsage,
      last_updated: new Date()
    })
    .where('date', '>=', today)
    .where('date', '<', new Date(today.getTime() + 24 * 60 * 60 * 1000))
    .execute();
}

async function logQuotaEvent(eventType: string, quotaUsed: number, quotaLimit: number, endpoint: string, message: string, fallbackType?: string): Promise<void> {
  await db
    .insertInto('youtube_quota_events')
    .values({
      timestamp: new Date(),
      event_type: eventType,
      quota_used: quotaUsed,
      quota_limit: quotaLimit,
      endpoint,
      fallback_type: fallbackType || null,
      message
    })
    .execute();
  
  console.log(`Quota event logged: ${eventType} - ${message}`);
}

async function searchYouTubeWithRetry(query: string, maxResults: number, retries = 3): Promise<YouTubeSearchResponse> {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    throw new Error("YOUTUBE_API_KEY environment variable is not set");
  }

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(`YouTube API search attempt ${attempt}/${retries} for query: "${query}"`);
      
      const url = new URL("https://www.googleapis.com/youtube/v3/search");
      url.searchParams.set("part", "snippet");
      url.searchParams.set("q", `${query} music`);
      url.searchParams.set("type", "video");
      url.searchParams.set("videoCategoryId", "10"); // Music category
      url.searchParams.set("maxResults", maxResults.toString());
      url.searchParams.set("order", "relevance");
      url.searchParams.set("key", apiKey);

      const response = await fetch(url.toString());
      
      if (!response.ok) {
        const errorText = await response.text();
        console.error(`YouTube API error (attempt ${attempt}): ${response.status} - ${errorText}`);
        
        if (response.status === 403) {
          throw new Error("YouTube API quota exceeded or invalid API key");
        }
        
        if (response.status === 429) {
          const waitTime = Math.pow(2, attempt) * 1000; // Exponential backoff
          console.log(`Rate limited, waiting ${waitTime}ms before retry`);
          await sleep(waitTime);
          continue;
        }
        
        throw new Error(`YouTube API error: ${response.status}`);
      }

      const data: YouTubeSearchResponse = await response.json();
      console.log(`YouTube API search successful, found ${data.items?.length || 0} results`);
      
      // Update quota usage in database
      const currentQuota = await getOrCreateTodaysQuota();
      const newUsage = currentQuota.used + QUOTA_COST_PER_SEARCH;
      await updateQuotaUsage(newUsage);
      
      // Log API call event
      await logQuotaEvent(
        'api_call',
        newUsage,
        currentQuota.limit,
        'youtube/search',
        `Search API call completed. Query: "${query}". Cost: ${QUOTA_COST_PER_SEARCH} units. New usage: ${newUsage}/${currentQuota.limit}`
      );
      
      console.log(`Quota usage: ${newUsage}/${currentQuota.limit} (${((newUsage / currentQuota.limit) * 100).toFixed(1)}%)`);
      
      return data;
    } catch (error) {
      console.error(`YouTube API attempt ${attempt} failed:`, error);
      
      if (attempt === retries) {
        throw error;
      }
      
      const waitTime = Math.pow(2, attempt) * 1000;
      console.log(`Waiting ${waitTime}ms before retry`);
      await sleep(waitTime);
    }
  }
  
  throw new Error("All YouTube API retry attempts failed");
}

async function checkQuotaStatus(): Promise<{ canUseAPI: boolean; warningLevel: string; quotaUsage: QuotaUsage }> {
  const quotaUsage = await getOrCreateTodaysQuota();
  const now = Date.now();
  
  // Check if quota needs to be reset
  if (now > quotaUsage.resetTime) {
    console.log("Resetting daily quota usage");
    const oldUsed = quotaUsage.used;
    
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const resetTime = new Date();
    resetTime.setHours(24, 0, 0, 0);
    
    await db
      .insertInto('youtube_quota_tracking')
      .values({
        date: today,
        quota_used: 0,
        quota_limit: quotaUsage.limit,
        reset_time: resetTime,
        last_updated: new Date()
      })
      .execute();
    
    await logQuotaEvent(
      'quota_reset',
      0,
      quotaUsage.limit,
      'system',
      `Daily quota reset. Previous usage: ${oldUsed}/${quotaUsage.limit}`
    );
    
    quotaUsage.used = 0;
    quotaUsage.resetTime = resetTime.getTime();
  }

  const usageRatio = quotaUsage.used / quotaUsage.limit;
  
  if (usageRatio >= QUOTA_CRITICAL_THRESHOLD) {
    return { canUseAPI: false, warningLevel: "critical", quotaUsage };
  } else if (usageRatio >= QUOTA_WARNING_THRESHOLD) {
    return { canUseAPI: true, warningLevel: "warning", quotaUsage };
  } else {
    return { canUseAPI: true, warningLevel: "normal", quotaUsage };
  }
}

async function getCuratedPlaylist(genre: string, maxResults: number, quotaUsage: QuotaUsage) {
  console.log(`Using curated playlist fallback for genre: ${genre}`);
  
  await logQuotaEvent(
    'fallback_triggered',
    quotaUsage.used,
    quotaUsage.limit,
    'youtube/search',
    `Curated playlist fallback used for genre: ${genre}`,
    'curated_playlists'
  );
  
  const playlistIds = CURATED_PLAYLISTS[genre.toLowerCase() as keyof typeof CURATED_PLAYLISTS] || CURATED_PLAYLISTS.pop;
  const selectedIds = playlistIds.slice(0, maxResults);
  
  return selectedIds.map(videoId => ({
    videoId,
    title: `Curated ${genre} Track`,
    channelTitle: "Crush Radio Curated",
    description: `A curated ${genre} music track from our collection`,
    thumbnails: {
      default: { url: `https://i.ytimg.com/vi/${videoId}/default.jpg` },
      medium: { url: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg` },
      high: { url: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` }
    },
    publishedAt: new Date().toISOString(),
    source: "curated"
  }));
}

async function getStaticMusicDatabase(query: string, genre: string, maxResults: number, quotaUsage: QuotaUsage) {
  console.log(`Using static music database fallback for query: "${query}", genre: ${genre}`);
  
  await logQuotaEvent(
    'fallback_triggered',
    quotaUsage.used,
    quotaUsage.limit,
    'youtube/search',
    `Static database fallback used for query: "${query}", genre: ${genre}`,
    'static_database'
  );
  
  const curatedTracks = await getCuratedPlaylist(genre, Math.floor(maxResults / 2), quotaUsage);
  const emergencyTracks = EMERGENCY_TRACKS.slice(0, maxResults - curatedTracks.length);
  
  return [...curatedTracks, ...emergencyTracks].map(track => ({
    ...track,
    source: "static_db"
  }));
}

export async function handle(request: Request) {
  try {
    console.log("YouTube search endpoint called");
    
    const json = await request.json();
    const { query, genre, maxResults } = schema.parse(json);
    
    console.log(`Search parameters - Query: "${query}", Genre: ${genre || 'none'}, MaxResults: ${maxResults}`);
    
    // Check for cached search results first
    const cachedResults = await getCachedSearchResults(query, genre || null, maxResults);
    if (cachedResults) {
      console.log(`Returning cached search results: ${cachedResults.length} videos`);
      
      const response = {
        videos: cachedResults.map(result => ({
          videoId: result.videoId,
          title: result.title,
          channelTitle: result.channelTitle,
          description: result.description,
          thumbnails: result.thumbnails as {
            default: { url: string };
            medium: { url: string };
            high: { url: string };
          },
          publishedAt: result.publishedAt.toISOString(),
          source: result.source
        })),
        metadata: {
          query,
          genre: genre || null,
          maxResults,
          actualResults: cachedResults.length,
          fallbackUsed: null,
          cacheHit: true,
          quotaStatus: null,
          timestamp: new Date().toISOString()
        }
      };
      
      return Response.json(response, { 
        status: 200,
        headers: {
          "Cache-Control": "public, max-age=300",
          "X-Cache": "HIT"
        }
      });
    }
    
    const quotaStatus = await checkQuotaStatus();
    console.log(`Quota status: ${quotaStatus.warningLevel}, Can use API: ${quotaStatus.canUseAPI}`);
    
    let results;
    let fallbackUsed = null;
    
    try {
      if (!quotaStatus.canUseAPI) {
        console.log("Quota critical - skipping YouTube API, using curated playlists");
        results = await getCuratedPlaylist(genre || "pop", maxResults, quotaStatus.quotaUsage);
        fallbackUsed = "curated_playlists";
      } else {
        // Try YouTube API first
        const searchQuery = genre ? `${query} ${genre}` : query;
        const youtubeResponse = await searchYouTubeWithRetry(searchQuery, maxResults);
        
        if (!youtubeResponse.items || youtubeResponse.items.length === 0) {
          console.log("No results from YouTube API, using curated playlists");
          results = await getCuratedPlaylist(genre || "pop", maxResults, quotaStatus.quotaUsage);
          fallbackUsed = "curated_playlists";
        } else {
          const apiResults = youtubeResponse.items.map(item => ({
            videoId: item.id.videoId,
            title: item.snippet.title,
            channelTitle: item.snippet.channelTitle,
            description: item.snippet.description,
            duration: 'PT0S', // Placeholder
            publishedAt: new Date(item.snippet.publishedAt),
            thumbnails: item.snippet.thumbnails,
            viewCount: null,
            likeCount: null,
            tags: null,
            source: "youtube_api"
          }));
          
          // Cache the successful API results
          await setCachedSearchResults(query, genre || null, apiResults);
          
          results = apiResults.map(result => ({
            videoId: result.videoId,
            title: result.title,
            channelTitle: result.channelTitle,
            description: result.description,
            thumbnails: result.thumbnails,
            publishedAt: result.publishedAt.toISOString(),
            source: result.source
          }));
        }
      }
    } catch (error) {
      console.error("YouTube API failed, trying curated playlists:", error);
      
      try {
        results = await getCuratedPlaylist(genre || "pop", maxResults, quotaStatus.quotaUsage);
        fallbackUsed = "curated_playlists";
      } catch (curatedError) {
        console.error("Curated playlists failed, trying static database:", curatedError);
        
        try {
          results = await getStaticMusicDatabase(query, genre || "pop", maxResults, quotaStatus.quotaUsage);
          fallbackUsed = "static_database";
        } catch (staticError) {
          console.error("Static database failed, using emergency tracks:", staticError);
          
          await logQuotaEvent(
            'fallback_triggered',
            quotaStatus.quotaUsage.used,
            quotaStatus.quotaUsage.limit,
            'youtube/search',
            `Emergency tracks fallback used for query: "${query}"`,
            'emergency_tracks'
          );
          
          results = EMERGENCY_TRACKS.slice(0, maxResults);
          fallbackUsed = "emergency_tracks";
        }
      }
    }
    
    console.log(`Search completed successfully. Results: ${results.length}, Fallback used: ${fallbackUsed || 'none'}`);
    
    const response = {
      videos: results,
      metadata: {
        query,
        genre: genre || null,
        maxResults,
        actualResults: results.length,
        fallbackUsed,
        cacheHit: false,
        quotaStatus: {
          used: quotaStatus.quotaUsage.used,
          limit: quotaStatus.quotaUsage.limit,
          percentage: Math.round((quotaStatus.quotaUsage.used / quotaStatus.quotaUsage.limit) * 100),
          warningLevel: quotaStatus.warningLevel
        },
        timestamp: new Date().toISOString()
      }
    };
    
    const cacheHeaders = {
      "Cache-Control": "public, max-age=300",
      "ETag": `"${Date.now()}"`,
      "Vary": "Accept-Encoding",
      "X-Cache": "MISS"
    };
    
    return Response.json(response, { 
      status: 200,
      headers: cacheHeaders
    });
    
  } catch (error) {
    console.error("YouTube search endpoint error:", error);
    
    if (error instanceof Error) {
      return Response.json(
        { 
          error: "Search failed", 
          message: error.message,
          timestamp: new Date().toISOString()
        }, 
        { status: 400 }
      );
    }
    
    return Response.json(
      { 
        error: "Internal server error", 
        message: "An unexpected error occurred",
        timestamp: new Date().toISOString()
      }, 
      { status: 500 }
    );
  }
}